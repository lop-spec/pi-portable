// Native AgentSession + native compact() + unchanged upstream core. Provider streams are deterministic; no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const host = process.env.PI_TEST_HOST, candidate = process.env.PI_ASYNC_TEST_DIR;
assert.ok(host && candidate);
const require = createRequire(path.join(host, 'package.json'));
const aiRoot = path.join(host, 'node_modules/@earendil-works/pi-ai/dist');
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const ai = await import(pathToFileURL(path.join(aiRoot, 'compat.js')));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'), '@earendil-works/pi-ai': path.join(aiRoot, 'compat.js'),
} });
const mod = await jiti.import(path.join(candidate, 'index.ts'));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(aiRoot, 'utils/event-stream.js')));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-async-sdk-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Offline acceptance attempted network'); };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 500; i++) { if (fn()) return; await delay(10); } throw Error('Timed out: ' + label); }
function msg(model, content, stopReason = 'stop', tokens = 5000) {
  return { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason, content,
    usage: { input: tokens, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(message) {
  const out = new AssistantMessageEventStream();
  queueMicrotask(() => { out.push({ type: 'done', reason: message.stopReason, message }); out.end(message); });
  return out;
}
try {
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(temp, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey('openai', 'offline-key');
  const model = { ...ai.getModel('openai', 'gpt-5'), contextWindow: 1000000, maxTokens: 8192 };
  // All three native branches must receive the policy without changing source data or call count.
  for (const [label, history, prefix] of [['history-only', true, false], ['prefix-only', false, true], ['split-history', true, true]]) {
    const user = text => ({ role: 'user', content: text, timestamp: 1 });
    const prep = {
      firstKeptEntryId: 'kept', messagesToSummarize: history ? [user('Completed history')] : [],
      turnPrefixMessages: prefix ? [user('Current task: follow previously read document rules')] : [],
      isSplitTurn: prefix, tokensBefore: 1000, previousSummary: undefined,
      fileOps: { read: new Set(['rules/document-plan-editing.md']), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 256 },
    };
    const source = structuredClone(prep), baseline = [], captured = [];
    const capture = records => (m, context, options) => {
      records.push({ context: structuredClone(context), options });
      return stream(msg(m, [{ type: 'text', text: 'Fixture summary.' }]));
    };
    const signal = new AbortController().signal;
    const native = await sdk.compact(prep, model, 'offline-key', undefined, 'caller focus', signal, 'low', capture(baseline));
    const scoped = await mod.compactWithInstructions(prep, model, 'offline-key', undefined, 'caller focus', signal, 'low', capture(captured));
    assert.equal(captured.length, Number(history) + Number(prefix), label + ': no extra model calls');
    assert.equal(captured.length, baseline.length);
    for (let i = 0; i < captured.length; i++) {
      assert.equal(captured[i].context.systemPrompt, baseline[i].context.systemPrompt + '\n\n' + mod.SUMMARY_INSTRUCTIONS);
      const contents = c => c.messages.map(({ timestamp, ...m }) => m);
      assert.deepEqual(contents(captured[i].context), contents(baseline[i].context), label + ': native prompts preserved');
      for (const key of ['reasoning', 'maxTokens', 'cacheRetention', 'signal', 'apiKey'])
        assert.equal(captured[i].options[key], baseline[i].options[key], label + '/' + key);
    }
    assert.deepEqual(prep, source, label + ': no mutation');
    assert.deepEqual(scoped, native, label + ': native result/boundary/file tracking unchanged');
    console.log('PASS scoped summary policy: ' + label);
  }
  for (const { forceActive, switchPhase } of [
    { forceActive: false }, { forceActive: true },
    { forceActive: false, switchPhase: 'pending' }, { forceActive: true, switchPhase: 'pending' },
    { forceActive: false, switchPhase: 'ready' },
  ]) {
    const logs = [], events = [], summaryRequests = [];
    let mainCalls = 0, toolExecutions = 0, toolAborts = 0;
    const nativeSettings = { enabled: true, reserveTokens: 4096, keepRecentTokens: 256 };
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: nativeSettings, retry: { enabled: false }, defaultThinkingLevel: 'high' });
    const beforeSettings = JSON.stringify(settingsManager.getCompactionSettings());
    const sessionManager = sdk.SessionManager.create(temp, path.join(temp, `${forceActive ? 'active' : 'idle'}-${switchPhase || 'unchanged'}`));
    for (let n = 0; n < 6; n++) {
      sessionManager.appendMessage({ role: 'user', content: `Completed request ${n}: ` + 'historical context '.repeat(200), timestamp: Date.now() });
      sessionManager.appendMessage(msg(model, [{ type: 'text', text: `Completed result ${n}: ` + 'confirmed result '.repeat(100) }], 'stop', 5000));
    }
    const builder = async (prep, m, ctx, level, signal, compactFn) => {
      assert.equal(compactFn, mod.compactWithInstructions);
      assert.equal(m.id, model.id); assert.equal(level, 'low');
      assert.ok(!JSON.stringify(prep).includes('native-tool-1'));
      await delay(20);
      const originalPrep = JSON.stringify(prep);
      const result = await compactFn(prep, m, 'offline-key', undefined, 'Existing caller focus must survive.', signal, level,
        (requestModel, context, options) => {
          const prompt = JSON.stringify(context.messages);
          const history = prompt.includes('## Critical Context');
          assert.ok(context.systemPrompt.endsWith(mod.SUMMARY_INSTRUCTIONS), 'history and split-turn prefix must both receive rule-retention policy');
          assert.equal(context.systemPrompt.split(mod.SUMMARY_INSTRUCTIONS).length, 2, 'policy applied exactly once');
          assert.ok(!prompt.includes(mod.SUMMARY_INSTRUCTIONS.replace(/\n/g, '\\n')), 'do not duplicate system policy in user prompt');
          assert.equal(prompt.includes('Existing caller focus must survive.'), history);
          assert.equal(options.maxTokens, Math.floor((history ? 0.8 : 0.5) * nativeSettings.reserveTokens));
          summaryRequests.push({ model: requestModel.id, reasoning: options.reasoning, messages: context.messages.length, history, systemPrompt: context.systemPrompt });
          return stream(msg(requestModel, [{ type: 'text', text: 'Completed historical work; retain current tool execution and newest messages.' }], 'stop', 200));
        });
      assert.equal(JSON.stringify(prep), originalPrep, 'summary policy must not mutate preparation or retained boundary');
      return result;
    };
    const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => mod.install(pi, { config: mod.readConfig(), log: e => logs.push(e), build: builder, settings: () => nativeSettings })],
      systemPromptOverride: () => 'Offline lifecycle fixture.',
    });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: temp, agentDir: temp, resourceLoader: loader, modelRuntime: runtime,
      sessionManager, settingsManager, model, thinkingLevel: 'high', tools: ['native_test_tool'],
      customTools: [{ name: 'native_test_tool', label: 'native test', description: 'offline tool phase', parameters: { type: 'object', properties: {} },
        execute: async (_id, _params, signal) => {
          toolExecutions++;
          if (switchPhase) {
            if (switchPhase === 'ready') await until(() => logs.some(e => e.event === 'ready'), 'summary ready before main switch');
            session.setThinkingLevel('medium');
            await delay(0); // let the actual SDK dispatch thinking_level_select
            assert.ok(!logs.some(e => e.event === 'invalidated'), 'main switch must retain fixed-low job');
          }
          await new Promise(resolve => { const timer = setTimeout(resolve, forceActive ? 200 : 50); signal?.addEventListener('abort', () => { toolAborts++; clearTimeout(timer); resolve(); }, { once: true }); });
          return { content: [{ type: 'text', text: 'NATIVE_TOOL_RESULT_MUST_SURVIVE' }], details: {} };
        } }],
    });
    session.subscribe(event => events.push(event));
    session.agent.streamFunction = (m, context, options) => {
      mainCalls++;
      assert.equal(options.reasoning, session.thinkingLevel, 'main requests must follow the real main selection, not summary low');
      assert.ok(mainCalls <= 4, 'no unexpected continuation loop');
      return stream(msg(m, mainCalls === 1 ? [{ type: 'toolCall', id: 'native-tool-1', name: 'native_test_tool', arguments: {} }] : [{ type: 'text', text: 'NATIVE_FINAL_MUST_SURVIVE' }], mainCalls === 1 ? 'toolUse' : 'stop', forceActive ? 128000 : 5000));
    };
    await session.bindExtensions({});
    try {
      await session.prompt('Perform the native tool fixture.');
      await until(() => sessionManager.getEntries().some(e => e.type === 'compaction'), 'native saved compaction');
      if (forceActive) await until(() => sessionManager.getEntries().some(e => e.type === 'message' && e.message.role === 'user' && (e.message.content === 'continue' || e.message.content?.some?.(b => b.type === 'text' && b.text === 'continue'))), 'native continue');
      await until(() => !session.isStreaming, 'agent idle');
      assert.equal(summaryRequests.length, 2, 'native history + prefix, no additional summary calls');
      assert.ok(summaryRequests.every(r => r.reasoning === 'low'));
      assert.ok(summaryRequests.some(r => r.history), 'exercise real native history summarization');
      assert.equal(new Set(summaryRequests.map(r => r.systemPrompt)).size, 1, 'same scoped system policy on both native summary branches');
      assert.ok(summaryRequests.some(r => !r.history), 'exercise real native split-turn prefix summarization');
      assert.equal(JSON.stringify(settingsManager.getCompactionSettings()), beforeSettings);
      assert.equal(session.thinkingLevel, switchPhase ? 'medium' : 'high');
      assert.equal(logs.filter(e => e.event === 'started').length, 1, 'main switch must not restart summary');
      assert.ok(!logs.some(e => e.event === 'invalidated' || e.event === 'native-fallback'));
      assert.equal(sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === mod.FIRST_JOB_MARKER).length, 1);
      assert.equal(sessionManager.getEntries().filter(e => e.type === 'compaction').length, 1);
      assert.equal(toolExecutions, 1);
      const rebuilt = JSON.stringify(sessionManager.buildSessionContext().messages);
      assert.ok(rebuilt.includes('NATIVE_TOOL_RESULT_MUST_SURVIVE'));
      if (forceActive) assert.equal(toolAborts, 1); else assert.equal(toolAborts, 0);
      assert.ok(!logs.some(e => e.event === 'failed'));
      console.log(`PASS native SDK ${forceActive ? 'abort/compact/continue' : 'idle apply'}: mainCalls=${mainCalls} summaryRequests=${summaryRequests.length} toolExecutions=${toolExecutions} toolAborts=${toolAborts} main=${session.thinkingLevel} switch=${switchPhase || 'none'} summary=low saved=1`);
    } finally { session.dispose(); }
  }
  console.log('Native SDK regression passed; network/model requests=0. Test session files retained at ' + temp);
} finally { globalThis.fetch = originalFetch; }
