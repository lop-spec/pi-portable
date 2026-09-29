// Opt-in real-model replay of one saved compaction. Never applies it or writes the source session.
// PI_TEST_HOST=<actual SDK> [PI_ASYNC_REPLAY_MAX_MS=10000] node this-file --live <agent> <candidate> <session.jsonl> <compaction-id> <new-output-dir>
// Acceptance defaults to <=10 seconds; an explicit override may only make it stricter.
// A latency gate rejects a late complete summary; it never truncates output or changes production timeout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [mode, agentDir, candidate, sourceFile, baselineId, outDir] = process.argv.slice(2);
const host = process.env.PI_TEST_HOST;
const latencyGateMs = Number(process.env.PI_ASYNC_REPLAY_MAX_MS ?? 10000);
assert.ok(Number.isSafeInteger(latencyGateMs) && latencyGateMs > 0 && latencyGateMs <= 10000, 'Latency gate must be <=10000ms; no relaxed acceptance');
assert.ok(mode === '--live' && host && [agentDir, candidate, sourceFile, outDir].every(p => p && path.isAbsolute(p)) && baselineId, 'Explicit --live and absolute managed paths required');
assert.ok(!fs.existsSync(outDir), 'Use a new output directory; never overwrite prior evidence');
fs.mkdirSync(outDir, { recursive: true });
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const require = createRequire(path.join(host, 'package.json'));
const aiRoot = path.join(host, 'node_modules/@earendil-works/pi-ai/dist');
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai/providers/all': path.join(aiRoot, 'providers/all.js'),
  '@earendil-works/pi-ai': path.join(aiRoot, 'compat.js'),
} });
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const ai = await import(pathToFileURL(path.join(aiRoot, 'compat.js')));
const mod = await jiti.import(path.join(candidate, 'index.ts'));
const { prepareAsyncCompaction } = await jiti.import(path.join(candidate, 'upstream/src/preparation.ts'));
const { buildAsyncCompactionResult } = await jiti.import(path.join(candidate, 'upstream/src/job.ts'));
const frozen = fs.readFileSync(sourceFile);
const entries = frozen.toString('utf8').trim().split('\n').map(x => JSON.parse(x)).filter(e => e.type !== 'session');
const baseline = entries.find(e => e.id === baselineId);
assert.ok(baseline?.details?.asyncPrefixCompaction && baseline.usage?.output > 0);
const marker = baseline.details.asyncPrefixCompaction;
const byId = new Map(entries.map(e => [e.id, e]));
let branch = [], entry = byId.get(marker.snapshotLeafId);
while (entry) { branch.push(entry); entry = byId.get(entry.parentId); }
branch.reverse();
const settings = JSON.parse(marker.settingsKey);
const prep = prepareAsyncCompaction(branch, settings);
assert.equal(prep.firstKeptEntryId, baseline.firstKeptEntryId);
const prepHash = hash(JSON.stringify(prep));
if (mod.setRetainedContext) mod.setRetainedContext(prep, branch);
const expectedInstructions = mod.getSummaryInstructions ? mod.getSummaryInstructions(prep) : mod.SUMMARY_INSTRUCTIONS;
const settingsFile = path.join(agentDir, 'settings.json');
const settingsHash = hash(fs.readFileSync(settingsFile));
const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert.deepEqual(saved.compaction, settings, 'Replay must preserve original compaction settings');
const events = fs.readFileSync(path.join(agentDir, 'data/lop-async-compaction.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
const ready = events.filter(e => e.event === 'ready' && e.jobId === marker.jobId && e.timestamp <= baseline.timestamp && byId.has(marker.snapshotLeafId) && e.sessionId === JSON.parse(frozen.toString('utf8').split('\n')[0]).id).at(-1);
assert.ok(ready?.durationMs > 0);
const [provider, ...modelParts] = marker.modelKey.split('/');
const modelId = modelParts.join('/');
const codexAuth = await jiti.import(path.join(agentDir, 'extensions/codex-file-auth.ts'), { default: true });
const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
const settingsManager = sdk.SettingsManager.inMemory({ ...saved, compaction: settings });
let ctx, session, started, firstTextAt, lastTextAt, gateTimer, maxTextGapMs = 0, textDeltas = 0, textChars = 0;
const requests = [], baseCalls = [];
const report = { status: 'running', sourceFile, baselineId, snapshotId: marker.snapshotLeafId, policy: mod.SUMMARY_POLICY, latencyGateMs, baseline: { durationMs: ready.durationMs, usage: baseline.usage, summaryChars: baseline.summary.length }, requests };
const save = () => fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
save();
const progress = setInterval(() => console.log(JSON.stringify({ event: 'progress', elapsedMs: started ? Date.now() - started : null, requests: requests.length, textDeltas, firstTextMs: firstTextAt && started ? firstTextAt - started : null, maxTextGapMs })), 15000);
try {
  const loader = new sdk.DefaultResourceLoader({ cwd: outDir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [codexAuth, pi => pi.on('session_start', (_e, c) => { ctx = c; })], systemPromptOverride: () => 'Isolated summary replay; no tools or business actions.' });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: outDir, agentDir, settingsManager, modelRuntime: runtime, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(outDir), noTools: 'all' }));
  await session.bindExtensions({});
  await runtime.refresh({ providers: [provider], signal: AbortSignal.timeout(20000) });
  const selected = runtime.getModels(provider).find(m => m.id === modelId);
  assert.ok(selected, 'Original model unavailable; no fallback');
  await session.setModel(selected);
  session.setThinkingLevel(marker.thinkingLevel);
  await session.bindExtensions({});
  // Capture unchanged native prompts/options offline, without asking another model for a baseline.
  await sdk.compact(prep, selected, 'offline-placeholder', undefined, undefined, undefined, 'low', async (model, context, options) => {
    baseCalls.push({ systemPrompt: context.systemPrompt, prompt: context.messages[0].content[0].text, maxTokens: options.maxTokens });
    return { result: async () => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: 'Offline fixture' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) };
  });
  const captureCompact = (...args) => {
    args[7] = (model, context, options) => {
      const prompt = context.messages[0].content[0].text;
      const base = baseCalls.find(b => prompt === b.prompt);
      assert.ok(base, 'Native user prompt must remain unchanged');
      assert.equal(context.systemPrompt, base.systemPrompt + '\n\n' + expectedInstructions, 'Every summary branch must receive the scoped policy');
      assert.equal(options.reasoning, 'low');
      assert.equal(options.maxTokens, base.maxTokens);
      const record = { model: model.id, reasoning: options.reasoning, maxTokensUnchanged: options.maxTokens, promptChars: prompt.length, instructionsApplied: context.systemPrompt.endsWith(expectedInstructions) };
      requests.push(record);
      const stream = ai.streamSimple(model, context, { ...options, onPayload: body => {
        assert.equal(body.model, modelId);
        assert.equal(body.reasoning.effort, 'low');
        record.payload = { model: body.model, reasoning: body.reasoning.effort, verbosity: body.text?.verbosity, serviceTier: body.service_tier ?? null, hasMaxOutputTokens: 'max_output_tokens' in body };
      } });
      // .result() is independent of event iteration; observe without changing provider output.
      void (async () => { for await (const e of stream) if (e.type === 'text_delta') { const now = Date.now(); firstTextAt ??= now; if (lastTextAt) maxTextGapMs = Math.max(maxTextGapMs, now - lastTextAt); lastTextAt = now; textDeltas++; textChars += e.delta.length; } })().catch(error => { record.observerError = String(error); console.error('replay observer failed', String(error)); });
      return stream;
    };
    return mod.compactWithInstructions(...args);
  };
  started = Date.now();
  if (latencyGateMs !== null) gateTimer = setTimeout(() => {
    report.atLatencyGate = { elapsedMs: Date.now() - started, firstTextMs: firstTextAt ? firstTextAt - started : null, textDeltas, textChars, complete: false };
    console.log(JSON.stringify({ event: 'latency-gate-missed', ...report.atLatencyGate })); save();
  }, latencyGateMs);
  console.log(JSON.stringify({ event: 'start', model: selected.id, thinking: 'low', isSplitTurn: prep.isSplitTurn, snapshotId: marker.snapshotLeafId, baselineOutput: baseline.usage.output, baselineDurationMs: ready.durationMs }));
  const result = await buildAsyncCompactionResult(prep, selected, ctx, 'low', AbortSignal.timeout(mod.readConfig().timeoutMs), captureCompact);
  const durationMs = Date.now() - started;
  clearTimeout(gateTimer);
  report.latencyGatePassed = latencyGateMs === null ? null : durationMs <= latencyGateMs;
  assert.ok(result.summary.trim() && result.usage?.output > 0);
  assert.ok(requests.length && requests.every(r => r.payload && !r.observerError));
  assert.equal(result.firstKeptEntryId, baseline.firstKeptEntryId);
  assert.equal(hash(JSON.stringify(prep)), prepHash);
  assert.equal(session.thinkingLevel, marker.thinkingLevel);
  assert.equal(hash(fs.readFileSync(settingsFile)), settingsHash);
  assert.equal(hash(fs.readFileSync(sourceFile).subarray(0, frozen.length)), hash(frozen), 'Source prefix unchanged; concurrent appends are allowed');
  const original = sdk.buildSessionContext(entries, baseline.id).messages;
  const replaced = sdk.buildSessionContext(entries.map(e => e.id === baseline.id ? { ...e, summary: result.summary } : e), baseline.id).messages;
  assert.deepEqual(replaced.filter(m => m.role !== 'compactionSummary'), original.filter(m => m.role !== 'compactionSummary'), 'All retained messages and tool pairs must remain byte-for-byte equal');
  const tail = replaced.filter(m => m.role !== 'compactionSummary');
  fs.writeFileSync(path.join(outDir, 'summary.md'), result.summary);
  Object.assign(report, { status: 'generated-needs-semantic-review', durationMs, firstTextMs: firstTextAt ? firstTextAt - started : null, maxTextGapMs, textDeltas, usage: result.usage, summaryChars: result.summary.length, retainedMessages: tail.length, withinOriginal2k3kRange: result.usage.output >= 2000 && result.usage.output <= 3000, fewerOutputTokens: result.usage.output < baseline.usage.output, faster: durationMs < ready.durationMs, invariantChecks: 'passed', liveSessionWrites: 0, mainThinkingUnchanged: session.thinkingLevel });
  save();
  console.log(JSON.stringify(report));
  const goal = result.summary.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n<read-files>|$)/m)?.[1].trim();
  assert.ok(goal && !/^(?:[-–—]|in retained context[.]?)$/i.test(goal), 'A meaningful explicit Goal is required for the existing compact index');
  if (latencyGateMs !== null) assert.ok(durationMs <= latencyGateMs, `Latency acceptance FAILED: ${durationMs}ms > ${latencyGateMs}ms; do not deploy`);
} catch (error) {
  Object.assign(report, { status: 'failed', error: String(error?.stack || error) }); save(); throw error;
} finally { clearTimeout(gateTimer); clearInterval(progress); session?.dispose(); }
