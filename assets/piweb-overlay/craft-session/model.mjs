// Workflow labels and glyphs follow Craft Agents (Apache-2.0), a883d64.
export const STATUSES = Object.freeze([
  { id: 'backlog', label: '积压' },
  { id: 'todo', label: '待办' },
  { id: 'needs-review', label: '待审查' },
  { id: 'done', label: '完成' },
  { id: 'cancelled', label: '已取消' },
]);
export const DEFAULT_STATUS = 'todo';
export function validStatus(value) { return STATUSES.some(item => item.id === value); }
export function statusOf(records, id) { return validStatus(records[id]?.status) ? records[id].status : DEFAULT_STATUS; }
// Legacy non-default statuses were explicitly assigned; flag-only todo records were not.
export function hasAssignedStatus(records, id) {
  const value = records[id];
  return value?.statusAssigned === true || (validStatus(value?.status) && value.status !== DEFAULT_STATUS);
}
export function isFlagged(records, id) { return records[id]?.flagged === true; }
export function dateGroup(value, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (+day === +today) return '今天';
  if (+day === +yesterday) return '昨天';
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
export function matchesFilter(records, id, filter) {
  return filter === 'all' || filter === 'archived' || (filter === 'flagged' ? isFlagged(records, id) : statusOf(records, id) === filter);
}

/** @template {{id: string, modified: string, created: string}} T @param {T[]} sessions @param {Record<string, {status?: string, flagged?: boolean}>} records @param {string} filter @param {Date} [now] @returns {{label: string, items: T[]}[]} */
export function groupedSessions(sessions, records, filter, now = new Date()) {
  const grouped = new Map();
  for (const session of [...sessions].filter(item => matchesFilter(records, item.id, filter)).sort((a, b) => (Date.parse(b.modified) || Date.parse(b.created) || 0) - (Date.parse(a.modified) || Date.parse(a.created) || 0) || a.id.localeCompare(b.id))) {
    const label = dateGroup(session.modified || session.created, now);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(session);
  }
  return [...grouped].map(([label, items]) => ({ label, items }));
}
