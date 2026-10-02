import fs from 'node:fs';
import path from 'node:path';

export const PROMPTS_START = '<!-- scheduled-prompts:start -->';
export const PROMPTS_END = '<!-- scheduled-prompts:end -->';
function range(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < a || text.indexOf(start, a + start.length) >= 0 || text.indexOf(end, b + end.length) >= 0) {
    throw Error(`任务提示分界缺失、重复或顺序错误：${start}`);
  }
  return [a, b];
}
export function stripTaskPrompts(text) {
  if (!text.includes(PROMPTS_START) && !text.includes(PROMPTS_END)) return text;
  const [a, b] = range(text, PROMPTS_START, PROMPTS_END);
  return text.slice(0, a) + text.slice(b + PROMPTS_END.length);
}
export function taskPrompt(text, id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Error('Invalid task prompt ID');
  const [a, b] = range(text, PROMPTS_START, PROMPTS_END);
  const area = text.slice(a + PROMPTS_START.length, b);
  const start = `<!-- task-prompt:${id} -->`, end = `<!-- /task-prompt:${id} -->`;
  const [c, d] = range(area, start, end);
  const prompt = area.slice(c + start.length, d).trim();
  if (!prompt) throw Error(`任务提示为空：${id}`);
  return prompt;
}
export function loadTaskPrompt(root, id) {
  return taskPrompt(fs.readFileSync(path.join(root, 'data', '长目标清单.md'), 'utf8'), id);
}
const THINKING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Providers a task heading may name that come from an extension, not Pi's built-ins.
// pi-chatgpt-web = pi-chat's ChatGPT web models (AcBoter), linked into pi-web's agent
// extensions by pi-chatgpt-web/tools/pi-chat-instance.mjs setup.
const EXTENSION_PROVIDERS = { 'pi-chatgpt-web': 'pi-chatgpt-web/index.ts' };
/** Extra CLI args so a runner started with --no-extensions still has the task's provider. */
export function providerExtensionArgs(agent, provider) {
  const rel = EXTENSION_PROVIDERS[provider];
  if (!rel) return [];
  const file = path.join(agent, 'extensions', rel);
  if (!fs.existsSync(file)) throw Error(`provider-extension-missing:${provider}:${file}`);
  return ['--extension', file];
}
/** Only the codex account pool is metered by the codex quota reserve. */
export const usesCodexQuota = provider => !(provider in EXTENSION_PROVIDERS);
function modelTriple(value, label) {
  const parts = value.split('/');
  if (parts.length !== 3 || parts.some(x => !/^[a-z0-9][a-z0-9.-]*$/i.test(x)) || !THINKING_LEVELS.has(parts[2])) {
    throw Error(`计划任务模型配置无效：${label}`);
  }
  return {provider: parts[0], model: parts[1], thinkingLevel: parts[2], effort: parts[2]};
}
export function taskModelSettings(text, id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Error('Invalid task prompt ID');
  const [a, b] = range(text, PROMPTS_START, PROMPTS_END);
  const area = text.slice(a + PROMPTS_START.length, b);
  const start = `<!-- task-prompt:${id} -->`;
  const [c] = range(area, start, `<!-- /task-prompt:${id} -->`);
  const headings = area.slice(0, c).match(/^## [^\r\n]+$/gm) || [];
  const heading = headings.at(-1);
  const suffix = heading?.match(/〔([^〕]+)〕\s*$/u)?.[1];
  if (!suffix) throw Error(`计划任务标题缺少模型配置：${id}`);
  const [primary, ...options] = suffix.split(';');
  const result = modelTriple(primary, id);
  const seen = new Set();
  for (const option of options) {
    const match = option.match(/^(fallback|resume)=(.+)$/);
    if (!match || seen.has(match[1])) throw Error(`计划任务模型附加配置无效：${id}`);
    seen.add(match[1]);
    if (match[1] === 'fallback') {
      const parts = match[2].split('/');
      if (parts.length === 3) result.fallback = modelTriple(match[2], `${id}:fallback`);
      else {
        const [model, level, extra] = parts;
        if (extra !== undefined || !/^[a-z0-9][a-z0-9.-]*$/i.test(model || '') || !THINKING_LEVELS.has(level)) throw Error(`计划任务 fallback 无效：${id}`);
        result.fallback = {model, thinkingLevel: level, effort: level};
      }
    } else result.resume = modelTriple(match[2], `${id}:resume`);
  }
  return result;
}
export function loadTaskModelSettings(root, id) {
  const text = fs.readFileSync(path.join(root, 'data', '长目标清单.md'), 'utf8');
  return taskModelSettings(text, id);
}
// The agent dir's CLAUDE.md links to the single global rule file; AGENTS.md is the legacy name.
function globalRulesText(agent) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(agent, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw Error(`全局规则缺失：${path.join(agent, 'CLAUDE.md')}`);
}
// Rules remain a single source of truth; restricted workers receive only relevant sections.
export function globalRuleSection(agent, title) {
  const text = globalRulesText(agent);
  const heading = `## ${title}`;
  const parts = text.split(/^## /m).slice(1);
  const matches = parts.filter(p => p.split(/\r?\n/)[0].trim() === title);
  if (matches.length !== 1) throw Error(`全局规则章节缺失或重复：${heading}`);
  return '## ' + matches[0].trim();
}
export function renderTaskPrompt(template, values) {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw Error(`未知任务提示变量：${key}`);
    return String(values[key]);
  });
}
