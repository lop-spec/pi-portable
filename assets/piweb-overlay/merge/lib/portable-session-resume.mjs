// 新会话欢迎页的「继续任务」推荐逻辑；不依赖独立状态看板。
const time = value => Date.parse(value) || 0;

/**
 * 推荐运行中、有新回复、最近改动的会话；排除已完成、取消和积压状态。
 * @template {{ id: string, modified: string, created?: string }} T
 * @param {{ sessions: readonly T[], statusOf: (s: T) => { status: string, assigned: boolean }, isRunning: (s: T) => boolean, isUnread: (s: T) => boolean,
 *   include?: (s: T) => boolean, limit?: number }} input
 * @returns {{ session: T, column: string }[]}
 */
export function resumeCandidates({ sessions, statusOf, isRunning, isUnread, include = () => true, limit = 3 }) {
  return sessions
    .filter(include)
    .map(session => {
      const { status, assigned } = statusOf(session);
      const running = isRunning(session), unread = isUnread(session);
      const column = running ? 'running'
        : status === 'cancelled' ? 'cancelled'
        : status === 'needs-review' || (unread && !assigned) ? 'attention'
        : status === 'done' ? 'done'
        : status === 'backlog' ? 'backlog' : 'todo';
      return { session, column, rank: running ? 0 : unread ? 1 : 2 };
    })
    .filter(item => item.column !== 'cancelled' && item.column !== 'done' && item.column !== 'backlog')
    .sort((a, b) => a.rank - b.rank || time(b.session.modified || b.session.created) - time(a.session.modified || a.session.created) || a.session.id.localeCompare(b.session.id))
    .slice(0, limit)
    .map(({ session, column }) => ({ session, column }));
}
