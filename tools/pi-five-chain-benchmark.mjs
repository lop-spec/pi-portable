#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE_PATH = path.join(ROOT, 'benchmarks', 'gpt-five-task-baseline.json');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}
function has(name) { return process.argv.includes(name); }
function stamp() {
  const d = new Date();
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function runDirect(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error) : '',
  };
}
function runProcess(executable, args, options = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      runDirect('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 });
    }, options.timeout || 180000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
        elapsedMs: +(performance.now() - started).toFixed(1),
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: stderr + String(error), elapsedMs: +(performance.now() - started).toFixed(1) });
    });
  });
}
function metricLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function sameIds(left, right) {
  const a = [...new Set(left || [])].map(String).sort();
  const b = [...new Set(right || [])].map(String).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function stageGate(task, metric) {
  const current = {
    initialModelMs: Number(metric.initialModelMs || 0),
    followupModelMs: Number(metric.followupModelMs || 0),
    toolCriticalMs: Number(metric.toolMs || 0),
    finalizeMs: Number(metric.s8Ms || 0),
  };
  const checks = [];
  for (const [stage, historical] of Object.entries(task.stages)) {
    if (Number(historical) <= 1000) continue;
    const target = Number(historical) * 0.5;
    checks.push({
      stage,
      historicalMs: historical,
      targetExclusiveMs: target,
      currentMs: current[stage],
      pass: Number.isFinite(current[stage]) && current[stage] >= 0 && current[stage] < target,
    });
  }
  return { pass: checks.every((item) => item.pass), current, checks };
}
function outputGate(task, output, facts) {
  const text = String(output || '');
  if (task.id === 't1') return facts.syntaxStatus === 0 && /通过|成功|正常|exit\s*0|退出码\s*0/iu.test(text);
  if (task.id === 't2') return fs.readFileSync(facts.acceptanceFile, 'utf8').trim() === 'beta' && /beta/iu.test(text);
  if (task.id === 't3') return /JSONL/iu.test(text) && /JSON\b/iu.test(text) && /每行|逐行|line/iu.test(text) && /完整|整体|文档|object|array/iu.test(text);
  if (task.id === 't4') return text.replace(/(?<=\d)[,_](?=\d)/gu, '').includes(String(facts.syncBytes));
  if (task.id === 't5') return facts.syncCheckStatus === 0 ? /通过|成功/iu.test(text) : /未通过|失败|不通过/iu.test(text);
  return false;
}

const baseline = readJson(BASELINE_PATH);
assert.equal(baseline.tasks.length, 5);
assert.deepEqual(baseline.tasks.map((task) => task.rank), [1, 2, 3, 4, 5]);
assert.equal(baseline.thresholdMs, 1000);
assert.equal(baseline.targetRatio, 0.5);
if (has('--dry-run')) {
  console.log(JSON.stringify({ pass: true, tasks: baseline.tasks.map(({ id, rank, type, expectedRuleIds }) => ({ id, rank, type, expectedRuleIds })) }, null, 2));
  process.exit(0);
}

const portableHome = path.resolve(arg('--portable-home', process.env.PI_PORTABLE_HOME || ''));
const portableData = path.resolve(arg('--data', process.env.PI_PORTABLE_DATA || ''));
const workspace = path.resolve(arg('--workspace', process.env.CODE_LITE_CONFIG_ROOT || ''));
const cycles = Math.max(1, Math.min(5, Number(arg('--cycles', '2')) || 2));
const taskFilter = arg('--task', '');
const selectedTasks = taskFilter
  ? baseline.tasks.filter((task) => task.id === taskFilter)
  : baseline.tasks;
if (!selectedTasks.length) throw new Error(`unknown --task ${taskFilter}`);
const thinking = arg('--thinking', 'max');
const bridgePort = Math.max(0, Number(arg('--bridge-port', '0')) || 0);
const upstreamProxyPort = Math.max(0, Number(arg('--upstream-proxy-port', process.env.CODEX_UPSTREAM_PROXY_PORT || '0')) || 0);
const outputRoot = path.resolve(arg('--output', path.join(portableData, 'validation', `${stamp()}-pi-five-chain`)));
const memoryRoot = path.join(outputRoot, 'memory');
const metricsFile = path.join(outputRoot, 'chain-metrics.jsonl');
const logFile = path.join(outputRoot, 'lop-chain.log');
const nodeExe = path.join(portableHome, 'runtime', 'node.exe');
const cli = path.join(portableHome, 'app', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
const extension = path.join(ROOT, 'src', 'lop-chain.ts');
const memoryModule = path.join(ROOT, 'src', 'chain', 'lop-memory.mjs');
const syncFile = path.join(workspace, 'tools', 'sync.mjs');
const acceptanceFile = path.join(workspace, '.lop-acceptance', 'unified-chain.txt');
for (const required of [nodeExe, cli, extension, memoryModule, syncFile]) {
  if (!required || !fs.existsSync(required)) throw new Error(`required path missing: ${required}`);
}
fs.mkdirSync(memoryRoot, { recursive: true });
fs.mkdirSync(path.dirname(acceptanceFile), { recursive: true });
let benchmarkBridge = null;
let bridgeLog = null;
let agentDir = '';
if (bridgePort > 0) {
  agentDir = path.join(outputRoot, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const sourceAgentDir = path.join(portableData, '.pi', 'agent');
  for (const name of ['settings.json', 'AGENTS.md']) {
    fs.copyFileSync(path.join(sourceAgentDir, name), path.join(agentDir, name));
  }
  const models = fs.readFileSync(path.join(sourceAgentDir, 'models.json'), 'utf8')
    .replace(/127\.0\.0\.1:8794/gu, `127.0.0.1:${bridgePort}`);
  fs.writeFileSync(path.join(agentDir, 'models.json'), models, 'utf8');
  const bridgeData = path.join(outputRoot, 'bridge-data');
  fs.mkdirSync(bridgeData, { recursive: true });
  bridgeLog = fs.openSync(path.join(outputRoot, 'bridge-process.log'), 'a');
  benchmarkBridge = spawn(nodeExe, [path.join(ROOT, 'src', 'bridge', 'codex-responses-proxy.mjs')], {
    env: {
      ...process.env,
      PI_PORTABLE_DATA: bridgeData,
      CODEX_PROXY_PORT: String(bridgePort),
      ...(upstreamProxyPort ? {
        CODEX_UPSTREAM_PROXY_HOST: '127.0.0.1',
        CODEX_UPSTREAM_PROXY_PORT: String(upstreamProxyPort),
      } : {}),
    },
    windowsHide: true,
    stdio: ['ignore', bridgeLog, bridgeLog],
  });
  process.on('exit', () => { try { benchmarkBridge?.kill(); } catch {} });
  let healthy = false;
  for (let attempt = 0; attempt < 50 && !healthy; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(500) });
      healthy = response.ok;
    } catch {}
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) throw new Error(`benchmark bridge did not listen on ${bridgePort}`);
}
writeJson(path.join(memoryRoot, 'config.json'), {
  enabled: true,
  scanOnPrompt: false,
  recordOnStop: true,
  weeklyEnabled: false,
  profile: '极致性能、单一真值、真实运行验收、最小改动、先日志后代码、可回滚、低Token、按需加载',
  maxContextChars: 1000,
  maxContextBytes: 2048,
  topK: 4,
  recallTopK: 12,
  recallCandidateLimit: 150,
  recallMaxChars: 20000,
  categoryLeafLimit: 200,
  eventMaxChars: 20,
  clusterMaxChars: 30,
  promptMaxChars: 6000,
  answerMaxChars: 6000,
  lockStaleMinutes: 30,
  historyRoots: [],
});
const env = {
  ...process.env,
  // CLI/runtime 来自已安装便携包；扩展的受测代码与 chain 依赖必须锁定当前仓库。
  PI_PORTABLE_HOME: ROOT,
  PI_PORTABLE_DATA: portableData,
  HOME: portableData,
  USERPROFILE: portableData,
  LOP_MEMORY_HOME: memoryRoot,
  LOP_MEMORY_DISABLE_PI_DISCOVERY: '1',
  ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  PI_CHAIN_METRICS: metricsFile,
  PI_CHAIN_LOG: logFile,
  PI_ADVERSARY_TIMEOUT_MS: '30000',
  NO_COLOR: '1',
};
Object.assign(process.env, env);
const syntaxOracle = runDirect(nodeExe, ['--check', syncFile], { cwd: workspace, env });
const syncCheckOracle = runDirect(nodeExe, [syncFile, '--check'], { cwd: workspace, env, timeout: 120000 });
const syncBytes = fs.statSync(syncFile).size;
const syncHash = sha256(syncFile);
const facts = {
  syntaxStatus: syntaxOracle.status,
  syncCheckStatus: syncCheckOracle.status,
  syncBytes,
  syncHash,
  acceptanceFile,
};
const memory = await import(pathToFileURL(memoryModule).href + `?seed=${Date.now()}`);
const seedAnswers = {
  t1: `已用 node --check 只读验证 tools/sync.mjs，退出码 ${syntaxOracle.status}；文件未修改。`,
  t2: '仅将 .lop-acceptance/unified-chain.txt 中的 alpha 改为 beta，读回为 beta。',
  t3: 'JSON：完整单值，用于配置；JSONL：每行独立值，用于流式日志。',
  t4: `tools/sync.mjs 的只读文件大小为 ${syncBytes} 字节，未修改。`,
  t5: syncCheckOracle.status === 0 ? '通过。' : '未通过。',
};
for (const task of baseline.tasks) {
  const saved = await memory.recordStop({
    session_id: 'pi-five-chain-seed',
    turn_id: `seed-${task.id}`,
    prompt: task.prompt,
    last_assistant_message: seedAnswers[task.id],
    transcript_path: '',
  });
  if (!saved?.canonical?.saved || !saved?.canonical?.derived) throw new Error(`seed failed for ${task.id}: ${JSON.stringify(saved)}`);
}
const initialStatus = runDirect('git.exe', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspace, env }).stdout;
const initialTrackedDiff = runDirect('git.exe', ['diff', '--no-ext-diff', '--binary'], { cwd: workspace, env }).stdout;
const initialStagedDiff = runDirect('git.exe', ['diff', '--cached', '--no-ext-diff', '--binary'], { cwd: workspace, env }).stdout;
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  baseline: BASELINE_PATH,
  portableHome,
  portableData,
  workspace,
  outputRoot,
  model: 'codex-bridge/gpt-5.6-sol',
  thinking,
  bridgePort: bridgePort || 8794,
  isolatedBridge: Boolean(bridgePort),
  upstreamProxyPort,
  cycles: [],
  facts: { ...facts, acceptanceFile: path.relative(workspace, acceptanceFile) },
};
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const cycleResult = { cycle, tasks: [], pass: true };
  for (const task of selectedTasks) {
    if (task.id === 't2') fs.writeFileSync(acceptanceFile, 'alpha\n', 'utf8');
    const metricBefore = metricLines(metricsFile).length;
    const command = [
      cli,
      '--print', '--mode', 'text', '--no-session', '--no-extensions',
      '--extension', extension,
      '--provider', 'codex-bridge', '--model', 'gpt-5.6-sol', '--thinking', thinking,
      '--', task.prompt,
    ];
    const execution = await runProcess(nodeExe, command, { cwd: workspace, env, timeout: 180000 });
    const allMetrics = metricLines(metricsFile);
    const newMetrics = allMetrics.slice(metricBefore);
    const finalMetric = [...newMetrics].reverse().find((item) => item.s8Pass === true && item.prompt === task.prompt.slice(0, 160)) || null;
    const stage = finalMetric ? stageGate(task, finalMetric) : { pass: false, current: {}, checks: [] };
    const correctness = outputGate(task, execution.stdout, facts);
    const hardGates = Boolean(finalMetric &&
      finalMetric.s2Pass === true && Number(finalMetric.s2Ratio) >= 3 &&
      finalMetric.s3Hit === true && finalMetric.s3UsagePass === true &&
      finalMetric.s4Pass === true && sameIds(finalMetric.s4Live, task.expectedRuleIds) &&
      sameIds(finalMetric.s4Live, finalMetric.s4Oracle) &&
      Array.isArray(finalMetric.modelTurns) && finalMetric.modelTurns.length > 0 &&
      Number(finalMetric.initialModelMs) > 0 &&
      (task.id === 't3' || Number(finalMetric.toolMs) > 0) &&
      finalMetric.s8Pass === true && finalMetric.s8CanonicalDerived === true);
    const sourceUnchanged = sha256(syncFile) === syncHash;
    // 用户口径：第一轮是当前链预热/校准；从第二轮开始才强制历史最佳值的严格 50% 门。
    const performanceEnforced = cycle >= 2;
    const taskPass = execution.status === 0 && correctness && hardGates && sourceUnchanged &&
      (!performanceEnforced || stage.pass);
    const item = {
      id: task.id,
      rank: task.rank,
      type: task.type,
      pass: taskPass,
      processStatus: execution.status,
      elapsedMs: execution.elapsedMs,
      correctness,
      hardGates,
      sourceUnchanged,
      performanceEnforced,
      stage,
      metric: finalMetric,
      metricEvents: newMetrics,
      stdout: execution.stdout.trim(),
      stderr: execution.stderr.trim(),
    };
    cycleResult.tasks.push(item);
    if (!taskPass) cycleResult.pass = false;
    writeJson(path.join(outputRoot, `cycle-${cycle}-${task.id}.json`), item);
    console.log(JSON.stringify({ cycle, id: task.id, pass: taskPass, elapsedMs: execution.elapsedMs, correctness, hardGates, stage }));
  }
  report.cycles.push(cycleResult);
}
const finalStatus = runDirect('git.exe', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspace, env }).stdout;
const finalTrackedDiff = runDirect('git.exe', ['diff', '--no-ext-diff', '--binary'], { cwd: workspace, env }).stdout;
const finalStagedDiff = runDirect('git.exe', ['diff', '--cached', '--no-ext-diff', '--binary'], { cwd: workspace, env }).stdout;
const statusAdded = finalStatus.split(/\r?\n/u).filter(Boolean).filter((line) => !initialStatus.includes(line));
const unexpectedStatus = statusAdded.filter((line) => !line.includes('.lop-acceptance/unified-chain.txt'));
report.workspaceStatus = {
  initial: initialStatus,
  final: finalStatus,
  unexpectedAdded: unexpectedStatus,
  trackedDiffUnchanged: finalTrackedDiff === initialTrackedDiff,
  stagedDiffUnchanged: finalStagedDiff === initialStagedDiff,
};
report.completedAt = new Date().toISOString();
report.pass = report.cycles.every((cycle) => cycle.pass) && unexpectedStatus.length === 0 &&
  report.workspaceStatus.trackedDiffUnchanged && report.workspaceStatus.stagedDiffUnchanged;
writeJson(path.join(outputRoot, 'report.json'), report);
console.log(JSON.stringify({ pass: report.pass, report: path.join(outputRoot, 'report.json'), unexpectedStatus }, null, 2));
if (benchmarkBridge) {
  benchmarkBridge.kill();
  if (bridgeLog !== null) fs.closeSync(bridgeLog);
}
if (!report.pass) process.exitCode = 1;
