"use client";
// 分支 / worktree 行（方向 A spec §2.3）：只在 Git 仓库根目录渲染，缩进到项目名下方。
// 下拉为 .pw-menu：筛选（≥8 个时）、每个 worktree 一行（分支名、会话数，非主分支悬停出现移除）、新建 worktree…。
// 移除一律先走确认行（取消/移除）：垃圾桶占行右侧独立一列、与主按钮隔开，悬停不替换计数；服务端判脏后再出「强制移除」。
// 创建/移除的请求与状态仍由 SessionSidebar 持有，这里只负责展示和交互。
import { memo, useRef, useState } from "react";
import { Icon } from "./icons";
import { PopMenu, anchorFromElement } from "./PopMenu";

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface WorktreeSwitcherProps {
  worktrees: WorktreeEntry[];
  current: WorktreeEntry | undefined;
  currentPath: string | null;
  sessionCount: number;
  countsByPath: Map<string, number>;
  displayPath: (path: string) => string;
  busy: boolean;
  error: string | null;
  confirmRemove: string | null;
  newOpen: boolean;
  newBranch: string;
  onSelect: (path: string) => void;
  onRemove: (path: string, force: boolean) => Promise<void> | void;
  onCancelRemove: () => void;
  onNewOpenChange: (open: boolean) => void;
  onNewBranchChange: (value: string) => void;
  onCreate: () => Promise<boolean>;
  onDismiss: () => void;
}

