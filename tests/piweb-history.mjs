import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, stat, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDiskSession, readDiskEntry, diskReadDiagnostics, diskViewRevision, clearDiskReadIndex } from '../assets/piweb-overlay/history/session-disk-reader.mjs';
import { waitForAgent, notifyAgentAvailable, pendingAgentSubscriptions } from '../assets/piweb-overlay/history/passive-agent-events.mjs';
import { uiMessage } from '../assets/piweb-overlay/history/ui-message.mjs';
const stamp = '2026-01-01T00:00:00.000Z';
const head = { type: 'session', version: 3, id: 'fixture', timestamp: stamp, cwd: 'C:/fixture' };
const msg = (id, parentId, role = 'assistant', content = [{ type: 'text', text: id }]) => ({ type: 'message', id, parentId, timestamp: stamp, message: { role, content, model: 'fixture', provider: 'fixture', timestamp: 1 } });
const jsonl = (rows, ending = '\n') => rows.map(e => JSON.stringify(e)).join(ending) + ending;
async function fixture(t, rows, raw) { const dir = await mkdtemp(join(tmpdir(), 'pi-history-')); t.after(() => rm(dir, { recursive: true, force: true })); const file = join(dir, 'session.jsonl'); await writeFile(file, raw ?? jsonl([head, ...rows])); return file; }

// Each test uses a different file; cache eviction is exercised independently.
test('cold paint seeks the tail, then repeat pages read only indexed ranges', async t => {
  const rows = [msg('bulk', null, 'toolResult', [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }])];
  for (let i = 0; i < 140; i++) rows.push(msg('e' + i, rows.at(-1).id, i % 2 ? 'assistant' : 'user'));
  const file = await fixture(t, rows); const before = await stat(file);
  const first = await openDiskSession(file, { tail: 10 });
  assert.equal(first.metadataPending, true);
  assert.deepEqual(first.getBranch().map(e => e.id), rows.slice(-10).map(e => e.id));
  assert.ok(diskReadDiagnostics(file).ioBytes < 1024 * 1024, 'first paint must not read the 8 MiB tool body');
  assert.equal(diskReadDiagnostics(file).scans, 0, 'a tail read must not start a speculative full scan');
  await openDiskSession(file, { metadata: true, tail: 10 });
  const d1 = diskReadDiagnostics(file);
  const page = await openDiskSession(file, { before: 'e130', tail: 10 });
  const chain = page.getBranch('e130');
  assert.deepEqual(chain.slice(-11, -1).map(e => e.id), rows.slice(121, 131).map(e => e.id));
  const d2 = diskReadDiagnostics(file);
  assert.equal(d2.scans, d1.scans);
  assert.ok(d2.ioBytes - d1.ioBytes < 30_000, 'an old page must not reopen the complete log');
  assert.equal(page.getEntries().find(e => e.id === 'bulk').message.content.length, 0, 'index does not retain tool bodies');
  const after = await stat(file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
});

test('branch pages follow parentId rather than physical last lines, including compaction/meta', async t => {
  const rows = [msg('root', null, 'user'), msg('a', 'root'), msg('b', 'root'), { type: 'compaction', id: 'c', parentId: 'b', timestamp: stamp, summary: 'summary', firstKeptEntryId: 'b', tokensBefore: 4 }, msg('tail', 'c')];
  const file = await fixture(t, rows);
  const v = await openDiskSession(file, { tail: 3 });
  assert.deepEqual(v.getBranch().map(e => e.id), ['b', 'c', 'tail']);
  const old = await openDiskSession(file, { before: 'c', tail: 2 });
  assert.deepEqual(old.getBranch('c').map(e => e.id).slice(-3), ['root', 'b', 'c']);
  assert.equal((await readDiskEntry(file, 'c')).summary, 'summary');
  assert.equal((await openDiskSession(file, { metadata: true, leafId: 'a', tail: 10 })).getBranch('a').map(e => e.id).join(','), 'root,a');
});

