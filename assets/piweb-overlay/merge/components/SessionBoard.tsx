"use client";
// 会话状态看板（取自 agent-orchestrator 的任务看板）：按「现在谁需要关注」分栏——运行中 / 待你处理 / 待办 / 积压 / 完成。
// 数据全部来自已有的会话目录与工作流状态（/api/session-status），不新增后端；拖动卡片即修改工作流状态，
// 运行中是自动栏位不能拖入。看板盖在对话区上方，下面的对话保持挂载（流式输出和滚动位置不丢）。
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { SessionInfo } from "@/lib/types";
import { hasAssignedStatus, isFlagged, statusOf } from "@/lib/craft-session/model.mjs";
import { BOARD_COLUMNS, COLUMN_STATUS, buildBoard, canDropInto } from "@/lib/portable-session-board.mjs";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { openPortableSession, setPortableBoardOpen, usePortableSessions, usePortableUnreadIds } from "@/lib/portable-session-store";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { FlagGlyph, StatusButton, StatusGlyph, useSessionWorkflow, type StatusId } from "./CraftSessions";
import { Icon } from "./sidebar/icons";
import { projectLabel } from "./sidebar/project-label";
import { deriveSessionTitle } from "./sidebar/session-title";
import { formatSessionTime } from "./sidebar/session-time";

const PREFS_KEY = "pi-web:board-prefs";
type Prefs = { project: string; showCancelled: boolean };

function readPrefs(): Prefs {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { project: typeof parsed.project === "string" ? parsed.project : "", showCancelled: parsed.showCancelled === true };
  } catch {
    return { project: "", showCancelled: false };
  }
}

function ColumnGlyph({ id }: { id: string }) {
  if (id === "running") return <span className="pw-spinner pw-spinner--sm" aria-hidden="true" />;
  if (id === "attention") return <StatusGlyph status="needs-review" />;
  return <StatusGlyph status={id} />;
}

/** 看板关闭时什么都不挂载：不读工作流状态，也不占 DOM。 */
export function SessionBoard() {
  const { boardOpen } = usePortableSessions();
  return boardOpen ? <BoardView /> : null;
}

