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
const resultExcerpts = new WeakMap();
function chineseResult(result) {
  if (!result || typeof result !== 'object') return '';
  if (resultExcerpts.has(result)) return resultExcerpts.get(result);
  const paragraphs = toolChineseExcerpts(result).flatMap(phrase=>phrase.split(/\r?\n/u)).map(line=>{
    if (/^\s*[\[{]|(?:所在位置|字符[:：])/u.test(line)) return '';
    return line.replace(/(?:[a-z]:[\\/]|https?:\/\/|(?:\/|\\)[\w.])[^\s，。；！、）】]+/giu,'')
      .replace(/[^\p{Script=Han}，。！？；：、（）【】《》“”‘’…]/gu,'')
      .replace(/^[，。！？；：、]+/u,'');
  }).filter(line=>/\p{Script=Han}/u.test(line));
  const excerpt = [...new Set(paragraphs)].join('\n');
  resultExcerpts.set(result, excerpt);
  return excerpt;
}
const labelKey = text => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
function rowLabel(excerpt, title) {
  const distinct = label => label && labelKey(label) !== title;
  let first = '';
  // Skip echoed stage titles, but only inspect as many Han characters as the
  // row can show. The full excerpt is still available in the detail dialog.
  for (const line of excerpt.split('\n')) {
    if (!line) continue;
    let preview = chineseLine(line);
    if (!preview) {
      let count = 0;
      for (const match of line.matchAll(/\p{Script=Han}/gu)) {
        preview += match[0];
        if (++count === 32) break;
      }
    }
    first ||= preview;
    if (distinct(preview) && distinct(line)) return preview;
  }
  return first;
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
// Tool blocks are immutable snapshots. Reuse a preview only for the same
// result and phase, since either can change during a live reply.
const labels = new WeakMap();

export function projectCraftTurn(entries, toolResults, live = false, end) {
  const activities = [], responses = [], nodes = [];
  for (const entry of entries) {
    if (entry.kind !== 'assistant') { nodes.push(entry); continue; }
    entry.message.content.forEach((block, index) => {
      if (block.type === 'thinking') return;
      const base = { id: `${entry.entryId ?? entry.key}:${index}`, entryId: entry.entryId, block, timestamp: entry.message.timestamp };
      if (block.type === 'toolCall') {
        const result = toolResults.get(block.toolCallId);
        const excerpt = chineseResult(result);
        activities.push({ ...base, id: block.toolCallId, type: 'tool', result, excerpt, name: '', status: toolState(result, live, end), streaming: entry.streaming });
      } else if (block.type === 'text' && block.text.trim()) activities.push({ ...base, type: 'intermediate', status: 'completed', name: block.text.replace(/\s+/g, ' ') });
    });
  }
  // Like Craft, the trailing streamed answer is outside the work log. Earlier
  // commentary remains a compact activity once subsequent tool activity arrives.
  if (live) {
    let i = activities.length;
    while (i > 0 && activities[i - 1].type === 'intermediate') i--;
    for (let j = i; j < activities.length; j++) responses.push(activities[j]);
    activities.length = i;
  }
  const phases = groupPhases(activities, live, end);
  // Preserve phase boundaries/status and raw outputs, but project a single allowlist
  // for the visible list, its count, search targets and detail selections.
  const visiblePhases = [], visibleActivities = [];
  for (const phase of phases) {
    const title = labelKey(phase.name), items = [];
    for (const item of phase.items) {
      if (item.type === 'tool') {
        if (!item.excerpt) continue;
        const cached = item.streaming ? undefined : labels.get(item.block);
        if (cached && cached.title === title && cached.result === item.result) {
          item.name = cached.name;
        } else {
          item.name = rowLabel(item.excerpt, title);
          if (!item.streaming) labels.set(item.block, { title, result: item.result, name: item.name });
        }
      }
      items.push(item);
      visibleActivities.push(item);
    }
    if (items.length) visiblePhases.push({ id: phase.id, name: phase.name, status: phase.status, items });
  }
  return { activities, phases, visiblePhases, visibleActivities, responses, nodes, failedCount: activities.filter(a => a.status === 'error').length };
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
