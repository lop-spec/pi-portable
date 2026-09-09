import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  parseArgs, monthsAgo, dateFloor, filterRecent, parseRpc, createSearch, runCli, resolveWechatScript,
} from '../tools/websearch.mjs';

const now = new Date(2026, 8, 9, 23, 0, 0);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('calendar windows clamp month ends and leap years, not fixed day counts', () => {
  assert.equal(monthsAgo(3, now), '2026-06-09');
  assert.equal(monthsAgo(12, now), '2025-09-09');
  assert.equal(monthsAgo(3, new Date(2026, 4, 31)), '2026-02-28');
  assert.equal(monthsAgo(12, new Date(2024, 1, 29)), '2023-02-28');
  assert.throws(() => dateFloor('2026-02-30'), /invalid date/);
});

test('date filtering excludes old, unknown, and future records; includes boundary', () => {
  const lower = dateFloor(monthsAgo(3, now));
  const data = [lower - 1, lower, now.getTime(), now.getTime() + 1, NaN].map(time => ({ time }));
  assert.deepEqual(filterRecent(data, row => row.time, lower, now).map(row => row.time), [lower, now.getTime()]);
});

test('portable home relocation does not hide the WeChat script', () => {
  const native = path.join('native-user', '.claude', 'skills', 'wechat-search', 'search.mjs');
  assert.equal(resolveWechatScript({ agentDir: 'portable-agent', userHome: 'native-user', exists: p => p === native }), native);
  assert.throws(() => resolveWechatScript({ agentDir: 'missing', userHome: 'missing', exists: () => false }), /script missing/);
});

