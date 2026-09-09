// Explicit network smoke test, never loaded by node --test websearch.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearch, parseArgs, dateFloor } from '../tools/websearch.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-live-'));
const cases = [];
console.log(`ARTIFACTS ${dir}`);
async function check(name, args, verify) {
  const start = Date.now();
  console.log(`START ${name}`);
  try {
    const api = createSearch({ log: message => console.log(`NOTE ${name}: ${message}`) });
    const result = await api.execute(parseArgs(args));
    verify(result);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(result, null, 2));
    const item = { name, ok: true, ms: Date.now() - start, count: result.count };
    cases.push(item); console.log(`PASS ${name} ${item.ms}ms`);
  } catch (error) {
    cases.push({ name, ok: false, ms: Date.now() - start, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
const source = 'https://docs.tavily.com/documentation/keyless';
await Promise.all(['tavily', 'parallel', 'exa'].map(async provider => {
  await check(`${provider}-search`, ['search', 'Tavily keyless free search extract official documentation', '--provider', provider, '--max-chars', '20000'], result => {
    assert.match(JSON.stringify(result), /https?:\/\//);
    if (provider === 'tavily') assert.ok(result.results.length > 0);
    else assert.ok(result.text.length > 100);
  });
  await check(`${provider}-fetch`, ['fetch', source, '--provider', provider, '--max-chars', '20000'], result => {
    const text = provider === 'tavily' ? result.results.map(x => x.raw_content || x.content || '').join('\n') : result.text;
    assert.ok(text.length > 100, 'readable source body required');
    assert.match(text, /keyless/i);
  });
}));
await check('github-window', ['github', 'repo:tavily-ai/tavily-mcp'], result => {
  assert.ok(result.count > 0);
  assert.ok(result.results.every(x => Date.parse(x.pushed_at) >= dateFloor(result.since)));
});
await check('wechat-window', ['wechat', '免费 搜索 MCP', '--n', '3', '--timeout-ms', '60000'], result => {
  assert.ok(result.count > 0, 'live query returned no qualifying articles');
  assert.ok(result.results.every(x => x.ts * 1000 >= dateFloor(result.since) && x.ts * 1000 <= Date.now()));
});
const summary = { passed: cases.filter(x => x.ok).length, total: cases.length, cases };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`SUMMARY ${JSON.stringify(summary)}`);
process.exitCode = cases.some(x => !x.ok) ? 1 : 0;
