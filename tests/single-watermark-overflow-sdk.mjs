// Real patched SDK and extension; deterministic local provider streams, no network or real sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const host = process.env.PI_TEST_HOST, candidate = process.env.PI_ASYNC_TEST_DIR;
assert.ok(host && candidate);
const imp = p => import(pathToFileURL(path.join(host, p)).href);
const sdk = await imp('dist/index.js');
const ai = await imp('node_modules/@earendil-works/pi-ai/dist/compat.js');
const { AssistantMessageEventStream } = await imp('node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js');
const { createJiti } = createRequire(path.join(host, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai': path.join(host, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
} });
const mod = await jiti.import(path.join(candidate, 'index.ts'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-overflow-watermark-'));
const fetch0 = globalThis.fetch; globalThis.fetch = () => { throw Error('NETWORK_FORBIDDEN'); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label) => { for (let n = 0; n < 500; n++) { if (fn()) return; await delay(10); } throw Error(`timeout: ${label}`); };
try {
 for (const mode of ['overflow-ok', 'overflow-summary-too-large', 'manual-ok', 'manual-summary-too-large', 'manual-cancel']) {
  const temp = path.join(root, mode); fs.mkdirSync(temp);
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(temp, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  await runtime.setRuntimeApiKey('openai', 'offline-key');
  const model = { ...ai.getModel('openai', 'gpt-5'), contextWindow: 0, maxTokens: 8192 };
  const settings = { enabled: true, reserveTokens: 4096, keepRecentTokens: 256 };
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: settings, retry: { enabled: false }, defaultThinkingLevel: 'high' });
  const sm = sdk.SessionManager.create(temp, path.join(temp, 'sessions'));
  const user = text => ({ role: 'user', content: text, timestamp: Date.now() - 10000 });
  const assistant = (stopReason, text, errorMessage) => ({ role: 'assistant', provider: model.provider, model: model.id, api: model.api,
    timestamp: Date.now() - 10000, stopReason, errorMessage, content: text ? [{ type: 'text', text }] : [],
    usage: { input: 5000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  for (let n = 0; n < 6; n++) { sm.appendMessage(user(`ORIGINAL_USER_${n} ` + 'historical context '.repeat(200))); sm.appendMessage(assistant('stop', `ORIGINAL_ASSISTANT_${n} ` + 'retained result '.repeat(100))); }
  const original = sm.getEntries().map(e => e.id), events = [], logs = [], summaryRequests = [];
  const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => mod.install(pi, { config: { ...mod.readConfig(''), thinkingMode: 'fixed', thinkingLevel: 'high' }, settings: () => settings,
      log: e => logs.push(e), build: async (prep, m, ctx, level, signal) => {
        summaryRequests.push({ prep, model: m.id, level, signal });
        if (mode === 'manual-cancel') return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
        if (mode.endsWith('too-large')) throw Error('Your input exceeds the context window of this model');
        return { summary: 'Verified historical summary.', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, details: {} };
      } })], systemPromptOverride: () => 'Offline overflow fixture.' });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: temp, agentDir: temp, resourceLoader: loader, modelRuntime: runtime, settingsManager, sessionManager: sm, model, thinkingLevel: 'high', tools: [] });
  session.subscribe(e => events.push(e));
  let mainCalls = 0;
  session.agent.streamFunction = m => {
    mainCalls++;
    const fail = mode.startsWith('overflow') && mainCalls === 1;
    const msg = assistant(fail ? 'error' : 'stop', fail ? '' : 'RECOVERED_MAIN_RESPONSE', fail ? 'Your input exceeds the context window of this model' : undefined);
    msg.timestamp = Date.now();
    const out = new AssistantMessageEventStream(); queueMicrotask(() => { out.push({ type: fail ? 'error' : 'done', reason: msg.stopReason, message: msg, error: msg }); out.end(msg); }); return out;
  };
  try {
    await session.bindExtensions({});
    if (mode.startsWith('overflow')) await session.prompt('CURRENT_TASK_RETAINED');
    else {
      sm.appendMessage(user('CURRENT_TASK_RETAINED'));
      if (mode === 'manual-cancel') {
        const pending = session.compact('focus on current task');
        await until(() => summaryRequests.length === 1, 'manual summary started'); session.abortCompaction(); await assert.rejects(() => pending);
      } else if (mode.endsWith('too-large')) await assert.rejects(() => session.compact('focus on current task'));
      else await session.compact('focus on current task');
    }
    await until(() => events.some(e => e.type === 'compaction_end'), mode + ' compaction end');
    assert.equal(summaryRequests.length, 1, mode + ' bounded summary requests');
    assert.equal(summaryRequests[0].level, 'high');
    assert.ok(original.every(id => sm.getEntries().some(e => e.id === id)), 'original entries remain on disk');
    const saved = sm.getEntries().filter(e => e.type === 'compaction');
    if (mode.endsWith('too-large') || mode === 'manual-cancel') {
      assert.equal(saved.length, 0, 'failed or canceled summary must never commit compaction');
      const failure = events.filter(e => e.type === 'compaction_end').at(-1);
      if (mode === 'manual-cancel') { assert.equal(failure.aborted, true); assert.equal(failure.errorMessage, undefined); }
      else {
        assert.ok(logs.some(e => e.event === 'native-routed-failed' && /context window/.test(e.error)), 'failure logged');
        assert.equal(failure.aborted, false, 'failure is not presented as user cancellation');
        assert.match(failure.errorMessage, /压缩摘要失败/);
      }
      assert.ok(JSON.stringify(sm.buildSessionContext().messages).includes('ORIGINAL_USER_0'), 'failed summary keeps original context');
      if (mode.startsWith('overflow')) assert.equal(mainCalls, 1, 'failed summary cannot enter retry loop');
    } else {
      assert.equal(saved.length, 1);
      if (mode.startsWith('overflow')) { await until(() => mainCalls === 2, 'one recovered request'); assert.equal(mainCalls, 2); }
    }
    console.log('PASS', mode, JSON.stringify({ mainCalls, summaryCalls: summaryRequests.length, compacted: saved.length, finalEvent: events.filter(e => e.type === 'compaction_end').at(-1) }));
  } finally { session.dispose(); }
 }
} finally { globalThis.fetch = fetch0; }