test('CLI help executes through the actual portable tools junction', () => {
  const modulePath = process.env.PI_PORTABLE_HOME ? path.join(process.env.PI_PORTABLE_HOME, 'tools', 'websearch.mjs') : fileURLToPath(new URL('../tools/websearch.mjs', import.meta.url));
  const text = execFileSync(process.execPath, [modulePath, 'help'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.match(text, /websearch search/);
  assert.match(text, /Parallel\/Exa/);
});

test('CLI is explicit, bounded and cannot invoke research or select paid credentials', () => {
  assert.equal(parseArgs(['search', 'test']).provider, 'tavily');
  assert.equal(parseArgs(['search', '--provider', 'exa', 'test', '--n', '2']).n, 2);
  for (const args of [['research', 'test'], ['search', 'x', '--provider', 'paid'], ['search', 'x', '--api-key', 'secret'], ['search', 'x', '--n', '0'], ['github', 'x', '--since', '2000-01-01'], ['search', 'x', '--full', '1']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('MCP JSON and SSE decoding selects the requested id and exposes errors', () => {
  assert.equal(parseRpc('{"id":2,"result":{"value":1}}', 2).value, 1);
  const sse = 'event: message\ndata: {"method":"notifications/message"}\n\nevent: message\ndata: {"id":2,\ndata: "result":{"value":3}}\n\n';
  assert.equal(parseRpc(sse, 2).value, 3);
  assert.throws(() => parseRpc('{"id":2,"error":{"code":-1,"message":"limited"}}', 2), /limited/);
  assert.throws(() => parseRpc('{"id":1,"result":{}}', 2), /missing MCP response/);
});

test('Tavily uses keyless mode, no answer generation and no account key', async () => {
  let seen;
  const api = createSearch({ now, fetchImpl: async (url, init) => {
    seen = { url, ...init, body: JSON.parse(init.body) };
    return json({ results: [{ title: 'Example', url: 'https://example.com', content: 'source' }] });
  } });
  const result = await api.execute(parseArgs(['search', 'question', '--n', '2']));
  assert.equal(result.results.length, 1);
  assert.equal(seen.headers['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(seen.body.api_key, undefined);
  assert.equal(seen.body.include_answer, false);
  assert.equal(seen.body.max_results, 2);
});

for (const provider of ['parallel', 'exa']) {
  test(`${provider} MCP handshake, notification and search only; no model delegation`, async () => {
    const calls = [];
    const api = createSearch({ now, fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body });
      if (body.method === 'initialize') return json({ id: 1, result: { protocolVersion: '2025-03-26' } }, 200, { 'mcp-session-id': 'test-session' });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response('data: ' + JSON.stringify({ id: 2, result: { content: [{ type: 'text', text: 'https://example.com useful source' }] } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const out = await api.execute(parseArgs(['search', 'search topic', '--provider', provider]));
    assert.match(out.text, /useful source/);
    assert.deepEqual(calls.map(c => c.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
    assert.equal(calls[2].body.params.name, provider === 'parallel' ? 'web_search' : 'web_search_exa');
    assert.equal(calls[2].headers['mcp-session-id'], 'test-session');
    assert.ok(calls.every(c => !c.headers.Authorization));
  });
}

test('MCP text limits are reported, not hidden truncation', async () => {
  const api = createSearch({ now, log: () => {}, fetchImpl: async (_, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return json({ id: 1, result: { protocolVersion: '2025-03-26' } });
    if (!b.id) return new Response(null, { status: 202 });
    return json({ id: 2, result: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } });
  } });
  const out = await api.execute(parseArgs(['search', 'q', '--provider', 'exa', '--max-chars', '1000']));
  assert.equal(out.truncated, true);
  assert.equal(out.original_chars, 2000);
  assert.equal(out.text.length, 1000);
});

test('GitHub adds one-year pushed qualifier and independently validates pushed_at', async () => {
  let url;
  const api = createSearch({ now, log: () => {}, fetchImpl: async u => {
    url = new URL(u);
    return json({ total_count: 3, items: [
      { full_name: 'active/repo', html_url: 'https://github.com/active/repo', pushed_at: '2026-09-08T12:00:00Z' },
      { full_name: 'old/repo', pushed_at: '2020-01-01T00:00:00Z' },
      { full_name: 'unknown/repo' },
    ] });
  } });
  const out = await api.execute(parseArgs(['github', 'mcp search']));
  assert.match(url.searchParams.get('q'), /pushed:>=2025-09-09/);
  assert.deepEqual(out.results.map(x => x.name), ['active/repo']);
});

test('WeChat uses existing script, hidden process and mandatory 3-month filter', async () => {
  let child;
  const lower = dateFloor('2026-06-09');
  const api = createSearch({ now, log: () => {}, wechatScript: 'existing-search.mjs', execImpl: async (file, args, options) => {
    child = { file, args, options };
    return { stderr: '', stdout: JSON.stringify({ pages: 3, results: [
      { title: 'valid', ts: lower / 1000, url: 'https://mp.weixin.qq.com/s/example' },
      { title: 'old', ts: (lower - 1) / 1000 }, { title: 'unknown', ts: 0 },
      { title: 'future', ts: now.getTime() / 1000 + 100 },
    ] }) };
  } });
  const out = await api.execute(parseArgs(['wechat', 'topic', '--since', '2020-01-01']));
  assert.equal(out.since, '2026-06-09');
  assert.equal(child.args[child.args.indexOf('--since') + 1], '2026-06-09');
  assert.equal(child.args[child.args.indexOf('--sort') + 1], 'time');
  assert.equal(child.options.windowsHide, true);
  assert.deepEqual(out.results.map(x => x.title), ['valid']);
});

test('empty and partial results always have reason logs', async () => {
  const logs = [];
  const api = createSearch({ now, log: s => logs.push(s), fetchImpl: async () => json({ results: [], failed_results: [{ url: 'https://example.com', error: 'blocked' }] }) });
  await assert.rejects(api.execute(parseArgs(['fetch', 'https://example.com'])), /no pages extracted/);
  assert.ok(logs.some(s => s.includes('blocked')));
  await api.execute(parseArgs(['search', 'q']));
  assert.ok(logs.some(s => s.includes('no results')));
});

test('request failures return nonzero and a reason, never silently change providers', async () => {
  const stdout = [], stderr = []; let calls = 0;
  const code = await runCli(['search', 'q'], {
    now, out: s => stdout.push(s), log: s => stderr.push(s),
    fetchImpl: async () => { calls++; return json({ detail: 'rate limited' }, 429); },
  });
  assert.equal(code, 1); assert.equal(calls, 1);
  assert.equal(JSON.parse(stdout[0]).ok, false);
  assert.ok(stderr.some(s => s.includes('429')));
});

test('fetch never accepts credential-bearing URLs', async () => {
  const api = createSearch({ now, fetchImpl: async () => assert.fail('must not send URL') });
  await assert.rejects(api.execute(parseArgs(['fetch', 'https://user:password@example.com/'])), /public HTTP/);
});
