// 过程折叠行的摘要（取自 cc-haha 的「思考 4 次、运行 4 条命令… 3m41s」）：
// 「6 个步骤已完成」改成「6 个步骤 · 读取 1 · 编辑 2 · 命令 1 · 用时 21 秒」，不展开就能看出这一轮做了什么。
// 纯函数；按工具名归类，只列数量最多的前 4 类，其余并入「其他」。

const GROUPS = Object.freeze([
  ['命令', /bash|shell|exec|powershell|terminal/],
  ['网页', /browser|web|fetch|http|curl/],
  ['读取', /read|view|cat\b/],
  ['编辑', /write|edit|patch|apply/],
  ['搜索', /grep|find|glob|search|\bls\b/],
]);
const MAX_GROUPS = 4;

/** @param {string} toolName */
export function toolGroup(toolName) {
  const name = String(toolName || '').toLowerCase();
  return GROUPS.find(([, pattern]) => pattern.test(name))?.[0] ?? '其他';
}

/** @param {number} ms */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/**
 * @param {readonly { type?: string, block?: { type?: string, toolName?: string } }[]} activities
 * @param {number | undefined} startedAt 毫秒时间戳
 * @param {number | undefined} endedAt 毫秒时间戳
 * @returns {string} 例如「读取 1 · 编辑 2 · 命令 1 · 用时 21 秒」；没有可说的内容时返回空串
 */
export function timelineBreakdown(activities, startedAt, endedAt) {
  const counts = new Map();
  for (const activity of activities) {
    if (activity?.type === 'intermediate' || activity?.block?.type !== 'toolCall') continue;
    const group = toolGroup(activity.block.toolName);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const order = [...GROUPS.map(([label]) => label), '其他'];
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));
  const shown = ranked.slice(0, MAX_GROUPS);
  const rest = ranked.slice(MAX_GROUPS).reduce((sum, [, count]) => sum + count, 0);
  const parts = shown.map(([label, count]) => `${label} ${count}`);
  if (rest > 0) parts.push(`其他 ${rest}`);
  const elapsed = typeof startedAt === 'number' && typeof endedAt === 'number' ? formatElapsed(endedAt - startedAt) : '';
  if (elapsed) parts.push(`用时 ${elapsed}`);
  return parts.join(' · ');
}