test('UTF-8, CRLF, multi-chunk lines and malformed lines preserve offsets', async t => {
  const rows = [msg('wide', null, 'user', [{ type: 'text', text: '测试😀'.repeat(40_000) }]), msg('end', 'wide')];
  const raw = jsonl([head, rows[0]], '\r\n') + 'not-json\r\n' + jsonl([rows[1]], '\r\n');
  const file = await fixture(t, rows, raw);
  const v = await openDiskSession(file, { metadata: true });
  assert.deepEqual(v.getEntries().map(e => e.id), ['wide', 'end']);
  assert.deepEqual((await readDiskEntry(file, 'wide')).message.content, rows[0].message.content);
});

test('append scans only the delta; torn trailing writes are retried without repair', async t => {
  const a = msg('a', null, 'user'); const b = msg('b', 'a'); const c = msg('c', 'b');
  const source = jsonl([head, a]) + JSON.stringify(b).slice(0, 47);
  const file = await fixture(t, [a], source);
  assert.equal((await openDiskSession(file, { metadata: true })).getLeafId(), 'a');
  assert.equal(await readFile(file, 'utf8'), source, 'GET reader never adds a newline');
  const d1 = diskReadDiagnostics(file);
  await appendFile(file, JSON.stringify(b).slice(47) + '\n' + JSON.stringify(c));
  const v = await openDiskSession(file, { metadata: true });
  assert.equal(v.getLeafId(), 'c');
  assert.equal((await readDiskEntry(file, 'c')).id, 'c');
  assert.ok(diskReadDiagnostics(file).ioBytes - d1.ioBytes < 20_000);
  // A complete line without newline is provisional until the writer finishes it.
  await appendFile(file, '\n');
  const done = await openDiskSession(file, { metadata: true });
  assert.deepEqual(done.getEntries().map(e => e.id), ['a', 'b', 'c']);
});

test('truncate and replacement invalidate stale offsets, revisions and metadata', async t => {
  const file = await fixture(t, [msg('a', null), msg('b', 'a')]);
  await openDiskSession(file, { metadata: true }); const revision = await diskViewRevision(file);
  await writeFile(file, jsonl([head, msg('z', null)]));
  assert.equal((await openDiskSession(file, { metadata: true })).getLeafId(), 'z');
  assert.equal(await readDiskEntry(file, 'b'), null);
  assert.notEqual(await diskViewRevision(file), revision);
  const next = file + '.new'; await writeFile(next, jsonl([head, msg('replacement', null)])); await rename(next, file);
  assert.equal((await openDiskSession(file, { metadata: true })).getLeafId(), 'replacement');
});

test('concurrent metadata readers share one cooperative scan', async t => {
  const file = await fixture(t, Array.from({ length: 50 }, (_, i) => msg('e' + i, i ? 'e' + (i - 1) : null)));
  const readers = await Promise.all(Array.from({ length: 8 }, () => openDiskSession(file, { metadata: true })));
  assert.equal(diskReadDiagnostics(file).scans, 1);
  assert.ok(readers.every(r => r.getEntries().length === 50));
});

test('legacy linear sessions migrate only in memory with stable ids', async t => {
  const oldHead = { ...head, version: 1 };
  const rows = [msg(undefined, undefined, 'user'), msg(undefined, undefined), { type: 'compaction', timestamp: stamp, firstKeptEntryIndex: 1, summary: 'legacy' }];
  const file = await fixture(t, [], jsonl([oldHead, ...rows])); const bytes = await readFile(file);
  const a = await openDiskSession(file, { metadata: true }); const ids = a.getEntries().map(e => e.id);
  assert.equal(a.getEntries()[1].parentId, ids[0]);
  assert.equal(a.getEntries()[2].firstKeptEntryId, ids[0]);
  clearDiskReadIndex();
  const b = await openDiskSession(file, { metadata: true }); assert.deepEqual(b.getEntries().map(e => e.id), ids);
  assert.deepEqual(await readFile(file), bytes);
});

