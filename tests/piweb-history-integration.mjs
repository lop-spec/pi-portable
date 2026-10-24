import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const source = resolve(process.env.PIWEB_SOURCE || 'upstream');
const require = createRequire(join(source, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(join(source, 'package.json'), { alias: { '@': source } });
const reader = await jiti.import(join(source, 'lib/session-reader.ts'));
const { computeSessionStats } = await jiti.import(join(source, 'lib/session-stats.ts'));
const { computeSessionTotalActiveMs } = await jiti.import(join(source, 'lib/session-timing.ts'));
const detail = await jiti.import(join(source, 'app/api/sessions/[id]/route.ts'));
const contextRoute = await jiti.import(join(source, 'app/api/sessions/[id]/context/route.ts'));
const entryRoute = await jiti.import(join(source, 'app/api/sessions/[id]/entries/[entryId]/route.ts'));
const eventsRoute = await jiti.import(join(source, 'app/api/agent/[id]/events/route.ts'));
const { getRpcSession } = await jiti.import(join(source, 'lib/rpc-manager.ts'));
const { notifyAgentAvailable, pendingAgentSubscriptions } = await jiti.import(join(source, 'lib/passive-agent-events.mjs'));
const { SessionManager } = await jiti.import('@earendil-works/pi-coding-agent');
const timestamp = '2026-01-01T00:00:00.000Z';
const message = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, timestamp, message: { role, content, provider: 'fixture', model: 'fixture', timestamp: 1, ...extra } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-history-route-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = randomUUID(), file = join(dir, id + '.jsonl');
  const rows = [
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'fixture', modelId: 'fixture' },
    { type: 'thinking_level_change', id: 'level', parentId: 'model', timestamp, thinkingLevel: 'high' },
    message('q', 'level', 'user', [{ type: 'text', text: 'Question' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }]),
    message('call', 'q', 'assistant', [
      { type: 'thinking', thinking: 'reasoning '.repeat(1000), thinkingSignature: 'encrypted'.repeat(1000) },
      { type: 'toolCall', id: 'tool', name: 'write', arguments: { path: 'file.txt', content: 'payload'.repeat(1000) } },
    ], { stopReason: 'toolUse', usage: { input: 5, output: 3, cost: { total: 1 } } }),
    message('result', 'call', 'toolResult', [{ type: 'text', text: 'output'.repeat(1000) }], { toolCallId: 'tool', toolName: 'write', isError: false, details: { diff: 'diff'.repeat(1000) } }),
    message('answer', 'result', 'assistant', [{ type: 'text', text: 'Answer', textSignature: 'private' }], { stopReason: 'stop' }),
    { type: 'context_edit', id: 'edit', parentId: 'answer', timestamp, targetId: 'result', replacement: null },
  ];
  await writeFile(file, [{ type: 'session', version: 3, id, cwd: dir, timestamp }, ...rows].map(e => JSON.stringify(e)).join('\n') + '\n');
  reader.cacheSessionPath(id, file);
  return { id, file, rows, url: `http://localhost/api/sessions/${id}` };
}
const params = id => ({ params: Promise.resolve({ id }) });
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'entryQuery' ? '' : semantic(v)]));
  if (typeof value === 'string' && value.startsWith('/api/')) { const u = new URL(value, 'http://localhost'); u.searchParams.delete('offset'); u.searchParams.delete('length'); return u.pathname + u.search; }
  return value;
}

