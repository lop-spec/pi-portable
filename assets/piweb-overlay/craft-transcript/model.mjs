// Pi adapter for Craft's WorkLog/ActivityRow contract. Never mutates persisted messages.
import { extractChineseSource, toolChineseExcerpts } from '../tool-excerpts/tool-chinese-excerpts.mjs';

// Pick one contiguous Chinese clause, never join words across code or numbers.
// Prefer a complete short clause over cutting a long one at an arbitrary character.
function chineseLine(text) {
  for (const line of text.slice(0, 4096).split(/\r?\n/u)) {
    if (/[/\\{}=]|(?:密码|密钥|口令|所在位置|字符[:：]|authorization|token|secret|cookie)/iu.test(line)) continue;
    for (const part of line.split(/[，。！？；：、·,;:!?]/u)) {
      const clause = part.trim();
      if (/^\p{Script=Han}{2,32}$/u.test(clause)) return clause;
    }
  }
  return '';
}
const actions = [
  [/read.*file|^read$/, '读取文件'], [/edit|apply_patch|write/, '修改文件'],
  [/search|grep|find/, '检索内容'], [/bash|run_commands|terminal|shell|exec/, '运行命令'],
  [/browser|web|fetch/, '查阅网页'], [/question|ask/, '询问选择'], [/wait/, '等待结果'],
  [/image/, '处理图片'], [/sql|mongo|redis|aliyun|k8s|sls|^es_/, '查询数据'], [/^ls$/, '查看目录'],
];
const resultExcerpts = new WeakMap();
function chineseResult(result) {
  if (!result || typeof result !== 'object') return '';
  if (resultExcerpts.has(result)) return resultExcerpts.get(result);
  const paragraphs = toolChineseExcerpts(result).flatMap(phrase=>phrase.split(/\r?\n/u)).map(line=>{
    if (/^\s*[\[{]|(?:所在位置|字符[:：])/u.test(line)) return '';
    return line.replace(/(?:[a-z]:[\\/]|https?:\/\/|(?:\/|\\)[\w.])[^\s，。；！、）】]+/giu,'')
      .replace(/[^\p{Script=Han}，。！？；：、（）【】《》“”‘’…\s]/gu,'')
      .replace(/\s+/gu,' ').trim().replace(/^[，。！？；：、\s]+/u,'');
  }).filter(line=>/\p{Script=Han}/u.test(line));
  const excerpt = [...new Set(paragraphs)].join('\n');
  resultExcerpts.set(result, excerpt);
  return excerpt;
}
const labelKey = text => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
function rowLabel(block, description, excerpt, phaseTitle) {
  const title = labelKey(phaseTitle);
  const distinct = label => label && labelKey(label) !== title;
  // Skip echoed stage titles in output as well as in call descriptions.
  for (const line of excerpt.split('\n')) {
    if (!distinct(line)) continue;
    const preview = chineseLine(line) || [...line.matchAll(/\p{Script=Han}/gu)].slice(0,32).map(m=>m[0]).join('');
    if (distinct(preview)) return preview;
  }
  for (const phrase of description.split(' · ')) {
    if (!distinct(phrase)) continue;
    const preview = chineseLine(phrase);
    if (distinct(preview)) return preview;
  }
  const action = actions.find(([pattern])=>pattern.test(String(block.toolName).toLowerCase()))?.[1];
  return [action,'处理请求','查看结果'].find(distinct);
}

// Read only public descriptions, command literals and comments. Never walk arbitrary
// payloads (editor text, credentials, URLs or private reasoning are not summaries).
export function callExcerpt(args = {}) {
  const phrases = new Set();
  const add = text => {
    if (typeof text !== 'string') return;
    for (const phrase of extractChineseSource(text)) {
      if (phrases.size < 3) phrases.add(phrase.slice(0, 180));
    }
  };
  for (const key of ['_intent', 'description', 'task', 'question']) add(args?.[key]);
  const commands = Array.isArray(args?.commands) ? args.commands : [args?.command];
  for (const cmd of commands) {
    if (typeof cmd !== 'string' || phrases.size >= 3) continue;
    for (const line of cmd.split(/\r?\n/u)) {
      if (phrases.size >= 3) break;
      if (/password|passwd|secret|authorization|token|api[_-]?key|cookie|密码|密钥|口令|reasoning|thinking|analysis/iu.test(line)) continue;
      // Preserve complete quoted phrases, not the surrounding shell program.
      for (const m of line.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(?:^|\s)#\s*(.*)$/gu)) {
        const value = m[1] ?? m[2] ?? m[3];
        if (/[\\/]/u.test(value) || /[${}]/u.test(value)) continue;
        add(value);
      }
    }
  }
  return [...phrases].join(' · ');
}

export function toolState(result, live, end) {
  if (!result) return live ? 'running' : end?.status === 'stopped' ? 'stopped' : 'unknown';
  const d = result.details;
  if (result.isError || (typeof d?.exitCode === 'number' && d.exitCode !== 0) || d?.status === 'error' || d?.status === 'failed') return 'error';
  return 'completed';
}
export function toolSummary(block) {
  const args = block.input ?? {};
  const name = block.chatView?.callExcerpt ?? callExcerpt(args);
  const intent = typeof args._intent === 'string' ? args._intent : typeof args.description === 'string' ? args.description : '';
  const input = ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'action'].map(key => typeof args[key] === 'string' ? args[key] : '').filter(Boolean).join(' ');
  return { name, intent, input };
}
export function projectCraftTurn(entries, toolResults, live = false, end) {
  const activities = [], responses = [], nodes = [];
  for (const entry of entries) {
    if (entry.kind !== 'assistant') { nodes.push(entry); continue; }
    entry.message.content.forEach((block, index) => {
      if (block.type === 'thinking') return;
      const base = { id: `${entry.entryId ?? entry.key}:${index}`, entryId: entry.entryId, block, timestamp: entry.message.timestamp };
      if (block.type === 'toolCall') {
        const result = toolResults.get(block.toolCallId);
        const summary = toolSummary(block);
        const excerpt = chineseResult(result);
        activities.push({ ...base, id: block.toolCallId, type: 'tool', result, excerpt, status: toolState(result, live, end), ...summary });
      } else if (block.type === 'text' && block.text.trim()) activities.push({ ...base, type: 'intermediate', status: 'completed', name: block.text.replace(/\s+/g, ' '), intent: '', input: '' });
    });
  }
  // Like Craft, the trailing streamed answer is outside the work log. Earlier
  // commentary remains a compact activity once subsequent tool activity arrives.
  if (live) while (activities.at(-1)?.type === 'intermediate') responses.unshift(activities.pop());
  const phases = groupPhases(activities, live, end);
  for (const phase of phases) {
    for (const item of phase.items) {
      if (item.type === 'tool') item.name = rowLabel(item.block, item.name, item.excerpt, phase.name);
    }
  }
  return { activities, phases, responses, nodes, failedCount: activities.filter(a => a.status === 'error').length };
}

// Phase markers are supplied only at a change of work, not inferred from commands.
// Old calls and unmarked work stay in one neutral group; all records are retained.
export function groupPhases(activities, live = false, end) {
  const phases = [];
  let current;
  for (const activity of activities) {
    const marker = activity.type === 'tool' && typeof activity.block.input?._phase === 'string' ? activity.block.input._phase.replace(/\s+/g, ' ').trim() : '';
    if (marker && current?.name !== marker) {
      if (current?.fallback && current.items.every(item => item.type === 'intermediate')) {
        current.name = marker; current.fallback = false;
      } else {
        current = { id: activity.id, name: marker, items: [], fallback: false };
        phases.push(current);
      }
    }
    if (!current) {
      current = { id: activity.id, name: '处理这项任务', items: [], fallback: true };
      phases.push(current);
    }
    current.items.push(activity);
  }
  return phases.map((phase, index) => {
    const tools = phase.items.filter(item => item.type === 'tool');
    const last = index === phases.length - 1;
    const missing = tools.filter(item => !item.result);
    const errors = tools.filter(item => item.status === 'error').length;
    const waiting = live && missing.some(item => item.block.toolName === 'AskUserQuestion');
    // A successful later command cannot prove an earlier error was repaired.
    // Non-blocking errors stay in details, and the phase is merely "ended".
    const status = waiting ? 'waiting' : live && (last || missing.length) ? 'running'
      : last && end?.status === 'error' ? 'blocked' : last && end?.status === 'stopped' ? 'stopped'
      : missing.length ? 'unknown' : errors ? 'finished' : 'completed';
    return { ...phase, status, errors, toolCount: tools.length };
  });
}