test('display DTO strips signatures without changing provider inputs or tool arguments', () => {
  const message = { role: 'assistant', model: 'fixture', provider: 'fixture', responseId: 'private', content: [
    { type: 'thinking', thinking: 'visible reasoning', thinkingSignature: 'x'.repeat(100_000) },
    { type: 'text', text: 'visible text', textSignature: 'private' },
    { type: 'toolCall', id: 'call', name: 'write', arguments: { content: 'thinkingSignature is literal user data' } },
  ] };
  const raw = JSON.stringify(message); const dto = uiMessage(message);
  assert.equal(JSON.stringify(message), raw); assert.equal(dto.content[0].thinking, 'visible reasoning');
  assert.equal(dto.content[1].text, 'visible text'); assert.equal(dto.content[2].toolCallId, 'call');
  assert.equal(dto.content[2].input.content, message.content[2].arguments.content);
  assert.equal(dto.responseId, undefined); assert.equal(dto.content[0].thinkingSignature, undefined);
  assert.ok(JSON.stringify(dto).length < 1000);
});

test('passive subscription never initializes an agent and attaches before prompt continuation', async () => {
  const controller = new AbortController(); const order = []; let agent;
  const waiting = waitForAgent('passive-fixture', () => agent, controller.signal);
  assert.equal(pendingAgentSubscriptions(), 1);
  waiting.promise.then(() => order.push('subscribed'));
  // Mirrors registration within startRpcSession, before its caller can send a prompt.
  const start = async () => { agent = { sessionId: 'passive-fixture', isAlive: () => true }; notifyAgentAvailable(agent); return agent; };
  await start(); order.push('prompt');
  assert.deepEqual(order, ['subscribed', 'prompt']); assert.equal(pendingAgentSubscriptions(), 0);
  assert.equal(await waiting.promise, agent);
});

test('hinted entry reads survive process/cache boundaries and reject forged fragments', async t => {
  const entry = msg('target', null, 'user', 'full text');
  const nested = { type: 'custom', id: 'outer', parentId: 'target', timestamp: stamp, data: { type: 'message', id: 'nested', message: { role: 'user', content: 'not an entry' } } };
  const file = await fixture(t, [entry, nested]);
  const view = await openDiskSession(file, { tail: 50 });
  const loaded = view.getEntries().find(e => e.id === 'target');
  const location = loaded[Symbol.for('pi-web.entry-location')]; assert.ok(location);
  const hints = new URLSearchParams({ offset: String(location.start), length: String(location.length) });
  clearDiskReadIndex();
  assert.equal((await readDiskEntry(file, 'target', hints)).message.content, 'full text');
  assert.equal(diskReadDiagnostics(file), null);
  const bytes = await readFile(file); const fragment = Buffer.from(JSON.stringify(nested.data)); const at = bytes.indexOf(fragment);
  assert.ok(at > 0);
  assert.equal(await readDiskEntry(file, 'nested', new URLSearchParams({ offset: String(at), length: String(fragment.length) })), null);
  assert.equal(await readDiskEntry(file, 'target', new URLSearchParams({ offset: '0', length: '9999999999999' })), null);
});

test('proxy validates cached ETags without transferring the cached body', async () => {
  const { PiWebUiProxy } = await import('../src/piweb-ui-proxy.mjs');
  let status, ended = false, transmitted = false;
  const proxy = { runningForRead: async () => new Set(), sessionReads: { read: async () => ({ status: 200, headers: { etag: '"revision"' }, body: Buffer.alloc(1000), source: 'memory' }) }, sendBuffer: () => { transmitted = true; } };
  await PiWebUiProxy.prototype.handleSessionRead.call(proxy, { headers: { 'if-none-match': '"revision"' } }, { destroyed: false, writeHead(code) { status = code; }, end() { ended = true; } }, new URL('http://local/api/sessions/fixture?view=chat'), { route: 'detail', encodedId: 'fixture' });
  assert.equal(status, 304); assert.equal(ended, true); assert.equal(transmitted, false);
});

test('passive cancellation and already-live subscriptions do not leak waiters', async () => {
  const controller = new AbortController(); const waiting = waitForAgent('cancelled', () => null, controller.signal);
  const failure = assert.rejects(waiting.promise, { name: 'AbortError' }); waiting.cancel(); await failure;
  assert.equal(pendingAgentSubscriptions(), 0);
  const live = { sessionId: 'live', isAlive: () => true };
  const attached = waitForAgent('live', () => live, controller.signal); assert.equal(await attached.promise, live);
  assert.equal(pendingAgentSubscriptions(), 0);
});
