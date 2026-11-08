// 状态看板的分栏与排序（纯函数，不依赖 React 与会话存储，可直接单测）。
// 栏位按「现在谁需要关注」排列：运行中 → 待你处理 → 待办 → 积压 → 完成（已取消默认收起）。
// 「待你处理」= 用户把状态设成待审查，或有未读的新回复且没有手动指定过状态。
// 手动指定过状态的会话以状态为准，拖到别栏即改状态，不被「未读」拽回去。

export const BOARD_COLUMNS = Object.freeze([
  { id: 'running', label: '运行中', empty: '没有正在执行的任务', limit: Infinity },
  { id: 'attention', label: '待你处理', empty: '没有需要你处理的任务', limit: 20 },
  { id: 'todo', label: '待办', empty: '没有待办', limit: 10 },
  { id: 'backlog', label: '积压', empty: '没有积压', limit: 8 },
  { id: 'done', label: '完成', empty: '还没有完成的', limit: 6 },
  { id: 'cancelled', label: '已取消', empty: '没有已取消的', limit: 6 },
]);

/** 拖进某栏时写入的工作流状态；运行中是自动栏位，不能拖入。 */
export const COLUMN_STATUS = Object.freeze({
  attention: 'needs-review',
  todo: 'todo',
  backlog: 'backlog',
  done: 'done',
  cancelled: 'cancelled',
});

export function canDropInto(columnId) {
  return Object.hasOwn(COLUMN_STATUS, columnId);
}

/** @param {{ running: boolean, unread: boolean, status: string, assigned: boolean }} input */
export function boardColumnOf({ running, unread, status, assigned }) {
  if (running) return 'running';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'needs-review') return 'attention';
  if (unread && !assigned) return 'attention';
  if (status === 'done') return 'done';
  if (status === 'backlog') return 'backlog';
  return 'todo';
}

const time = value => Date.parse(value) || 0;

/**
 * @template {{ id: string, modified: string, created?: string }} T
 * @param {{ sessions: readonly T[], statusOf: (s: T) => { status: string, assigned: boolean }, isRunning: (s: T) => boolean, isUnread: (s: T) => boolean,
 *   include?: (s: T) => boolean, expanded?: ReadonlySet<string>, showCancelled?: boolean }} input
 * @returns {{ id: string, label: string, empty: string, items: T[], total: number, hidden: number }[]}
 */
export function buildBoard({ sessions, statusOf, isRunning, isUnread, include = () => true, expanded = new Set(), showCancelled = false }) {
  const buckets = new Map(BOARD_COLUMNS.map(column => [column.id, []]));
  for (const session of sessions) {
    if (!include(session)) continue;
    const { status, assigned } = statusOf(session);
    buckets.get(boardColumnOf({ running: isRunning(session), unread: isUnread(session), status, assigned })).push(session);
  }
  return BOARD_COLUMNS
    .filter(column => column.id !== 'cancelled' || showCancelled)
    .map(column => {
      const all = buckets.get(column.id).sort((a, b) => time(b.modified || b.created) - time(a.modified || a.created) || a.id.localeCompare(b.id));
      const shown = expanded.has(column.id) ? all : all.slice(0, column.limit);
      return { id: column.id, label: column.label, empty: column.empty, items: shown, total: all.length, hidden: all.length - shown.length };
    });
}

/**
 * 欢迎页「继续任务」：运行中 → 待你处理 → 最近改动，最多 limit 条。
 * @template {{ id: string, modified: string, created?: string }} T
 * @param {{ sessions: readonly T[], statusOf: (s: T) => { status: string, assigned: boolean }, isRunning: (s: T) => boolean, isUnread: (s: T) => boolean,
 *   include?: (s: T) => boolean, limit?: number }} input
 * @returns {{ session: T, column: string }[]}
 */
export function resumeCandidates({ sessions, statusOf, isRunning, isUnread, include = () => true, limit = 3 }) {
  const rank = { running: 0, attention: 1 };
  return sessions
    .filter(include)
    .map(session => {
      const { status, assigned } = statusOf(session);
      const column = boardColumnOf({ running: isRunning(session), unread: isUnread(session), status, assigned });
      return { session, column };
    })
    .filter(item => item.column !== 'cancelled' && item.column !== 'done')
    .sort((a, b) => (rank[a.column] ?? 2) - (rank[b.column] ?? 2) || time(b.session.modified || b.session.created) - time(a.session.modified || a.session.created) || a.session.id.localeCompare(b.session.id))
    .slice(0, limit);
}
