// Uses the patched SDK, real HTTP streaming and an ephemeral loopback-only provider.
// This is a simulated provider limit, not evidence of any remote model's capacity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const host = process.env.PI_TEST_HOST, candidate = process.env.PI_ASYNC_TEST_DIR;
assert.ok(host && candidate, 'PI_TEST_HOST and PI_ASYNC_TEST_DIR required');
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')).href);
const { createJiti } = createRequire(path.join(host, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai': path.join(host, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
} });
const extension = await jiti.import(path.join(candidate, 'index.ts'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-small-http-'));
let mode = '', requests = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  const text = JSON.stringify(body.messages ?? []);
  const summary = text.includes('Aim for roughly 2,000-3,000 output tokens');
  requests.push({ url: req.url, chars: text.length, summary, text, effort: body.reasoning_effort });
  const cap = mode === 'summary-fails' ? 1500 : 18000;
  const splitFails = mode === 'split-fails' && summary && requests.filter(r => r.summary).length === 2;
  if ((mode !== 'normal-length' && text.length > cap) || splitFails) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model', type: 'invalid_request_error', code: 'context_length_exceeded' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const message = summary ? 'Safe summary preserving task and constraints.' : 'MAIN_DONE';
  const chunk = (delta, finish) => ({ id: 'fake-id', object: 'chat.completion.chunk', created: 1, model: 'small', choices: [{ index: 0, delta, finish_reason: finish }] });
  res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: message }, null)) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk({}, mode === 'normal-length' ? 'length' : 'stop'), usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: 4, total_tokens: Math.ceil(text.length / 4) + 4 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (resource, options) => {
  const address = typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url;
  if (!address.startsWith(baseUrl + '/')) throw Error('External network forbidden in provider fixture');
  return nativeFetch(resource, options);
};
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, label) => { for (let i = 0; i < 1000; i++) { if (f()) return; await delay(10); } throw Error('timeout: ' + label); };
try {
  for (mode of ['recover', 'summary-fails', 'split-fails', 'manual-custom', 'nonreasoning-manual', 'normal-length']) {
    requests = [];
    const temp = path.join(root, mode); fs.mkdirSync(temp);
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(temp, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const level = mode === 'nonreasoning-manual' ? 'off' : 'high';
    runtime.registerProvider('local-small', { baseUrl, api: 'openai-completions', models: [{ id: 'small', name: 'small', contextWindow: 2048, maxTokens: 512, reasoning: level !== 'off', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false } }] });
    await runtime.setRuntimeApiKey('local-small', 'offline-test-key');
    const model = runtime.getModel('local-small', 'small');
    assert.equal(model.contextWindow, 0, 'composer reports unknown window to SDK');
    const settings = { enabled: true, reserveTokens: 4096, keepRecentTokens: 256 };
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: settings, retry: { enabled: false }, defaultThinkingLevel: level });
    const sm = sdk.SessionManager.create(temp, path.join(temp, 'sessions'));
    const user = text => ({ role: 'user', content: text, timestamp: Date.now() - 10000 });
    const assistant = content => ({ role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now() - 10000,
      stopReason: 'stop', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    sm.appendMessage(user('ORIGINAL_TASK ' + 'important history '.repeat(100)));
    sm.appendMessage(assistant([{ type: 'toolCall', id: 'old-call', name: 'read', arguments: {} }]));
    sm.appendMessage({ role: 'toolResult', toolCallId: 'old-call', toolName: 'read', content: [{ type: 'text', text: 'BIG_TOOL_RESULT ' + 'x'.repeat(80000) }], isError: false, timestamp: Date.now() - 10000 });
    for (let i = 0; i < 4; i++) { sm.appendMessage(user('TAIL_USER_' + i + ' ' + 'tail '.repeat(300))); sm.appendMessage(assistant('TAIL_RESULT_' + i + ' ' + 'result '.repeat(200))); }
    const originals = sm.getEntries().map(e => e.id), events = [], logs = [];
    const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => extension.install(pi, { config: { ...extension.readConfig(''), cachedSummary: false, thinkingMode: level === 'off' ? 'request' : 'fixed', thinkingLevel: 'high' }, settings: () => settings, log: e => logs.push(e), mainReasoningContextPolicy: false })], systemPromptOverride: () => 'Offline small provider fixture.' });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: temp, agentDir: temp, resourceLoader: loader, modelRuntime: runtime, settingsManager, sessionManager: sm, model, thinkingLevel: level, tools: [] });
    session.subscribe(e => events.push(e));
    try {
      await session.bindExtensions({});
      if (mode === 'manual-custom' || mode === 'nonreasoning-manual') await session.compact('MANUAL_FOCUS_MUST_REACH_PROVIDER');
      else await session.prompt('CURRENT_TASK_RETAINED');
      if (mode !== 'normal-length') await until(() => events.some(e => e.type === 'compaction_end'), mode + ' compaction');
      const saved = sm.getEntries().filter(e => e.type === 'compaction');
      assert.ok(originals.every(id => sm.getEntries().some(e => e.id === id)), 'original entries remain on disk');
      assert.ok(requests.every(r => r.url === '/v1/chat/completions'));
      if (mode === 'recover') {
        assert.equal(saved.length, 1); assert.equal(requests.length, 4, 'one overflow, history and split-turn summaries, one main retry');
        assert.deepEqual(requests.map(r => r.summary), [false, true, true, false]);
        assert.ok(requests[0].chars > 18000 && requests.slice(1).every(r => r.chars < 18000));
        assert.ok(JSON.stringify(sm.buildSessionContext().messages).includes('CURRENT_TASK_RETAINED'));
      } else if (mode === 'summary-fails' || mode === 'split-fails') {
        assert.equal(saved.length, 0); assert.equal(requests.length, mode === 'split-fails' ? 3 : 2, 'failed summary cannot enter main retry loop');
        assert.deepEqual(requests.map(r => r.summary), mode === 'split-fails' ? [false, true, true] : [false, true]);
        const failure = events.filter(e => e.type === 'compaction_end').at(-1);
        assert.equal(failure.aborted, false); assert.match(failure.errorMessage, /压缩摘要失败/);
        assert.ok(JSON.stringify(sm.buildSessionContext().messages).includes('ORIGINAL_TASK'));
      } else if (mode === 'manual-custom' || mode === 'nonreasoning-manual') {
        assert.equal(saved.length, 1); assert.equal(requests.length, 2, 'history and split-turn summaries');
        assert.ok(requests.every(r => r.summary) && requests.some(r => r.text.includes('MANUAL_FOCUS_MUST_REACH_PROVIDER')));
        if (mode === 'nonreasoning-manual') {
          assert.ok(requests.every(r => r.effort === undefined));
          assert.ok(logs.some(e => e.event === 'native-routed-request' && e.thinkingLevel === 'off'));
        }
      } else {
        assert.equal(saved.length, 0); assert.equal(requests.length, 1, 'ordinary length finish is not an overflow retry');
        assert.ok(!events.some(e => e.type === 'compaction_start'));
      }
      console.log('PASS', mode, JSON.stringify({ requests: requests.map(({ chars, summary }) => ({ chars, summary })), compacted: saved.length }));
    } catch (e) {
      console.error('DIAGNOSTIC', mode, JSON.stringify({ requests: requests.map(({ chars, summary }) => ({ chars, summary })), events: events.filter(x => x.type === 'compaction_end'), logs: logs.slice(-4) }));
      throw e;
    } finally { session.dispose(); }
  }
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
}
