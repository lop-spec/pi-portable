// Recent tasks are a view over project families, never a second physical classification.
export const RECENT_TASK_LIMIT = 10;
export const RECENT_TASK_VISIBLE = 5;
/**
 * @template {{root: {id: string, modified: string, created: string}, subagents: {id: string}[]}} T
 * @param {T[]} families
 * @param {ReadonlySet<string>} runningIds
 * @param {number} now
 * @returns {T[]}
 */
export function recentTaskCandidates(families, _runningIds, _now) {
  // The catalogue's modified time can be the start of a long response, not its completion.
  return families;
}
/**
 * @template {{root: {id: string, modified: string, created: string}, subagents: {id: string}[]}} T
 * @param {T[]} families
 * @param {ReadonlySet<string>} runningIds
 * @param {Record<string, string | null>} replies
 * @param {number} now
 * @returns {T[]}
 */
export function recentTasks(families, _runningIds, replies, _now) {
  const time = family => Date.parse(replies[family.root.id] ?? family.root.created) || 0;
  return [...families].sort((a, b) => time(b) - time(a) || a.root.id.localeCompare(b.root.id)).slice(0, RECENT_TASK_LIMIT);
}
/**
 * @template {{families: {root: {id: string}}[]}} T
 * @param {T[]} groups
 * @param {Record<string, string | null>} replies
 * @returns {T[]}
 */
export function sortProjectGroups(groups, replies) {
  const latestReply = group => group.families.reduce((latest, family) => Math.max(latest, Date.parse(replies[family.root.id] ?? '') || 0), 0);
  return [...groups].sort((a, b) => b.families.length - a.families.length || latestReply(b) - latestReply(a));
}
