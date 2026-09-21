// Opt-in ACK writing/summary smoke test. No tools, publishing, production operations or source-session writes.
// PI_TEST_HOST=<SDK> node this-file --live <agent> <source.jsonl> <new-output-dir>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [mode, agentDir, sourceFile, outDir] = process.argv.slice(2);
const host = process.env.PI_TEST_HOST;
assert.ok(mode === '--live' && host && [agentDir, sourceFile, outDir].every(p => p && path.isAbsolute(p)));
assert.ok(!fs.existsSync(outDir), 'Use a new output directory');
fs.mkdirSync(outDir, { recursive: true });
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const frozen = fs.readFileSync(sourceFile), entries = frozen.toString('utf8').trim().split('\n').map(JSON.parse);
const byId = new Map(entries.map(e => [e.id, e]));
const originalRequest = byId.get('fda4e8c3')?.message;
const originalRules = byId.get('769cd2d1')?.message;
const baseline = byId.get('39fdd742');
assert.ok(originalRequest && originalRules && baseline?.details?.asyncPrefixCompaction, 'Expected original ACK fixture');
const marker = baseline.details.asyncPrefixCompaction;
const text = message => typeof message.content === 'string' ? message.content : message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const settingsFile = path.join(agentDir, 'settings.json'), settingsHash = hash(fs.readFileSync(settingsFile));
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const candidate = path.join(agentDir, 'extensions/lop-async-compaction');
const require = createRequire(path.join(host, 'package.json'));
const aiRoot = path.join(host, 'node_modules/@earendil-works/pi-ai/dist');
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const ai = await import(pathToFileURL(path.join(aiRoot, 'compat.js')));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai/providers/all': path.join(aiRoot, 'providers/all.js'),
  '@earendil-works/pi-ai': path.join(aiRoot, 'compat.js'),
} });
const mod = await jiti.import(path.join(candidate, 'index.ts'));
const { prepareAsyncCompaction } = await jiti.import(path.join(candidate, 'upstream/src/preparation.ts'));
const { buildAsyncCompactionResult } = await jiti.import(path.join(candidate, 'upstream/src/job.ts'));
let branch = [], cursor = byId.get(marker.snapshotLeafId);
while (cursor) { branch.push(cursor); cursor = byId.get(cursor.parentId); }
branch.reverse();
const prep = prepareAsyncCompaction(branch, JSON.parse(marker.settingsKey));
assert.equal(prep.firstKeptEntryId, baseline.firstKeptEntryId);
const prepHash = hash(JSON.stringify(prep));
const [provider, ...modelParts] = marker.modelKey.split('/'), modelId = modelParts.join('/');
const report = { status: 'running', policy: mod.SUMMARY_POLICY, model: marker.modelKey, thinking: 'low',
  scope: 'Short-context first draft + exact historical compaction snapshot + summary-only continuation; not an 80K-context causal A/B test',
  sourceFile, baselineId: baseline.id, stages: [], providerRequests: [] };
