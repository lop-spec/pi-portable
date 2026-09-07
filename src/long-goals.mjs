import fs from 'node:fs';
export const GOALS_FILENAME = '长目标清单.md';

// Only real level-two checklist headings opt in; fenced examples are never tasks.
export function parseLongGoals(markdown) {
  const text = markdown.replace(/^\uFEFF/u, '').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, '');
  const blocks = text.split(/^##\s+/mu).slice(1), goals = [], keys = new Set();
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u), heading = lines.shift().trim();
    const match = heading.match(/^\[([ xX])\]\s+(.+)$/u);
    if (!match) throw Error(`长目标标题格式错误：${heading}`);
    if (match[1] !== ' ') continue;
    const fields = new Map();
    for (const line of lines) {
      const field = line.match(/^-\s*(标识|目录|来源会话|目标|验收)：\s*(.*)$/u);
      if (!field) continue;
      if (fields.has(field[1])) throw Error(`重复字段：${match[2]} / ${field[1]}`);
      fields.set(field[1], field[2].trim().replace(/^`(.*)`$/u, '$1'));
    }
    for (const key of ['标识', '目录', '目标', '验收']) if (!fields.get(key)) throw Error(`长目标缺少${key}：${match[2]}`);
    const key = fields.get('标识');
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(key) || keys.has(key)) throw Error(`长目标标识不合法或重复：${key}`);
    const cwd = fields.get('目录');
    if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(cwd)) throw Error(`目录必须是绝对路径：${match[2]}`);
    keys.add(key);
    goals.push({ key, title: match[2], cwd, sourceId: fields.get('来源会话') || '', objective: fields.get('目标'), acceptance: fields.get('验收') });
  }
  return goals;
}

export function loadLongGoals(file, log) {
  try {
    const goals = parseLongGoals(fs.readFileSync(file, 'utf8'));
    log('long-goals-loaded', { file, enabled: goals.length }); return goals;
  } catch (error) {
    // A bad/absent fixed-goal list must not disable unrelated recent P0/P1 tasks.
    log('long-goals-unavailable', { file, reason: error.message, action: 'skip-fixed-only; keep-recent-P0-P1' }); return [];
  }
}
