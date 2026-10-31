import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const host = process.env.PI_TEST_HOST, candidate = process.env.PI_ASYNC_TEST_DIR;
assert.ok(host && candidate);
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const aiRoot = path.join(host, 'node_modules/@earendil-works/pi-ai/dist');
const ai = await import(pathToFileURL(path.join(aiRoot, 'compat.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(aiRoot, 'utils/event-stream.js')));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-watermark-'));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR, oldFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = temp;
globalThis.fetch = () => { throw Error('Offline test attempted network'); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 500; i++) { if (fn()) return; await delay(10); } throw Error('Timed out: ' + label); }
function message(model, text, tokens) { return { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; }
function stream(msg) { const out = new AssistantMessageEventStream(); queueMicrotask(() => { out.push({ type: 'done', reason: 'stop', message: msg }); out.end(msg); }); return out; }
try {
  fs.mkdirSync(path.join(temp, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'extensions/unwanted.ts'), 'globalThis.__unexpected_extension_loaded = true; export default function() {}');
  fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 256 }, retry: { enabled: false }, defaultThinkingLevel: 'high' }));
  const settingsManager = sdk.SettingsManager.create(temp, temp);
  const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [path.join(candidate, 'compaction-only.ts')], systemPromptOverride: () => 'Offline chat-only test.' });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(globalThis.__unexpected_extension_loaded, undefined, 'no unrelated extension discovery');
  assert.equal(loader.getExtensions().extensions.length, 1);
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(temp, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey('openai', 'offline-key');
  const model = { ...ai.getModel('openai', 'gpt-5'), contextWindow: 0, maxTokens: 8192 };
  const summaries = [];
  runtime.getRegisteredProviderConfig = () => ({ streamSimple: (m, context, options) => { summaries.push({ options, context }); return stream(message(m, 'Keep verified user goals and history.', 100)); } });
  const sm = sdk.SessionManager.create(temp, path.join(temp, 'session'));
  for (let n = 0; n < 6; n++) {
    sm.appendMessage({ role: 'user', content: `Earlier ${n}: ` + 'prior discussion '.repeat(1000), timestamp: Date.now() });
    sm.appendMessage(message(model, 'Verified prior result '.repeat(600), 5000));
  }
  const { session } = await sdk.createAgentSession({ cwd: temp, agentDir: temp, resourceLoader: loader, modelRuntime: runtime, sessionManager: sm, settingsManager, model, thinkingLevel: 'high', tools: [] });
  const mainPayloads = [], events = [];
  session.subscribe(event => events.push(event));
  session.agent.streamFunction = (m, context, options) => {
    const out = new AssistantMessageEventStream();
    void (async () => { try {
      const original = { model: m.id, input: [{ role: 'user', content: 'example' }], reasoning: { effort: 'high' } };
      const transformed = options.onPayload ? await options.onPayload(structuredClone(original), m) : original;
      mainPayloads.push(transformed ?? original);
      assert.deepEqual(mainPayloads.at(-1), original, 'main reasoning scope and effort remain untouched');
      assert.equal(options.reasoning, 'high');
      const result = message(m, 'Chat response.', 800000);
      out.push({ type: 'done', reason: 'stop', message: result }); out.end(result);
    } catch (error) { out.error(error); } })();
    return out;
  };
  await session.bindExtensions({});
  try {
    await session.prompt('Continue the chat.');
    await until(() => sm.getEntries().some(e => e.type === 'compaction'), 'single-watermark chat compaction');
    assert.equal(sm.getEntries().filter(e => e.type === 'compaction').length, 1);
    assert.ok(summaries.length >= 1 && summaries.length <= 2);
    assert.ok(summaries.every(s => s.options.reasoning === 'high'), 'summary request preserves captured high level');
    assert.ok(JSON.stringify(sm.buildSessionContext().messages).includes('Chat response.'));
    assert.equal(session.getActiveToolNames().length, 0);
    console.log(JSON.stringify({ pass: 'chat-only explicit extension, 800000 watermark, zero tools, unchanged main payload', mainRequests: mainPayloads.length, summaryRequests: summaries.length, savedCompactions: 1 }));
  } finally { session.dispose(); }
} finally { globalThis.fetch = oldFetch; if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; }
