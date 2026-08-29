#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}
function config() {
  return {
    enabled: true, scanOnPrompt: false, recordOnStop: true, weeklyEnabled: false,
    maxContextChars: 1000, maxContextBytes: 2048, topK: 4, recallTopK: 12,
    recallCandidateLimit: 150, recallMaxChars: 20000, categoryLeafLimit: 200,
    eventMaxChars: 20, clusterMaxChars: 30, promptMaxChars: 6000,
    answerMaxChars: 6000, lockStaleMinutes: 30, historyRoots: [],
  };
}
function writeConfig(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config(), null, 2) + '\n', 'utf8');
}
function metrics(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function run(executable, args, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const portableHome = path.resolve(arg('--portable-home', process.env.PI_PORTABLE_HOME || ''));
const portableData = path.resolve(arg('--data', process.env.PI_PORTABLE_DATA || ''));
const workspace = path.resolve(arg('--workspace', process.cwd()));
const output = path.resolve(arg('--output', path.join(portableData, 'validation', `${Date.now()}-chain-hard-gates`)));
const nodeExe = path.join(portableHome, 'runtime', 'node.exe');
const cli = path.join(portableHome, 'app', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
const extension = path.join(ROOT, 'src', 'lop-chain.ts');
const memoryUrl = pathToFileURL(path.join(ROOT, 'src', 'chain', 'lop-memory.mjs')).href;
const registryUrl = pathToFileURL(path.join(ROOT, 'src', 'chain', 'rule-registry.mjs')).href;
for (const file of [nodeExe, cli, extension]) if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
fs.mkdirSync(output, { recursive: true });
const memory = await import(memoryUrl);
const { expandPrompt, auditRuleRouting } = await import(pathToFileURL(extension).href);
const registry = await import(registryUrl);

// S2→S3 反事实：基础问题没有候选；个性化同义关联只扩大候选，不改变原意评分。
const expansionRoot = path.join(output, 'expansion-memory');
writeConfig(expansionRoot);
await memory.recordStop({
  session_id: 'expansion-seed', turn_id: 'ssh-seed',
  prompt: '配置两台机器 SSH 双向免密互信',
  last_assistant_message: 'SSH 公钥认证已完成，两个方向的连接验证均成功。',
  transcript_path: '',
}, { dataRoot: expansionRoot, config: config() });
const expansionPrompt = '对端现在互通状态怎么样？';
const expanded = expandPrompt(expansionPrompt);
const baseHistory = await memory.resolveHistory(expansionPrompt, {
  dataRoot: expansionRoot, config: config(), refresh: false, sessionId: 'probe',
});
const expandedHistory = await memory.resolveHistory(expansionPrompt, {
  dataRoot: expansionRoot, config: config(), refresh: false, sessionId: 'probe',
  candidateQuery: expanded.forHistory,
  associationTerms: expanded.historyTerms.join(' '),
  maxFullChars: 2000,
});
const historyExpansionPass = !baseHistory.hit && expandedHistory.hit &&
  expandedHistory.relevance >= 0.82 && [...expandedHistory.summary20].length <= 20 &&
  /SSH|双向|公钥/iu.test(expandedHistory.summary20) && /两个方向|连接验证/iu.test(expandedHistory.full);

// S2→S4 反事实：排障是排查的语义别名；运行集合必须与逐条全语料 oracle 相等。
const corpus = path.join(portableData, 'rules.jsonl');
const loaded = registry.loadRuleRegistry(corpus);
const rulePrompt = '排障 SSH 互通';
const ruleExpanded = expandPrompt(rulePrompt);
const routed = auditRuleRouting(registry, loaded.rules, rulePrompt, ruleExpanded.forRules);
const ruleExpansionPass = routed.pass &&
  routed.fromExpansion.some((hit) => hit.rule.id === '排查') &&
  !routed.base.some((hit) => hit.rule.id === '排查');

// 模型侧反事实：唯一口令只存在于 history full；无历史不得知道，有历史必须回答并通过 usage 门。
const secret = `ORBIT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const recallPrompt = '刚刚 Nebula 项目的验收口令是什么？只回答口令。';
const withRoot = path.join(output, 'with-history');
const withoutRoot = path.join(output, 'without-history');
writeConfig(withRoot); writeConfig(withoutRoot);
async function modelProbe(label, memoryRoot) {
  const metricFile = path.join(output, `${label}-metrics.jsonl`);
  const logFile = path.join(output, `${label}-chain.log`);
  const env = {
    ...process.env,
    PI_PORTABLE_HOME: ROOT,
    PI_PORTABLE_DATA: portableData,
    HOME: portableData,
    USERPROFILE: portableData,
    LOP_MEMORY_HOME: memoryRoot,
    LOP_MEMORY_DISABLE_PI_DISCOVERY: '1',
    PI_CHAIN_METRICS: metricFile,
    PI_CHAIN_LOG: logFile,
    PI_ADVERSARY_TIMEOUT_MS: '500',
    NO_COLOR: '1',
  };
  const result = await run(nodeExe, [
    cli, '--print', '--mode', 'text', '--no-session', '--no-extensions',
    '--extension', extension,
    '--provider', 'codex-bridge', '--model', 'gpt-5.6-sol', '--thinking', 'max',
    '--', recallPrompt,
  ], { cwd: workspace, env });
  const finalMetric = [...metrics(metricFile)].reverse().find((item) => item.s8Pass === true) || null;
  return { ...result, metric: finalMetric };
}
// 先跑无历史；此时随机口令尚未写入任何文件，模型和工具均不可能从磁盘旁路获取。
const withoutHistory = await modelProbe('without', withoutRoot);
await memory.recordStop({
  session_id: 'counterfactual-seed', turn_id: 'nebula-secret',
  prompt: recallPrompt,
  last_assistant_message: `Nebula 项目的验收口令是 ${secret}。`,
  transcript_path: '',
}, { dataRoot: withRoot, config: config() });
const withHistory = await modelProbe('with', withRoot);
const modelUsePass = withoutHistory.status === 0 && withHistory.status === 0 &&
  !withoutHistory.stdout.includes(secret) && withHistory.stdout.includes(secret) &&
  withoutHistory.metric?.s3Hit === false && withHistory.metric?.s3Hit === true &&
  withHistory.metric?.s3UsagePass === true && withHistory.metric?.s3UsageDisposition === 'used';

const report = {
  schemaVersion: 1,
  at: new Date().toISOString(),
  pass: historyExpansionPass && ruleExpansionPass && modelUsePass,
  historyExpansion: {
    pass: historyExpansionPass,
    prompt: expansionPrompt,
    charRatio: expanded.charRatio,
    terms: expanded.historyTerms,
    base: { hit: baseHistory.hit, reason: baseHistory.reason },
    expanded: {
      hit: expandedHistory.hit, reason: expandedHistory.reason,
      eventId: expandedHistory.eventId, relevance: expandedHistory.relevance,
      summary20: expandedHistory.summary20, full: expandedHistory.full,
    },
  },
  ruleExpansion: {
    pass: ruleExpansionPass,
    prompt: rulePrompt,
    charRatio: ruleExpanded.charRatio,
    baseIds: routed.base.map((hit) => hit.rule.id),
    fromExpansionIds: routed.fromExpansion.map((hit) => hit.rule.id),
    actualIds: routed.actualIds,
    oracleIds: routed.oracleIds,
  },
  modelUseCounterfactual: {
    pass: modelUsePass,
    prompt: recallPrompt,
    secret,
    withoutHistory,
    withHistory,
  },
};
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ pass: report.pass, report: path.join(output, 'report.json'), historyExpansionPass, ruleExpansionPass, modelUsePass }, null, 2));
if (!report.pass) process.exitCode = 1;