function BoardView() {
  const { sessions, running, selectedId } = usePortableSessions();
  const unread = usePortableUnreadIds();
  const workflow = useSessionWorkflow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [prefs, setPrefs] = useState<Prefs>({ project: "", showCancelled: false });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setPrefs(readPrefs()); }, []);
  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* 浏览器存储只是尽力而为 */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // 看板盖住对话区时，下面的对话不可聚焦、不被读屏；Esc 关闭。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const siblings = root.parentElement ? [...root.parentElement.children].filter((el) => el !== root) as HTMLElement[] : [];
    siblings.forEach((el) => { el.inert = true; });
    root.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setPortableBoardOpen(false); };
    // 点侧栏里的会话（含当前已选中的那个）就回到对话：选中同一个会话时 AppShell 不会换会话，看板得自己关。
    const onSidebarClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.("#session-sidebar [data-pi-session-id]")) setPortableBoardOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onSidebarClick, true);
    return () => {
      siblings.forEach((el) => { el.inert = false; });
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onSidebarClick, true);
    };
  }, []);

  const roots = useMemo(() => sessions.filter((session) => session.relation?.kind !== "subagent" && !session.transient), [sessions]);
  const projects = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const session of roots) {
      const key = workspaceKeyOf(session);
      const entry = counts.get(key) ?? { label: projectLabel({ root: session.projectRoot ?? session.cwd }), count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [roots]);
  const project = projects.some((item) => item.key === prefs.project) ? prefs.project : "";

  const columns = useMemo(() => buildBoard({
    sessions: roots,
    statusOf: (session) => ({ status: statusOf(workflow.records, session.id), assigned: hasAssignedStatus(workflow.records, session.id) }),
    isRunning: (session) => running.has(session.id),
    isUnread: (session) => unread.has(session.id) && session.id !== selectedId,
    include: (session) => !project || workspaceKeyOf(session) === project,
    expanded,
    showCancelled: prefs.showCancelled,
  }), [expanded, prefs.showCancelled, project, roots, running, selectedId, unread, workflow.records]);

  const move = useCallback((id: string, columnId: string) => {
    const status = (COLUMN_STATUS as Record<string, string>)[columnId];
    if (!status) return;
    void workflow.save(id, { status: status as StatusId }).catch(() => setNotice("状态保存失败，请重试"));
  }, [workflow]);

  const changeArchive = useCallback(async (id: string, archived: boolean) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/${archived ? "restore" : "archive"}`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || "归档操作失败");
      document.dispatchEvent(new Event("pi-web:refresh-sessions"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const openMenu = useCallback((session: SessionInfo, point: { x: number; y: number }) => {
    dispatchSessionRowContextMenu({
      id: session.id, path: session.path, cwd: session.cwd, name: session.name,
      clientX: point.x, clientY: point.y, refresh: () => document.dispatchEvent(new Event("pi-web:refresh-sessions")),
    });
  }, []);

  const onDrop = (event: DragEvent<HTMLElement>, columnId: string) => {
    event.preventDefault();
    setOverColumn(null);
    setDraggingId(null);
    const id = event.dataTransfer.getData("text/plain");
    if (id && canDropInto(columnId)) move(id, columnId);
  };

  const clock = new Date(now);
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  return (
    <div ref={rootRef} className="pw-board" role="region" aria-label="会话状态看板" tabIndex={-1}>
      <header className="pw-board-head">
        <div className="pw-board-title">
          <h2>状态看板</h2>
          <span>{total} 个会话 · 拖动卡片改状态，点击卡片打开</span>
        </div>
        <div className="pw-board-tools">
          <span className="pw-board-select-wrap">
            <select className="pw-input pw-input--sm pw-board-select" aria-label="按项目筛选" value={project} onChange={(event) => updatePrefs({ project: event.target.value })}>
              <option value="">全部项目</option>
              {projects.map((item) => <option key={item.key} value={item.key}>{item.label}（{item.count}）</option>)}
            </select>
            <Icon name="down" size={12} />
          </span>
          <button type="button" className="pw-btn pw-btn--sm" aria-pressed={prefs.showCancelled} title="显示或隐藏已取消的会话" onClick={() => updatePrefs({ showCancelled: !prefs.showCancelled })}>已取消</button>
          <button type="button" className="pw-icon-btn" aria-label="关闭看板（Esc）" title="关闭看板（Esc）" onClick={() => setPortableBoardOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {(workflow.error || notice) && (
        <div role="alert" className="pw-board-alert">
          <span>{notice ?? workflow.error}</span>
          <button type="button" className="pw-btn pw-btn--sm" onClick={() => { setNotice(null); void workflow.reload(); }}>重试</button>
        </div>
      )}
      <div className="pw-board-cols">
        {columns.map((column) => (
          <section
            key={column.id}
            className={`pw-board-col${overColumn === column.id ? " is-over" : ""}${column.id === "attention" ? " is-attention" : ""}`}
            data-column={column.id}
            aria-label={`${column.label}，${column.total} 个`}
            onDragOver={canDropInto(column.id) ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (overColumn !== column.id) setOverColumn(column.id); } : undefined}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverColumn((current) => current === column.id ? null : current); }}
            onDrop={canDropInto(column.id) ? (event) => onDrop(event, column.id) : undefined}
          >
            <header className="pw-board-col-head">
              <ColumnGlyph id={column.id} />
              <h3>{column.label}</h3>
              <span className="pw-board-count">{column.total}</span>
            </header>
            <div className="pw-board-col-body scrollbar-subtle">
              {column.items.length === 0 && <p className="pw-board-empty">{column.empty}</p>}
              {column.items.map((session) => {
                const isRunning = running.has(session.id);
                const isUnread = unread.has(session.id) && session.id !== selectedId;
                const title = deriveSessionTitle(session.name, session.firstMessage, session.id);
                const preview = session.firstMessage.replace(/\s+/g, " ").trim();
                const flagged = isFlagged(workflow.records, session.id);
                return (
                  <article
                    key={session.id}
                    className={`pw-card${session.id === selectedId ? " is-current" : ""}${draggingId === session.id ? " is-dragging" : ""}${isRunning ? " is-running" : ""}`}
                    data-session-id={session.id}
                    draggable
                    onDragStart={(event) => { event.dataTransfer.setData("text/plain", session.id); event.dataTransfer.effectAllowed = "move"; setDraggingId(session.id); }}
                    onDragEnd={() => { setDraggingId(null); setOverColumn(null); }}
                    onContextMenu={(event) => { event.preventDefault(); openMenu(session, { x: event.clientX, y: event.clientY }); }}
                  >
                    <StatusButton id={session.id} records={workflow.records} onSave={workflow.save} archived={false} onArchive={(id, archived) => void changeArchive(id, archived)} />
                    <button type="button" className="pw-card-open" title={`${title}\n${preview.slice(0, 200)}`} aria-label={`打开会话：${title}`} onClick={() => openPortableSession(session.id)}>
                      <span className="pw-card-title">{title}</span>
                      {preview && preview !== title && <span className="pw-card-preview">{preview}</span>}
                      <span className="pw-card-foot">
                        {isRunning
                          ? <span className="pw-card-live"><span className="pw-spinner pw-spinner--sm" aria-hidden="true" />运行中</span>
                          : isUnread
                            ? <span className="pw-card-live is-unread"><span className="pw-dot" aria-hidden="true" />有新回复</span>
                            : <span className="pw-card-project">{projectLabel({ root: session.projectRoot ?? session.cwd })}</span>}
                        <span className="pw-card-foot-end">
                          {flagged && <span className="pw-card-flag" title="已标记" aria-label="已标记"><FlagGlyph /></span>}
                          <span className="pw-card-time">{formatSessionTime(session.modified || session.created, clock)}</span>
                        </span>
                      </span>
                    </button>
                    <button type="button" className="pw-icon-btn pw-icon-btn--sm pw-card-more" aria-label="会话操作" title="会话操作" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(session, { x: rect.right - 180, y: rect.bottom + 4 }); }}>
                      <Icon name="more" />
                    </button>
                  </article>
                );
              })}
              {column.hidden > 0 && (
                <button type="button" className="pw-board-more" onClick={() => setExpanded((current) => new Set(current).add(column.id))}>
                  显示全部 {column.total} 个
                </button>
              )}
              {expanded.has(column.id) && column.total > (BOARD_COLUMNS.find((item) => item.id === column.id)?.limit ?? 0) && (
                <button type="button" className="pw-board-more" onClick={() => setExpanded((current) => { const next = new Set(current); next.delete(column.id); return next; })}>
                  收起
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
