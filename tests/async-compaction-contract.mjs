// Acceptance contract: run with the actual Pi runtime; no provider requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const host = process.env.PI_TEST_HOST;
const candidate = process.env.PI_ASYNC_TEST_DIR;
assert.ok(host && candidate, 'PI_TEST_HOST and PI_ASYNC_TEST_DIR required');
const require = createRequire(path.join(host, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai': path.join(host, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
} });
const mod = await jiti.import(path.join(candidate, 'index.ts'));
const { loadExtensions } = await import(pathToFileURL(path.join(host, 'dist/core/extensions/loader.js')));
const loaded = await loadExtensions([path.join(candidate, 'index.ts')], process.cwd());
assert.deepEqual(loaded.errors, [], 'real host must load the extension');
assert.equal(loaded.extensions.length, 1);
assert.deepEqual(mod.readConfig(), { enabled: true, startTokens: 128000, thinkingLevel: 'low', timeoutMs: 300000, firstToolCompaction: true });
assert.equal(mod.startBlocker({ tokens: 127999, contextWindow: 1000000 }, { reserveTokens: 144000 }, mod.readConfig()), 'below_threshold');
assert.equal(mod.startBlocker({ tokens: 128000, contextWindow: 1000000 }, { reserveTokens: 144000 }, mod.readConfig()), undefined);
assert.equal(mod.startBlocker({ tokens: 900000, contextWindow: 1000000 }, { reserveTokens: 144000 }, mod.readConfig()), 'above_force_threshold');
assert.equal(mod.startBlocker({ tokens: null, contextWindow: 1000000 }, { reserveTokens: 144000 }, mod.readConfig()), 'context_unknown');
assert.throws(() => mod.parseConfig({ enabled: true, startTokens: 0, thinkingLevel: 'low', timeoutMs: 300000 }));
assert.throws(() => mod.parseConfig({ enabled: true, startTokens: 128000, thinkingLevel: 'off', timeoutMs: 300000 }));
const entries = [
  { id: 'done', type: 'message', message: { role: 'user', content: 'old' } },
  { id: 'inflight', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: 'read', arguments: {} }] } },
];
assert.deepEqual(mod.completedPrefix(entries, 'call1'), entries.slice(0, 1));
assert.throws(() => mod.completedPrefix(entries, 'missing'));
console.log('PASS: actual host loading, independent inclusive 128K, invalid-config rejection, completed-prefix isolation');
const { createHash } = await import('node:crypto');
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'upstream-integrity.json'), 'utf8'));
for (const [file, hash] of Object.entries(manifest.sha256)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(candidate, 'upstream', file))).digest('hex'), hash, `upstream unchanged: ${file}`);
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const piAI = await import(pathToFileURL(path.join(host, 'node_modules/@earendil-works/pi-ai/dist/compat.js')));
const model = { ...piAI.getModel('openai', 'gpt-5'), contextWindow: 1000000 };
assert.ok(model.id && piAI.getSupportedThinkingLevels(model).includes('low'));
const tick = () => new Promise(r => setTimeout(r, 10));
const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw Error(`Timeout: ${label}`); };
const config = mod.readConfig();
function fixture({ tokens = 2000, claimed = false, empty = false, idle = false, queued = false, build, configOverride = {}, persistedEntries } = {}) {
  let serial = 0;
  const branch = persistedEntries ? [...persistedEntries] : [];
  const add = data => { const entry = { ...data, id: String(++serial).padStart(8, '0'), parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() }; branch.push(entry); return entry; };
  if (persistedEntries) serial = 10000;
  const message = (role, content) => add({ type: 'message', message: { role, content, timestamp: Date.now(), ...(role === 'assistant' ? { api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) } });
  if (!persistedEntries) {
    add({ type: 'thinking_level_change', thinkingLevel: 'xhigh' });
    if (!empty) for (let n = 0; n < 8; n++) { message('user', `Request ${n}. ` + 'Completed historical context. '.repeat(60)); message('assistant', [{ type: 'text', text: `Finished ${n}. ` + 'Preserve confirmed results. '.repeat(40) }]); }
    message('user', 'Execute current work.');
    if (claimed) add({ type: 'custom', customType: mod.FIRST_JOB_MARKER, data: {} });
  }
  let call = 0;
  function nextTool() { const id = `tool-${++call}-${serial}`; message('assistant', [{ type: 'toolCall', id, name: 'fixture', arguments: {} }]); return { toolCallId: id, toolName: 'fixture', args: {} }; }
  const currentTool = nextTool();
  const handlers = new Map(), logs = [], requests = [], sent = [], errors = [];
  let aborts = 0, compacts = 0, synchronousFallbacks = 0, resolveBuild;
  const pendingBuild = new Promise(r => { resolveBuild = r; });
  const settings = { enabled: true, reserveTokens: 4096, keepRecentTokens: 128 };
  const ctx = {
    cwd: process.cwd(), model, hasUI: false, isProjectTrusted: () => false,
    isIdle: () => idle, hasPendingMessages: () => queued,
    signal: new AbortController().signal,
    getContextUsage: () => ({ tokens, contextWindow: model.contextWindow }),
    sessionManager: { getSessionId: () => 'fixture-session', getEntries: () => [...branch], getBranch: () => [...branch] },
    abort: () => { aborts++; idle = true; },
    compact: ({ onError }) => { compacts++; void (async () => {
      const result = await emit('session_before_compact', { preparation: { settings }, branchEntries: [...branch], reason: 'manual', signal: new AbortController().signal });
      if (!result?.compaction) { synchronousFallbacks++; return; }
      const c = result.compaction;
      const entry = add({ type: 'compaction', ...c, fromHook: true });
      await emit('session_compact', { compactionEntry: entry, fromExtension: true, reason: 'manual' });
    })().catch(e => { errors.push(e); onError(e); }); },
  };
  const pi = { on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, registerCommand: () => {}, appendEntry: (customType, data) => add({ type: 'custom', customType, data }), sendUserMessage: text => sent.push(text) };
  async function emit(name, event = {}) { for (const fn of handlers.get(name) ?? []) { const result = await fn(event, ctx); if (result !== undefined) return result; } }
  const builder = async (prep, m, c, level, signal) => {
    requests.push({ prep, model: m, level, signal });
    if (build) return build(prep, m, c, level, signal);
    await pendingBuild;
    return { summary: 'Verified historical summary.', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, details: {} };
  };
  mod.install(pi, { config: { ...config, ...configOverride }, log: e => logs.push(e), build: builder, settings: () => settings });
  return { branch, currentTool, ctx, handlers, logs, requests, sent, errors, emit, nextTool, message, add, finish: () => resolveBuild(), setTokens: n => { tokens = n; }, setIdle: x => { idle = x; }, setQueued: x => { queued = x; }, metrics: () => ({ aborts, compacts, synchronousFallbacks }) };
}
{
  const f = fixture();
  assert.equal(f.handlers.has('turn_end'), false);
  await f.emit('turn_end'); assert.equal(f.requests.length, 0);
  await f.emit('tool_execution_start', f.currentTool); assert.equal(f.requests.length, 1, 'first tool bypasses waterline');
  assert.equal(f.requests[0].model, model); assert.equal(f.requests[0].level, 'low');
  assert.equal(f.branch.find(e => e.type === 'thinking_level_change').thinkingLevel, 'xhigh');
  assert.ok(!JSON.stringify(f.requests[0].prep).includes(f.currentTool.toolCallId), 'in-flight call is excluded from summary input');
  await f.emit('tool_execution_start', f.currentTool); assert.equal(f.requests.length, 1, 'one job while pending');
  const newUser = f.message('user', 'NEW_MESSAGE_MUST_SURVIVE');
  f.finish(); await until(() => f.logs.some(e => e.event === 'ready'), 'ready');
  assert.equal(f.metrics().aborts, 0, 'below 128K, native apply waits for idle');
  f.setIdle(true); await f.emit('agent_settled'); await until(() => f.logs.some(e => e.event === 'persisted'), 'persisted');
  const rebuilt = sdk.buildSessionContext(f.branch).messages;
  assert.ok(JSON.stringify(rebuilt).includes('NEW_MESSAGE_MUST_SURVIVE'));
  assert.ok(JSON.stringify(rebuilt).includes(f.currentTool.toolCallId));
  assert.equal(f.branch.filter(e => e.type === 'compaction').length, 1);
  assert.equal(f.branch.find(e => e.type === 'compaction').usage.totalTokens, 10);
  assert.equal(f.sent.length, 0); assert.equal(f.errors.length, 0);
  const fresh = fixture({ persistedEntries: f.branch, tokens: 5000 });
  await fresh.emit('tool_execution_start', fresh.currentTool); assert.equal(fresh.requests.length, 0, 'reload must not repeat first job');
  console.log('PASS: first-tool below 128K, low/main model isolation, single job, native idle apply, new tail retained, usage, reload marker');
}
{
  const f = fixture({ claimed: true, tokens: 127999 });
  await f.emit('tool_execution_start', f.currentTool); assert.equal(f.requests.length, 0);
  f.setTokens(128000); await f.emit('tool_execution_start', f.currentTool); assert.equal(f.requests.length, 1);
  f.finish(); await until(() => f.sent.length === 1, 'native continue');
  assert.deepEqual(f.metrics(), { aborts: 1, compacts: 1, synchronousFallbacks: 0 });
  assert.deepEqual(f.sent, ['continue']); assert.equal(f.errors.length, 0);
  console.log('PASS: exact 128000 threshold, upstream abort/compact/persist/continue exactly once');
}
{
  const f = fixture({ empty: true });
  await f.emit('tool_execution_start', f.currentTool); assert.equal(f.requests.length, 0); assert.ok(f.logs.some(e => e.reason === 'nothing_to_compact'));
  assert.ok(!f.branch.some(e => e.customType === mod.FIRST_JOB_MARKER));
  for (let i = 0; i < 4; i++) { f.message('user', 'Completed content '.repeat(200)); f.message('assistant', [{ type: 'text', text: 'Done '.repeat(100) }]); }
  await f.emit('tool_execution_start', f.nextTool()); assert.equal(f.requests.length, 1, 'first job stays armed until history exists');
  await f.emit('session_shutdown'); assert.equal(f.requests[0].signal.aborted, true); f.finish(); await tick();
  console.log('PASS: no empty request/marker, deferred first job, shutdown cancellation');
}
for (const scenario of ['model_select', 'thinking_level_select', 'session_tree', 'session_shutdown']) {
  const f = fixture({ tokens: 128000 }); await f.emit('tool_execution_start', f.currentTool);
  await f.emit(scenario); f.finish(); await tick();
  assert.equal(f.requests[0].signal.aborted, true, scenario); assert.equal(f.metrics().compacts, 0);
}
{
  const f = fixture({ tokens: 128000, queued: true }); await f.emit('tool_execution_start', f.currentTool); f.finish(); await tick();
  assert.equal(f.metrics().compacts, 0); f.setQueued(false); f.setIdle(true); await f.emit('agent_settled'); await tick();
  assert.equal(f.metrics().compacts, 1); assert.equal(f.metrics().aborts, 0);
}
{
  const f = fixture({ tokens: 128000 }); await f.emit('tool_execution_start', f.currentTool);
  const result = await f.emit('session_before_compact', { preparation: { settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 128 } }, reason: 'threshold' });
  assert.equal(result, undefined); assert.equal(f.requests[0].signal.aborted, true); f.finish(); await tick();
  assert.ok(f.logs.some(e => e.event === 'native-fallback')); assert.equal(f.metrics().compacts, 0);
}
{
  const f = fixture({ tokens: 128000, configOverride: { timeoutMs: 20 } }); await f.emit('tool_execution_start', f.currentTool);
  await until(() => f.requests[0].signal.aborted, 'timeout'); f.finish(); await tick();
  assert.ok(f.logs.some(e => e.event === 'invalidated' && e.reason === 'timeout')); assert.equal(f.metrics().compacts, 0);
}
{
  const f = fixture({ build: async () => { throw Error('fixture provider failure'); } }); await f.emit('tool_execution_start', f.currentTool); await tick();
  assert.ok(f.logs.some(e => e.event === 'failed')); assert.equal(f.metrics().compacts, 0);
}
console.log('PASS: model/thinking/tree/shutdown invalidation, queue protection, native fallback, timeout, failure logging; upstream hashes unchanged');