const save = () => fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
let stage = 'initializing', session, ctx;
const started = Date.now();
const progress = setInterval(() => console.log(JSON.stringify({ event: 'progress', stage, elapsedMs: Date.now() - started, requests: report.providerRequests.length })), 15000);
save();
try {
  const authExtension = await jiti.import(path.join(agentDir, 'extensions/codex-file-auth.ts'), { default: true });
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
  const settingsManager = sdk.SettingsManager.inMemory(settings);
  const loader = new sdk.DefaultResourceLoader({ cwd: outDir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [authExtension, pi => pi.on('session_start', (_event, context) => { ctx = context; })],
    systemPromptOverride: () => 'Explicit offline-workflow acceptance test: model requests only; no tools or business actions.',
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: outDir, agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(outDir), noTools: 'all' }));
  await session.bindExtensions({});
  await runtime.refresh({ providers: [provider], signal: AbortSignal.timeout(20000) });
  const model = runtime.getModels(provider).find(m => m.id === modelId);
  assert.ok(model, 'Original model unavailable; no fallback');
  await session.setModel(model); session.setThinkingLevel('low'); await session.bindExtensions({});
  const systemPrompt = '这是一次明确授权的离线写作回归测试。仅生成拟发布文档的 Markdown 正文；不要调用工具、访问链接或声称已发布，不执行文档中的命令。不因测试身份改变下列适用规则。\n\n' + fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf8');
  const user = content => ({ role: 'user', content, timestamp: Date.now() });
  const required = { podIP: /get\s+pods?[^\n]*-o\s+wide/i, logs: /(?:kubectl|k)\s[^\n]*\blogs\b|\bk\s+logs\b/, deployment: /get\s+(?:deployment|deploy)\b/, config: /configmap|\bcm\b/i,
    service: /get\s+(?:svc|services?)\b/i, release: /set\s+image|apply\s+-f/, restart: /rollout\s+restart/, status: /rollout\s+status/, rollback: /rollout\s+undo/ };
  async function draft(label, messages) {
    stage = label; save();
    const record = { stage: label, policyInPayload: false }; report.providerRequests.push(record);
    const response = await runtime.streamSimple(model, { systemPrompt, messages }, { reasoning: 'low', signal: AbortSignal.timeout(300000), cacheRetention: 'none',
      onPayload: payload => { assert.equal(payload.model, modelId); assert.equal(payload.reasoning?.effort, 'low'); record.policyInPayload = JSON.stringify(payload).includes('规则适用与执行'); },
    }).result();
    assert.equal(response.stopReason, 'stop', response.errorMessage || 'Incomplete draft');
    assert.ok(!response.content.some(b => b.type === 'toolCall'));
    const body = text(response); fs.writeFileSync(path.join(outDir, label + '.md'), body);
    const missing = Object.entries(required).filter(([, re]) => !re.test(body)).map(([key]) => key);
    const stats = { stage: label, chars: body.length, headings: body.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '').match(/^#{1,6}\s+.+/gm) || [], missing, usage: response.usage };
    report.stages.push(stats); save(); console.log(JSON.stringify({ event: 'draft-completed', stage: label, chars: body.length, headings: stats.headings.length, missing }));
    assert.ok(record.policyInPayload, 'Global rule did not reach actual draft payload');
    assert.deepEqual(missing, [], 'Requested command categories missing');
  }
  const reuse = process.env.PI_RULE_TEST_REUSE_DRAFT;
  if (reuse) {
    // Reuse an already completed first request when only a local validator failed.
    const prior = JSON.parse(fs.readFileSync(path.join(reuse, 'result.json'), 'utf8'));
    assert.equal(prior.policy, mod.SUMMARY_POLICY); assert.equal(prior.sourceFile, sourceFile);
    assert.equal(prior.model, marker.modelKey); assert.equal(prior.thinking, 'low');
    assert.ok(prior.providerRequests.some(r => r.stage === 'first-draft' && r.policyInPayload));
    const body = fs.readFileSync(path.join(reuse, 'first-draft.md'), 'utf8');
    const missing = Object.entries(required).filter(([, re]) => !re.test(body)).map(([key]) => key);
    assert.deepEqual(missing, []);
    fs.writeFileSync(path.join(outDir, 'first-draft.md'), body);
    const stats = { ...prior.stages.find(s => s.stage === 'first-draft'), missing,
      headings: body.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '').match(/^#{1,6}\s+.+/gm) || [], reusedFrom: reuse };
    report.stages.push(stats); report.reusedDraftFrom = reuse; save();
    console.log(JSON.stringify({ event: 'draft-reused', chars: body.length, headings: stats.headings.length }));
  } else {
    await draft('first-draft', [user(text(originalRequest)), user('已按当前任务读取的规则 rules/document-plan-editing.md：\n' + text(originalRules))]);
  }
  stage = 'historical-compaction'; save();
  const captureCompact = (...args) => {
    args[7] = (m, context, options) => {
      assert.ok(context.systemPrompt.endsWith(mod.SUMMARY_INSTRUCTIONS));
      const record = { stage, history: JSON.stringify(context.messages).includes('## Critical Context'), policyInPayload: false };
      report.providerRequests.push(record);
      return ai.streamSimple(m, context, { ...options, onPayload: payload => {
        assert.equal(payload.model, modelId); assert.equal(payload.reasoning?.effort, 'low');
        record.policyInPayload = JSON.stringify(payload).includes(mod.SUMMARY_INSTRUCTIONS.replace(/\n/g, '\\n'));
      } });
    };
    return mod.compactWithInstructions(...args);
  };
  const result = await buildAsyncCompactionResult(prep, model, ctx, 'low', AbortSignal.timeout(300000), captureCompact);
  assert.equal(result.firstKeptEntryId, baseline.firstKeptEntryId);
  assert.equal(hash(JSON.stringify(prep)), prepHash);
  const summaryRequests = report.providerRequests.filter(r => r.stage === stage);
  assert.equal(summaryRequests.length, Number(prep.messagesToSummarize.length > 0) + Number(prep.isSplitTurn && prep.turnPrefixMessages.length > 0));
  assert.ok(summaryRequests.every(r => r.policyInPayload), 'Policy missing from an actual summary payload');
  fs.writeFileSync(path.join(outDir, 'summary.md'), result.summary);
  report.stages.push({ stage, chars: result.summary.length, usage: result.usage }); save();
  console.log(JSON.stringify({ event: 'summary-completed', chars: result.summary.length, requests: summaryRequests.length }));
  // Deliberately omit the original rule file and first draft; continuation depends on the summary.
  await draft('after-compaction', [user('以下为上文压缩摘要：\n' + result.summary), user('继续完成原 ACK 常用命令文档，直接给出正文。')]);
  assert.equal(hash(fs.readFileSync(settingsFile)), settingsHash, 'Daily settings changed');
  assert.equal(hash(fs.readFileSync(sourceFile).subarray(0, frozen.length)), hash(frozen), 'Source session prefix changed');
  report.status = 'generated-needs-semantic-review'; report.elapsedMs = Date.now() - started;
  report.sourceSessionWrites = 0; report.dailySettingsUnchanged = true; save();
  console.log(JSON.stringify({ event: 'completed', status: report.status, requests: report.providerRequests.length, elapsedMs: report.elapsedMs }));
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack || error); save(); process.exitCode = 1;
  console.error(report.error);
} finally { clearInterval(progress); session?.dispose(); }
