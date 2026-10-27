// Recent tasks are a view over project families, never a second physical classification.
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
export function recentTasks(families, runningIds, replies, now) {
  const active = families.filter(f => [f.root, ...f.subagents].some(s => runningIds.has(s.id)) || Date.parse(replies[f.root.id] ?? '') >= now - 3600000);
  return active.sort((a, b) => (Date.parse(replies[b.root.id] ?? b.root.created) || 0) - (Date.parse(replies[a.root.id] ?? a.root.created) || 0));
}
