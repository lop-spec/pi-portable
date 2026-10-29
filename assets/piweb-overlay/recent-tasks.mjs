// Recent tasks are a view over project families, never a second physical classification.
import { hasAssignedStatus } from './craft-session/model.mjs';
export const RECENT_TASK_LIMIT = 30;
export const RECENT_TASK_VISIBLE = 5;

// Only explicit test markers/IDs count. A conversation mentioning testing is not a test session.
export function isTestTask(session, testIds = new Set()) {
  return session.testTask === true || testIds.has(session.id) || (typeof session.firstMessage === 'string' && session.firstMessage.trimStart().startsWith('【测试任务】'));
}
/**
 * @template {{root: {id: string, modified: string, created: string}, subagents: {id: string}[]}} T
 * @param {T[]} families
 * @param {ReadonlySet<string>} runningIds
 * @param {number} now
 * @param {ReadonlySet<string>} [testIds]
 * @returns {T[]}
 */
export function recentTaskCandidates(families, _runningIds, _now, testIds = new Set(), records = {}) {
  // The catalogue's modified time can be the start of a long response, not its completion.
  return families.filter(family => !isTestTask(family.root, testIds) && !hasAssignedStatus(records, family.root.id));
}
/**
 * @template {{root: {id: string, modified: string, created: string}, subagents: {id: string}[]}} T
 * @param {T[]} families
 * @param {ReadonlySet<string>} runningIds
 * @param {Record<string, string | null>} replies
 * @param {number} now
 * @param {ReadonlySet<string>} [testIds]
 * @returns {T[]}
 */
export function recentTasks(families, _runningIds, replies, _now, testIds = new Set(), records = {}) {
  const time = family => Date.parse(replies[family.root.id] ?? family.root.created) || 0;
  return recentTaskCandidates(families, _runningIds, _now, testIds, records).sort((a, b) => time(b) - time(a) || a.root.id.localeCompare(b.root.id)).slice(0, RECENT_TASK_LIMIT);
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
