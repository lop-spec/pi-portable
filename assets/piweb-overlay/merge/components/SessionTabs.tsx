"use client";
// 多会话标签栏（取自 cc-haha 的「多个任务，一个窗口」）：在顶栏下方列出打开过的会话，一键切换。
// 最左的「看板」标签打开状态看板；运行中的会话显示转圈，后台有新回复的显示小圆点。
// 标签只是视图：关闭标签不会停止或删除会话。标签列表保存在浏览器本地。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "./sidebar/icons";
import { deriveSessionTitle } from "./sidebar/session-title";
import { projectLabel } from "./sidebar/project-label";
import {
  openPortableSession,
  setPortableBoardOpen,
  startPortableSession,
  usePortableSessions,
  usePortableUnreadIds,
} from "@/lib/portable-session-store";

const STORAGE_KEY = "pi-web:session-tabs";
const MAX_TABS = 10;
/** 目录里找不到的标签要连续缺席这么久才移除，避免刷新列表的瞬间误关。 */
const PRUNE_DELAY_MS = 3000;

function readStoredTabs(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

export function BoardIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="pw-i" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="5" height="16" rx="1.4" /><rect x="9.5" y="4" width="5" height="10" rx="1.4" /><rect x="16" y="4" width="5" height="13" rx="1.4" />
    </svg>
  );
}

export function SessionTabs() {
  const { sessions, running, selectedId, draftOpen, boardOpen } = usePortableSessions();
  const unread = usePortableUnreadIds();
  const [ids, setIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIds(readStoredTabs());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* 浏览器存储只是尽力而为 */ }
  }, [hydrated, ids]);

  // 选中某个会话就保证它有标签；超出上限时先丢最久没碰的（不丢选中的和运行中的）。
  useEffect(() => {
    if (!hydrated || !selectedId) return;
    setIds((current) => {
      if (current.includes(selectedId)) return current;
      const next = [...current, selectedId];
      while (next.length > MAX_TABS) {
        const drop = next.findIndex((id) => id !== selectedId && !running.has(id));
        if (drop < 0) break;
        next.splice(drop, 1);
      }
      return next;
    });
  }, [hydrated, selectedId, running]);

  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  // 已被归档或删除的会话：目录里持续找不到就移除标签。
  useEffect(() => {
    if (!hydrated || sessions.length === 0) return;
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length === 0) return;
    const timer = window.setTimeout(() => {
      setIds((current) => current.filter((id) => !missing.includes(id) || byId.has(id)));
    }, PRUNE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [byId, hydrated, ids, sessions.length]);

  const tabs = useMemo(() => ids
    .map((id) => byId.get(id))
    .filter((session): session is NonNullable<typeof session> => Boolean(session)), [byId, ids]);

  // 选中的标签滚进可视区。
  useEffect(() => {
    if (!selectedId) return;
    const active = listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, tabs.length, boardOpen]);

  const close = useCallback((id: string) => {
    const index = ids.indexOf(id);
    const next = ids.filter((item) => item !== id);
    setIds(next);
    if (id !== selectedId || boardOpen) return;
    const neighbour = next.map((item) => byId.get(item)).filter(Boolean)[Math.min(index, next.length - 1)];
    if (neighbour) openPortableSession(neighbour.id);
    else startPortableSession();
  }, [boardOpen, byId, ids, selectedId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".pw-tab-main")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
    buttons[target]?.focus();
  };

  const unreadCount = useMemo(
    () => sessions.filter((session) => unread.has(session.id) && session.id !== selectedId && session.relation?.kind !== "subagent").length,
    [selectedId, sessions, unread],
  );
  const runningCount = useMemo(() => sessions.filter((session) => running.has(session.id) && session.relation?.kind !== "subagent").length, [running, sessions]);

  return (
    <div className="pw-tabs" role="tablist" aria-label="打开的会话" onKeyDown={onKeyDown}>
      <button
        type="button"
        role="tab"
        aria-selected={boardOpen}
        className="pw-tab pw-tab-main pw-tab--board"
        title={`状态看板：${runningCount} 个运行中，${unreadCount} 个有新回复`}
        onClick={() => setPortableBoardOpen(!boardOpen)}
      >
        <BoardIcon />
        <span className="pw-tab-title">看板</span>
        {unreadCount > 0 && <span className="pw-tab-badge" aria-label={`${unreadCount} 个会话有新回复`}>{unreadCount}</span>}
      </button>
      <span className="pw-tabs-sep" aria-hidden="true" />
      <div className="pw-tabs-list" ref={listRef}>
        {tabs.map((session) => {
          const selected = !boardOpen && session.id === selectedId;
          const isRunning = running.has(session.id);
          const isUnread = unread.has(session.id) && !selected;
          const title = deriveSessionTitle(session.name, session.firstMessage, session.id);
          const project = projectLabel({ root: session.projectRoot ?? session.cwd });
          return (
            <div
              key={session.id}
              data-session-id={session.id}
              className={`pw-tab${selected ? " is-selected" : ""}`}
              role="presentation"
              onAuxClick={(event: MouseEvent) => { if (event.button === 1) { event.preventDefault(); close(session.id); } }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected || (!selectedId && !boardOpen && session === tabs[0]) ? 0 : -1}
                className="pw-tab-main"
                title={`${title}\n${project}${isRunning ? " · 运行中" : isUnread ? " · 有新回复" : ""}`}
                onClick={() => openPortableSession(session.id)}
              >
                {isRunning ? <span className="pw-spinner pw-spinner--sm" role="status" aria-label="运行中" /> : isUnread ? <span className="pw-dot" aria-label="有新回复" /> : null}
                <span className="pw-tab-title">{title}</span>
              </button>
              <button type="button" tabIndex={-1} className="pw-tab-close" aria-label={`关闭标签：${title}`} title="关闭标签（不会停止会话）" onClick={() => close(session.id)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
        {draftOpen && !boardOpen && (
          <div className="pw-tab is-selected is-draft" role="presentation">
            <button type="button" role="tab" aria-selected="true" className="pw-tab-main" tabIndex={0}>
              <span className="pw-tab-title">新会话</span>
            </button>
          </div>
        )}
      </div>
      <button type="button" className="pw-icon-btn pw-icon-btn--sm pw-tabs-new" title="新建会话（Ctrl Alt N）" aria-label="新建会话" onClick={startPortableSession}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