export const WorktreeSwitcher = memo(function WorktreeSwitcher({
  worktrees,
  current,
  currentPath,
  sessionCount,
  countsByPath,
  displayPath,
  busy,
  error,
  confirmRemove,
  newOpen,
  newBranch,
  onSelect,
  onRemove,
  onCancelRemove,
  onNewOpenChange,
  onNewBranchChange,
  onCreate,
  onDismiss,
}: WorktreeSwitcherProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // 等待用户确认移除的 worktree（普通确认）；服务端判脏后的强制确认由父组件的 confirmRemove 持有，优先显示。
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const showFilter = worktrees.length >= 8;
  const query = filter.trim().toLowerCase();
  const visible = showFilter && query
    ? worktrees.filter((worktree) => (worktree.branch ?? displayPath(worktree.path)).toLowerCase().includes(query))
    : worktrees;
  const close = () => { setOpen(false); setFilter(""); setPendingRemove(null); onDismiss(); };
  const name = current ? (current.branch ?? displayPath(current.path)) : "…";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="pw-wt-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`当前分支：${name}${current?.isMain ? "（主分支）" : ""}，${sessionCount} 个会话`}
        title={current ? `切换分支或 worktree：${current.path}` : "切换分支或 worktree"}
        onClick={() => { if (open) close(); else setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}
      >
        <Icon name="branch" size={12} className={current && !current.isMain ? "is-accent" : undefined} />
        <span className="pw-wt-name">{name}</span>
        {current?.isMain && <span className="pw-wt-tag">主分支</span>}
        <span className="pw-wt-count pw-num" title={`此分支 ${sessionCount} 个会话`}>{sessionCount}</span>
        <Icon name="down" size={12} className="pw-wt-chevron" />
      </button>

      {open && (
        <PopMenu
          anchor={anchorFromElement(triggerRef.current, { offset: 4 })}
          width={Math.max(200, triggerRef.current?.getBoundingClientRect().width ?? 0)}
          ariaLabel="切换分支或 worktree"
          returnFocus={triggerRef.current}
          initialFocus="checked"
          className="pw-wt-menu"
          ignoreOutside={(target) => Boolean(triggerRef.current?.contains(target))}
          onClose={close}
        >
          {showFilter && (
            <input
              className="pw-menu-filter"
              data-autofocus=""
              value={filter}
              placeholder="筛选分支"
              aria-label="筛选分支"
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          {visible.map((worktree) => {
            const isCurrent = worktree.path === currentPath;
            const branch = worktree.branch ?? displayPath(worktree.path);
            if (confirmRemove === worktree.path) {
              return (
                <div key={worktree.path} className="pw-wt-confirm" role="group" aria-label="确认移除 worktree">
                  <span className="pw-wt-confirm-text">有未提交的更改，仍要强制移除这个 checkout？</span>
                  <span className="pw-wt-confirm-actions">
                    <button type="button" className="pw-btn pw-btn--ghost pw-btn--sm" autoFocus onClick={onCancelRemove}>取消</button>
                    <button type="button" className="pw-btn pw-btn--danger-solid pw-btn--sm" disabled={busy} onClick={() => { void onRemove(worktree.path, true); }}>强制移除</button>
                  </span>
                </div>
              );
            }
            if (pendingRemove === worktree.path) {
              return (
                <div key={worktree.path} className="pw-wt-confirm" role="group" aria-label="确认移除 worktree">
                  <span className="pw-wt-confirm-text">移除 worktree「{branch}」的 checkout？分支会保留。</span>
                  <span className="pw-wt-confirm-actions">
                    <button type="button" className="pw-btn pw-btn--ghost pw-btn--sm" autoFocus onClick={() => setPendingRemove(null)}>取消</button>
                    <button
                      type="button"
                      className="pw-btn pw-btn--danger-solid pw-btn--sm"
                      disabled={busy}
                      onClick={() => { void Promise.resolve(onRemove(worktree.path, false)).finally(() => setPendingRemove(null)); }}
                    >移除</button>
                  </span>
                </div>
              );
            }
            const count = countsByPath.get(worktree.path);
            return (
              <div key={worktree.path} className="pw-wt-item">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  className="pw-menu-item"
                  title={worktree.path}
                  onClick={() => { close(); onSelect(worktree.path); triggerRef.current?.focus({ preventScroll: true }); }}
                >
                  <span className="pw-menu-check">{isCurrent && <Icon name="check" />}</span>
                  <span className="pw-menu-label pw-wt-item-name">{branch}</span>
                  <span className="pw-menu-meta">
                    {worktree.isMain && <span>主分支</span>}
                    {count !== undefined && <span className="pw-num">{count}</span>}
                  </span>
                </button>
                {worktree.isMain ? (
                  <span className="pw-wt-remove-slot" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className="pw-icon-btn pw-icon-btn--sm pw-icon-btn--danger pw-wt-remove"
                    tabIndex={-1}
                    disabled={busy}
                    aria-label={`移除 worktree ${branch}`}
                    title={`移除 worktree checkout ${worktree.path}；保留分支`}
                    onClick={(event) => { event.stopPropagation(); setPendingRemove(worktree.path); }}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            );
          })}
          {showFilter && visible.length === 0 && query && <div className="pw-menu-empty">没有匹配的分支</div>}
          <div className="pw-menu-sep" role="separator" />
          {!newOpen ? (
            <button type="button" role="menuitem" className="pw-menu-item" title="为分支创建 worktree checkout" onClick={() => onNewOpenChange(true)}>
              <Icon name="plus" /><span className="pw-menu-label">新建 worktree…</span>
            </button>
          ) : (
            <form
              className="pw-wt-new"
              onSubmit={(event) => { event.preventDefault(); void onCreate().then((created) => { if (created) close(); }); }}
            >
              <input
                className="pw-input pw-input--sm pw-mono"
                autoFocus
                value={newBranch}
                placeholder="分支名称"
                aria-label="新 worktree 的分支名称"
                onChange={(event) => onNewBranchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onNewOpenChange(false); }
                }}
              />
              <div className="pw-wt-new-actions">
                <button type="button" className="pw-btn pw-btn--ghost pw-btn--sm" onClick={() => onNewOpenChange(false)}>取消</button>
                <button type="submit" className="pw-btn pw-btn--primary pw-btn--sm" disabled={busy || !newBranch.trim()}>{busy ? "创建中…" : "创建"}</button>
              </div>
            </form>
          )}
          {error && <p className="pw-field-error pw-wt-error" role="alert">{error}</p>}
        </PopMenu>
      )}
    </>
  );
});