test('real chat routes use read-only seek pages, exact totals/settings and conditional snapshots', async t => {
  const f = await fixture(t); const before = await stat(f.file); const original = await readFile(f.file);
  const savedOpen = SessionManager.open;
  SessionManager.open = () => { throw new Error('UI MUST NOT OPEN SDK SESSION'); };
  try {
    const first = await detail.GET(new Request(f.url + '?view=chat&deferThinking=1&deferMedia=1&tree=summary'), params(f.id));
    assert.equal(first.status, 200); const initial = await first.json();
    assert.equal(initial.metadataPending, true); assert.ok(initial.context.messages.length > 0);
    const complete = await detail.GET(new Request(f.url + '?view=chat&deferThinking=1&deferMedia=1&tree=summary&metadata=1'), params(f.id));
    assert.equal(complete.status, 200); const body = await complete.json();
    const expected = reader.buildSessionContext(f.rows, 'edit', { tail: 50, view: 'chat', deferThinking: true, deferToolResultImages: true, sessionId: f.id, cwd: (await import('node:path')).dirname(f.file) });
    assert.deepEqual(semantic(body.context), semantic(expected));
    assert.deepEqual(body.stats, computeSessionStats(f.rows)); assert.equal(body.totalActiveMs, computeSessionTotalActiveMs(f.rows));
    assert.equal(body.context.thinkingLevel, 'high'); assert.equal(body.context.model.modelId, 'fixture');
    assert.ok(!JSON.stringify(body).includes('thinkingSignature')); assert.ok(!JSON.stringify(body).includes('textSignature'));
    const call = body.context.messages.find(m => m.role === 'assistant').content.find(b => b.type === 'toolCall');
    assert.equal(new URL(call.chatView.entryUrl, 'http://localhost').pathname, `/api/sessions/${f.id}/entries/call`);
    assert.ok(new URL(call.chatView.entryUrl, 'http://localhost').searchParams.has('offset'));
    const result = body.context.messages.find(m => m.role === 'toolResult'); assert.equal(result.content[0].text.length, 200); assert.equal(result.details, undefined);
    const disk = await jiti.import(join(source, 'lib/session-disk-reader.mjs'));
    disk.clearDiskReadIndex(); // mimic an expansion handled by a different process
    const full = await entryRoute.GET(new Request('http://localhost' + result.chatView.entryUrl), { params: Promise.resolve({ id: f.id, entryId: 'result' }) });
    assert.equal((await full.json()).message.content[0].text.length, 6000);
    assert.equal(disk.diskReadDiagnostics(f.file), null, 'entry hint must not rebuild an index in the second process');
    const fullCall = await entryRoute.GET(new Request('http://localhost' + call.chatView.entryUrl), { params: Promise.resolve({ id: f.id, entryId: 'call' }) });
    assert.equal((await fullCall.json()).message.content[1].input.content.length, 7000);
    const page = await contextRoute.GET(new Request(f.url + '/context?view=chat&before=answer&tail=1'), params(f.id));
    assert.deepEqual((await page.json()).context.entryIds, ['call', 'result']);
    const validated = await detail.GET(new Request(f.url + '?view=chat&tree=summary', { headers: { 'If-None-Match': complete.headers.get('etag') } }), params(f.id));
    assert.equal(validated.status, 304); assert.equal(await validated.text(), '');
    assert.equal(getRpcSession(f.id), undefined);
  } finally { SessionManager.open = savedOpen; }
  assert.deepEqual(await readFile(f.file), original); assert.equal((await stat(f.file)).mtimeMs, before.mtimeMs);
});

test('media and reasoning endpoints seek the requested entry and preserve full content', async t => {
  const f = await fixture(t);
  const thinking = await jiti.import(join(source, 'app/api/sessions/[id]/entries/[entryId]/thinking/route.ts'));
  const image = await jiti.import(join(source, 'app/api/sessions/[id]/entries/[entryId]/tool-result-image/route.ts'));
  const saved = SessionManager.open; SessionManager.open = () => { throw new Error('No SDK reads'); };
  try {
    const r = await thinking.GET(new Request(f.url + '/entries/call/thinking?blockIndex=0'), { params: Promise.resolve({ id: f.id, entryId: 'call' }) });
    assert.equal((await r.json()).thinking.length, 10000);
    const im = await image.GET(new Request(f.url + '/entries/q/tool-result-image?blockIndex=1'), { params: Promise.resolve({ id: f.id, entryId: 'q' }) });
    assert.equal(im.status, 200); assert.equal(Buffer.from(await im.arrayBuffer()).toString(), 'hi');
  } finally { SessionManager.open = saved; }
});

test('real SSE route is ready while dormant, attaches to later explicit start, and cleans up', async t => {
  const f = await fixture(t); const controller = new AbortController(); const original = SessionManager.open;
  SessionManager.open = () => { throw new Error('Passive SSE must not initialize an agent'); };
  let stop = 0, listener;
  try {
    const response = await eventsRoute.GET(new Request(f.url.replace('/sessions/', '/agent/') + '/events', { signal: controller.signal }), params(f.id));
    assert.equal(response.status, 200); const stream = response.body.getReader();
    const idle = new TextDecoder().decode((await stream.read()).value); assert.match(idle, /"idle":true/);
    assert.equal(getRpcSession(f.id), undefined); assert.equal(pendingAgentSubscriptions(), 1);
    notifyAgentAvailable({ sessionId: f.id, isAlive: () => true, isStreaming: false, streamingMessage: null, onEvent(fn) { listener = fn; return () => stop++; } });
    // Transport prelude and the real connected frame may arrive separately.
    let connected = ''; while (!connected.includes('"connected"')) connected += new TextDecoder().decode((await stream.read()).value);
    assert.ok(listener);
    listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'visible', thinkingSignature: 'private' }] } });
    const event = new TextDecoder().decode((await stream.read()).value); assert.match(event, /visible/); assert.doesNotMatch(event, /thinkingSignature|private/);
    await stream.cancel(); assert.equal(stop, 1); assert.equal(pendingAgentSubscriptions(), 0);
  } finally { controller.abort(); SessionManager.open = original; }
});
