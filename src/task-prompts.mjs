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
// pi-chatgpt-web = pi-chat's ChatGPT web models (AcBoter); pi-mimo-web and pi-gemini-web are registered by the same extension. Linked into pi-web's agent
// extensions by pi-chatgpt-web/tools/pi-chat-instance.mjs setup.
const EXTENSION_PROVIDERS = { 'pi-chatgpt-web': 'pi-chatgpt-web/index.ts', 'pi-mimo-web': 'pi-chatgpt-web/index.ts', 'pi-gemini-web': 'pi-chatgpt-web/index.ts' };
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
    const match = option.match(/^(fallback|resume|alternate)=(.+)$/);
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
    } else if (match[1] === 'alternate') {
      if (match[2] !== 'on') throw Error(`计划任务 alternate 只接受 on：${id}`);
      result.alternate = true;
    } else result.resume = modelTriple(match[2], `${id}:resume`);
  }
  if (result.alternate && !result.fallback) throw Error(`计划任务 alternate 需要 fallback：${id}`);
  return result;
}
export const modelKey = m => `${m.provider}/${m.model}/${m.thinkingLevel}`;
// 本次运行的候选顺序 [首选, 次选]。alternate=on 时按 rotationFile 记录的上次首选轮换，
// 选定即写回（失败的那次也算一次，保证两模型轮流）；记录不可读时按标题顺序并返回原因供日志。
export function modelOrder(settings, rotationFile) {
  const pick = m => ({provider: m.provider ?? settings.provider, model: m.model, thinkingLevel: m.thinkingLevel, effort: m.effort ?? m.thinkingLevel});
  const order = [pick(settings)];
  if (settings.fallback) order.push(pick(settings.fallback));
  let note = settings.alternate ? 'alternate' : 'fixed';
  if (settings.alternate && order.length === 2 && rotationFile) {
    try {
      const last = fs.existsSync(rotationFile) ? JSON.parse(fs.readFileSync(rotationFile, 'utf8')).last : null;
      if (last === modelKey(order[0])) order.reverse();
    } catch (error) { note = `alternate-state-unreadable:${error.message}`; }
    fs.mkdirSync(path.dirname(rotationFile), {recursive: true});
    fs.writeFileSync(rotationFile, JSON.stringify({last: modelKey(order[0]), at: new Date().toISOString()}) + '\n');
  }
  return {order, note};
}
// 第一轮就失败（会话里没有任何工具结果、最后一条助手消息是 error）才返回原因；其余返回 null。
// 只有这种情况换次选重发是安全的：没有执行过任何动作，不会重复写入或外发。
export function firstRoundModelFailure(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  const messages = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(e => e?.type === 'message').map(e => e.message);
  if (messages.some(m => m.role === 'toolResult')) return null;
  const last = messages.findLast(m => m.role === 'assistant');
  return last?.stopReason === 'error' ? String(last.errorMessage || 'error').slice(0, 500) : null;
}
// 在同一 pi-web 会话里切到候选模型并读回核对。
export async function switchSessionModel(api, route, m) {
  await api(route, {type: 'set_model', provider: m.provider, modelId: m.model});
  await api(route, {type: 'set_thinking_level', level: m.thinkingLevel});
  const s = (await api(route, {type: 'get_state'})).data;
  if (s?.model?.provider !== m.provider || s?.model?.id !== m.model || s?.thinkingLevel !== m.thinkingLevel) throw Error(`次选模型读回不一致：${modelKey(m)}`);
  return s;
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
