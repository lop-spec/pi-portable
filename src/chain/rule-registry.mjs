#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS = process.env.PI_PORTABLE_DATA
  ? path.join(process.env.PI_PORTABLE_DATA, 'rules.jsonl')
  : path.join(HERE, 'data', 'rules.jsonl');
export const DEFAULT_CLAUDE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'CLAUDE.md');
export const DEFAULT_AGENTS = path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex', 'AGENTS.md');
const SOURCE_LABEL = process.env.PI_RULES_SOURCE_LABEL || 'data/rules.jsonl';
const SYNC_COMMAND = process.env.PI_RULES_SYNC_COMMAND || '(未配置规则同步命令)';
const TARGETS = new Set(['claude', 'codex']);
const RETIRED_EXECUTION_FIELDS = new Set([
  'acc',
  'contractGate',
  'contractTrigger',
  'planMatch',
  'planRequirements',
  'actionPolicy',
  'evidencePolicy',
]);

function normalizedText(value) {
  return String(value || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function finalNewline(value) {
  return normalizedText(value).replace(/\n*$/, '\n');
}

function validateRegex(pattern, label) {
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw new Error(label + ': invalid regex: ' + error.message);
  }
}

export function parseRuleRegistry(rawText, sourcePath = '<memory>') {
  const raw = finalNewline(rawText);
  const rules = [];
  const seen = new Set();
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let rule;
    try {
      rule = JSON.parse(line);
    } catch (error) {
      throw new Error(sourcePath + ':' + (index + 1) + ': invalid JSON: ' + error.message);
    }
    const where = sourcePath + ':' + (index + 1);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(where + ': rule must be an object');
    for (const field of ['id', 'trigger', 'text']) {
      if (typeof rule[field] !== 'string' || !rule[field].trim()) throw new Error(where + ': missing ' + field);
    }
    if (seen.has(rule.id)) throw new Error(where + ': duplicate rule id: ' + rule.id);
    seen.add(rule.id);
    validateRegex(rule.trigger, where + ' trigger');
    for (const field of RETIRED_EXECUTION_FIELDS) {
      if (rule[field] !== undefined) {
        throw new Error(where + ': retired execution metadata is forbidden: ' + field);
      }
    }
    if (rule.alwaysOn !== undefined) {
      if (!Array.isArray(rule.alwaysOn) || !rule.alwaysOn.length) throw new Error(where + ': alwaysOn must be a non-empty array');
      for (const target of rule.alwaysOn) if (!TARGETS.has(target)) throw new Error(where + ': invalid alwaysOn target: ' + target);
      rule.alwaysOn = [...new Set(rule.alwaysOn)];
    } else {
      rule.alwaysOn = [];
    }
    rules.push(rule);
  }
  if (!rules.length) throw new Error(sourcePath + ': registry is empty');
  return {
    sourcePath,
    raw,
    sha256: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
    rules,
  };
}

export function loadRuleRegistry(file = DEFAULT_CORPUS) {
  return parseRuleRegistry(fs.readFileSync(file, 'utf8'), file);
}

export function matchRules(rules, input) {
  const text = String(input || '');
  return rules.map((rule) => {
    let hits = [];
    try {
      hits = text.match(new RegExp(rule.trigger, 'gi')) || [];
    } catch {
      return { rule, h: 0, len: 0 };
    }
    const unique = [...new Set(hits.map((item) => item.toLowerCase()))];
    return {
      rule,
      h: unique.length,
      len: unique.join('').length,
    };
  }).filter((hit) => hit.h > 0).sort((a, b) => (b.h - a.h) || (b.len - a.len));
}

function marker(registry, target) {
  return '<!-- GENERATED RULE PROJECTION; source=' + SOURCE_LABEL +
    '; sha256=' + registry.sha256 + '; rules=' + registry.rules.length +
    '; target=' + target + '; schema=1; DO NOT EDIT -->';
}

function bullet(rule) {
  return '- [' + rule.id + '] ' + rule.text;
}

export function renderClaudeProjection(registry) {
  const always = registry.rules.filter((rule) => rule.alwaysOn.includes('claude'));
  if (!always.length) throw new Error('registry has no claude always-on rules');
  return finalNewline([
    '# lop global execution rules',
    '',
    marker(registry, 'claude'),
    '',
    'This file is a generated projection. Edit only ' + SOURCE_LABEL + '.',
    'Refresh every projection with: ' + SYNC_COMMAND,
    'System, developer, and safety instructions remain higher priority.',
    '',
    '## Soft execution core',
    '',
    ...always.map(bullet),
  ].join('\n'));
}

export function renderCodexProjection(registry) {
  const always = registry.rules.filter((rule) => rule.alwaysOn.includes('codex'));
  if (!always.length) throw new Error('registry has no codex always-on rules');
  return finalNewline([
    '# lop 全局执行规则（生成文件）',
    '',
    marker(registry, 'codex'),
    '',
    '只编辑 ' + SOURCE_LABEL + '，然后运行：' + SYNC_COMMAND,
    '系统、开发者与安全指令优先级更高。',
    '',
    '## 软执行内核',
    '',
    ...always.map(bullet),
  ].join('\n'));
}

export function sameProjection(actual, expected) {
  return finalNewline(actual) === finalNewline(expected);
}

function writeIfChanged(file, expected) {
  let actual = '';
  try { actual = fs.readFileSync(file, 'utf8'); } catch { /* missing target */ }
  if (sameProjection(actual, expected)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '-' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, expected, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
  return true;
}

export function syncRuleProjections({
  write = false,
  corpus = DEFAULT_CORPUS,
  claude = DEFAULT_CLAUDE,
  agents = DEFAULT_AGENTS,
} = {}) {
  const registry = loadRuleRegistry(corpus);
  const expectedClaude = renderClaudeProjection(registry);
  const expectedAgents = renderCodexProjection(registry);
  const currentClaude = fs.existsSync(claude) ? fs.readFileSync(claude, 'utf8') : '';
  const currentAgents = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '';
  const before = {
    claude: sameProjection(currentClaude, expectedClaude),
    codex: sameProjection(currentAgents, expectedAgents),
  };
  const changed = [];
  if (write && writeIfChanged(claude, expectedClaude)) changed.push(claude);
  if (write && writeIfChanged(agents, expectedAgents)) changed.push(agents);
  return {
    ok: write ? true : before.claude && before.codex,
    mode: write ? 'write' : 'check',
    source: corpus,
    sha256: registry.sha256,
    ruleCount: registry.rules.length,
    before,
    changed,
    targets: { claude, agents },
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const write = process.argv.includes('--write');
  const result = syncRuleProjections({ write });
  console.log(JSON.stringify(result));
  if (!write && !result.ok) process.exitCode = 1;
}
