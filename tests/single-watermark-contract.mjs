// Runs against a disposable patched Pi SDK and staged extension; never calls a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const host = process.env.PI_TEST_HOST, candidate = process.env.PI_ASYNC_TEST_DIR;
assert.ok(host && candidate, 'PI_TEST_HOST and PI_ASYNC_TEST_DIR required');
const imp = p => import(pathToFileURL(path.join(host, p)).href);
const sdk = await imp('dist/index.js');
const { ModelRuntime: SdkModelRuntime } = await imp('dist/core/model-runtime.js');
const { createLlamaProvider } = await imp('dist/extensions/llama/provider.js');
const chunkDir = path.join(host, 'dist/bundle/chunks');
const runtimeChunks = fs.readdirSync(chunkDir).filter(f => f.endsWith('.js') && fs.readFileSync(path.join(chunkDir, f), 'utf8').includes('function shouldCompact2(contextTokens,contextWindow,settings2)'));
assert.equal(runtimeChunks.length, 1);
const cli = await imp(`dist/bundle/chunks/${runtimeChunks[0]}`);
for (const [label, Runtime] of [['SDK', SdkModelRuntime], ['CLI', cli.ModelRuntime]]) {
  const runtime = await Runtime.create({ modelsPath: null, authPath: path.join(os.tmpdir(), 'single-watermark-no-auth.json'), refreshOnCreate: false, allowModelNetwork: false });
  const models = runtime.getModels();
  assert.ok(models.length > 0, `${label} builtin catalog must not be empty`);
  assert.deepEqual(models.filter(m => m.contextWindow !== 0).map(m => `${m.provider}/${m.id}`), [], `${label} unconfigured builtins must also be unknown`);
  assert.equal(runtime.getModel('openai', 'gpt-5').contextWindow, 0);
  let nativeModels = [{ id: 'fixture', provider: 'test-native-provider', contextWindow: 1111, maxTokens: 42 }];
  let refreshes = 0;
  const source = { id: 'test-native-provider', auth: {}, getModels: () => nativeModels,
    refreshModels: async ({ publish }) => { refreshes++; await publish({ update: () => {
      nativeModels = [{ id: 'refreshed', provider: 'test-native-provider', contextWindow: 2222, maxTokens: 84 }];
    } }); } };
  runtime.registerNativeProvider(source);
  assert.equal(runtime.getModel('test-native-provider', 'fixture').contextWindow, 0, `${label} native extension`);
  await runtime.refresh({ providers: ['test-native-provider'], allowNetwork: false });
  assert.ok(refreshes > 0, `${label} dynamic refresh occurred`);
  assert.equal(runtime.getModel('test-native-provider', 'refreshed').contextWindow, 0, `${label} refreshed model`);
  assert.equal(runtime.getModel('test-native-provider', 'refreshed').maxTokens, 84, `${label} output limit retained`);
  const llama = createLlamaProvider();
  llama.setCatalog([{ id: 'unknown-window', status: { value: 'loaded' } }, { id: 'reported-window', status: { value: 'loaded' }, meta: { n_ctx: 32768 } }], 'http://127.0.0.1:8080');
  runtime.registerNativeProvider(llama.provider);
  assert.equal(runtime.getModel('llama.cpp', 'unknown-window').contextWindow, 0, `${label} llama fallback is not a local threshold`);
  assert.equal(runtime.getModel('llama.cpp', 'unknown-window').maxTokens, 128000, `${label} llama native output default retained`);
  assert.equal(runtime.getModel('llama.cpp', 'reported-window').contextWindow, 0, `${label} llama reported window is not a local threshold`);
  assert.equal(runtime.getModel('llama.cpp', 'reported-window').maxTokens, 32768, `${label} llama reported output limit retained`);
  const getProvider = runtime.config.getProvider.bind(runtime.config);
  runtime.config.getProvider = id => id === 'test-native-provider'
    ? { baseUrl: 'https://offline.invalid', api: 'openai-completions', models: [{ id: 'invalid', contextWindow: -1 }] }
    : getProvider(id);
  runtime.recomposeProvider('test-native-provider');
  assert.ok(runtime.compositionErrors.has('test-native-provider'), `${label} composition failure exercised`);
  assert.equal(runtime.getModel('test-native-provider', 'refreshed').contextWindow, 0, `${label} failure fallback`);
}
const ai = await imp('node_modules/@earendil-works/pi-ai/dist/compat.js');
const overflow = await imp('node_modules/@earendil-works/pi-ai/dist/utils/overflow.js');
const { clampMaxTokensToContext } = await imp('node_modules/@earendil-works/pi-ai/dist/api/simple-options.js');
const { composeModelProvider } = await imp('dist/core/provider-composer.js');
const coreCompaction = await imp('node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js');
const { loadExtensions } = await imp('dist/core/extensions/loader.js');
const loaded = await loadExtensions([path.join(candidate, 'index.ts')], process.cwd());
assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
const { createJiti } = createRequire(path.join(host, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai': path.join(host, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
} });
const mod = await jiti.import(path.join(candidate, 'index.ts'));
const config = mod.readConfig(''); assert.equal(config.startTokens, 800000);
assert.equal(mod.startBlocker({ tokens: null }, config), 'context_unknown');
assert.equal(mod.startBlocker({ tokens: 799999, contextWindow: 0 }, config), 'below_threshold');
assert.equal(mod.startBlocker({ tokens: 800000, contextWindow: 0 }, config), undefined);
assert.equal(mod.startBlocker({ tokens: 900000, contextWindow: 272000 }, config), undefined);
for (const invalid of [0, -1, 3.5, null]) assert.throws(() => mod.parseConfig({ ...config, startTokens: invalid }));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-watermark-'));
try {
  fs.writeFileSync(path.join(temp, mod.INSTANCE_CONFIG), JSON.stringify({ startTokens: 5, thinkingLevel: 'max' }));
  assert.equal(mod.readConfig(temp).startTokens, 800000, 'legacy instance cannot set a second watermark');
  assert.equal(mod.readConfig(temp).thinkingLevel, 'max');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
const baseModel = ai.getModel('openai', 'gpt-5'); assert.ok(baseModel);
for (const declared of [272000, 1050000, 2720000]) {
  const base = { auth: {}, getModels: () => [{ ...baseModel, contextWindow: declared }] };
  const models = composeModelProvider('openai', base, { getProvider: () => ({ modelOverrides: { [baseModel.id]: { contextWindow: 1 } } }) }).getModels();
  assert.equal(models[0].contextWindow, 0, 'model windows and overrides are not runtime capacity');
  assert.equal(models[0].maxTokens, baseModel.maxTokens);
}
const model = { ...baseModel, contextWindow: 0, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } };
for (const fn of [sdk.shouldCompact, coreCompaction.shouldCompact, cli.shouldCompact]) {
  assert.equal(fn(900000, 0, { enabled: true, reserveTokens: 144000 }), false);
  assert.equal(fn(128001, 272000, { enabled: true, reserveTokens: 144000 }), true);
}
assert.equal(clampMaxTokensToContext({ ...model, maxTokens: 128000 }, { messages: [] }, 128000), 128000);
const makeMsg = (stopReason, errorMessage, input = 100, output = 10) => ({ role: 'assistant', content: [], api: model.api, model: model.id, provider: model.provider, stopReason, errorMessage, timestamp: Date.now(), usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
assert.equal(overflow.isContextOverflow(makeMsg('error', 'Your input exceeds the context window of this model'), 0), true);
assert.equal(overflow.isContextOverflow(makeMsg('error', 'rate limit: too many tokens'), 0), false);
assert.equal(overflow.isContextOverflow(makeMsg('stop', undefined, 900000), 0), false, 'unknown capacity cannot invent a successful-response overflow');
const sm = sdk.SessionManager.inMemory(process.cwd());
sm.appendMessage({ role: 'user', content: 'question', timestamp: Date.now() }); sm.appendMessage(makeMsg('stop', undefined, 800000, 12));
for (const Version of [sdk, cli]) {
  const usage = Version.AgentSession.prototype.getContextUsage.call({ model, sessionManager: sm });
  assert.equal(usage.contextWindow, 0); assert.equal(usage.percent, null); assert.equal(usage.tokens, 800012);
  const calls = [];
  const session = { model, settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 144000 }) },
    sessionManager: sm, agent: { state: { messages: [] } }, _findPersistedMessageEntryId: () => undefined,
    _runAutoCompaction: async (...args) => { calls.push(['compact', ...args]); return true; },
    _omitRecoveryAttempt: () => calls.push(['omit']), _emit: event => calls.push(['event', event]),
    _emitSessionCompactFailed: async event => calls.push(['failed', event]) };
  const check = msg => Version.AgentSession.prototype._checkCompaction.call(session, msg);
  assert.equal(await check(makeMsg('stop', undefined, 900000)), false);
  assert.equal(await check(makeMsg('length', undefined, 100, 10)), false);
  assert.equal(await check(makeMsg('error', 'Your input exceeds the context window of this model')), true);
  assert.deepEqual(calls.slice(0, 2), [['omit'], ['compact', 'overflow', true]]);
  assert.equal(await check(makeMsg('error', 'Your input exceeds the context window of this model')), false);
  assert.equal(calls.filter(c => c[0] === 'compact').length, 1, 'only one compact-and-retry attempt');
  assert.ok(calls.some(c => c[0] === 'failed'), 'repeat overflow must report failure');
}
console.log('PASS real SDK and CLI bundle: builtin/native/configured registry layers unknown, token statistics, no native watermark or output clamp, bounded explicit-overflow recovery');
const tick = () => new Promise(r => setTimeout(r, 10));
const until = async (fn, label) => { for (let i = 0; i < 150; i++) { if (fn()) return; await tick(); } throw Error(`Timeout: ${label}`); };
function fixture({ tokens = 800000, idle = false, queued = false, build, configOverride = {} } = {}) {
  let serial = 0, aborts = 0, compacts = 0, fallback = 0;
  const branch = [], handlers = new Map(), logs = [], requests = [], sent = [], errors = [];
  const add = entry => { const e = { ...entry, id: String(++serial).padStart(8, '0'), parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() }; branch.push(e); return e; };
  const message = (role, content) => add({ type: 'message', message: { role, content, timestamp: Date.now(), ...(role === 'assistant' ? { ...makeMsg('stop'), content } : {}) } });
  add({ type: 'thinking_level_change', thinkingLevel: 'xhigh' });
  for (let i = 0; i < 8; i++) { message('user', 'Completed context '.repeat(100)); message('assistant', [{ type: 'text', text: 'Verified result '.repeat(100) }]); }
  message('user', 'Perform current work.');
  const tool = { toolCallId: 'call-current', toolName: 'fixture', args: {} };
  message('assistant', [{ type: 'toolCall', id: tool.toolCallId, name: tool.toolName, arguments: {} }]);
  let resolveBuild; const pending = new Promise(r => { resolveBuild = r; });
  const settings = { enabled: true, reserveTokens: 4096, keepRecentTokens: 128 };
  const ctx = {
    cwd: process.cwd(), model, hasUI: false, isProjectTrusted: () => false,
    isIdle: () => idle, hasPendingMessages: () => queued, signal: new AbortController().signal,
    getContextUsage: () => ({ tokens, contextWindow: 0, percent: null }),
    sessionManager: { getSessionId: () => 'test', getEntries: () => [...branch], getBranch: () => [...branch] },
    abort: () => { aborts++; idle = true; },
    compact: ({ onError }) => { compacts++; void (async () => {
      const result = await emit('session_before_compact', { preparation: { settings }, branchEntries: [...branch], reason: 'manual', signal: new AbortController().signal });
      if (!result?.compaction) { fallback++; return; }
      const entry = add({ type: 'compaction', ...result.compaction, fromHook: true });
      await emit('session_compact', { compactionEntry: entry, fromExtension: true, reason: 'manual' });
    })().catch(e => { errors.push(e); onError(e); }); },
  };
  const pi = { on: (n, fn) => { const a = handlers.get(n) ?? []; a.push(fn); handlers.set(n, a); }, registerCommand: () => {}, appendEntry: (customType, data) => add({ type: 'custom', customType, data }), sendUserMessage: text => sent.push(text) };
  async function emit(name, event = {}) { for (const fn of handlers.get(name) ?? []) { const r = await fn(event, ctx); if (r !== undefined) return r; } }
  const builder = async (prep, m, c, level, signal, compactFn) => {
    assert.equal(compactFn, mod.compactWithInstructions); requests.push({ prep, m, level, signal });
    if (build) return build(prep, m, c, level, signal);
    await pending;
    return { summary: 'Verified historical result.', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, details: {} };
  };
  mod.install(pi, { config: { ...config, ...configOverride }, log: x => logs.push(x), build: builder, settings: () => settings });
  return { ctx, branch, logs, requests, sent, errors, tool, add, message, emit, finish: () => resolveBuild(), setTokens: n => { tokens = n; }, setIdle: x => { idle = x; }, setQueued: x => { queued = x; }, metrics: () => ({ aborts, compacts, fallback }) };
}
for (const n of [2000, 128000, 799999]) {
  const f = fixture({ tokens: n, configOverride: { firstToolCompaction: true, providers: { [model.provider]: { startTokens: 1 } } } });
  await f.emit('tool_execution_start', f.tool); assert.equal(f.requests.length, 0, 'no hidden or first-tool trigger');
}
{
  const f = fixture(); await f.emit('tool_execution_start', f.tool);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].level, 'xhigh');
  assert.ok(!JSON.stringify(f.requests[0].prep).includes(f.tool.toolCallId), 'inflight tool remains outside summarized prefix');
  f.message('user', 'TAIL_MUST_SURVIVE'); f.finish(); await until(() => f.sent.length === 1, 'apply and resume');
  assert.deepEqual(f.metrics(), { aborts: 1, compacts: 1, fallback: 0 }); assert.deepEqual(f.sent, ['continue']);
  const rebuilt = JSON.stringify(sdk.buildSessionContext(f.branch).messages);
  assert.ok(rebuilt.includes('TAIL_MUST_SURVIVE')); assert.ok(rebuilt.includes(f.tool.toolCallId)); assert.deepEqual(f.errors, []);
}
{
  const f = fixture({ queued: true }); await f.emit('tool_execution_start', f.tool); f.finish(); await until(() => f.logs.some(e => e.event === 'ready'), 'queued ready');
  assert.equal(f.metrics().compacts, 0); f.setQueued(false); f.setIdle(true); await f.emit('agent_settled'); await until(() => f.metrics().compacts === 1, 'queued apply');
  assert.equal(f.metrics().aborts, 0);
}
{
  const f = fixture();
  f.add({ type: 'message', message: { role: 'toolResult', toolCallId: f.tool.toolCallId, toolName: f.tool.toolName, content: [{ type: 'text', text: 'done' }], isError: false, timestamp: Date.now() } });
  await f.emit('turn_end'); assert.equal(f.requests.length, 1, 'completed turn triggers even without another tool');
  await f.emit('session_shutdown'); assert.equal(f.requests[0].signal.aborted, true); f.finish();
}
for (const event of ['model_select', 'session_tree', 'session_shutdown']) {
  const f = fixture(); await f.emit('tool_execution_start', f.tool); await f.emit(event); assert.equal(f.requests[0].signal.aborted, true, event); f.finish();
}
for (const level of ['high', 'xhigh', 'max']) {
  const done = { summary: 'Overflow summary', firstKeptEntryId: 'kept', tokensBefore: 123, details: {} };
  const f = fixture({ build: async () => done }); f.ctx.thinkingLevel = level;
  await f.emit('context_with_system', { messages: [] }); f.ctx.thinkingLevel = 'medium';
  const result = await f.emit('session_before_compact', { preparation: { messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 123 }, reason: 'overflow', signal: new AbortController().signal });
  assert.equal(result?.compaction, done); assert.equal(f.requests[0].level, level);
}
{
  const f = fixture({ build: async () => { throw Error('provider rejected summary'); } });
  await f.emit('tool_execution_start', f.tool); await until(() => f.logs.some(e => e.event === 'failed'), 'visible failure');
  assert.equal(f.metrics().compacts, 0); assert.equal(f.branch.filter(e => e.type === 'compaction').length, 0);
}
console.log('PASS real extension: inclusive 800K, no overrides, completed turns/tool boundary, abort/apply/resume, queue, invalidation, failure, overflow tier');
