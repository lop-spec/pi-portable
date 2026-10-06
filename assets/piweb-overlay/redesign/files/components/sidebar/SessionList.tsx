"use client";
// 会话列表（方向 A spec §2.4）：列表头「会话 …… [归档插槽]」/ 搜索框，按 今天/昨天/近 7 天/更早 分组，
// 单行 30px 虚拟列表。滚动状态只在本组件内，滚动不会重渲染整个侧栏（审计 P11）；
// 选中会话不在视口时自动滚过去（D12）；roving tabindex + ↑↓/Home/End/F2/Shift+F10/→← 键盘操作（D27）。
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { SessionInfo } from "@/lib/types";
import type { SessionFamily } from "@/lib/session-family";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { SessionContextActions } from "../PortableContextActions";
import type { NamedProject } from "../PortableProjects";
import { SessionSearch } from "../SessionSearch";
import { Icon } from "./icons";
import { SessionRow } from "./SessionRow";
import { archiveEmptyMessage, archivedProjectCount } from "./archive-count";
import { resolveAutoExpand } from "./family-expand";
import { formatSessionDateTime, formatSessionTime, groupSessionsByDay, localDayKey, msUntilNextLocalMidnight } from "./session-time";
import { buildLayout, scrollTopToReveal, visibleIndices } from "./virtual";

const GROUP_HEADER_FIRST_H = 26;
const GROUP_HEADER_H = 32;

type ListItem =
  | { kind: "group"; key: string; label: string; first: boolean }
  | { kind: "row"; session: SessionInfo; family: SessionFamily; depth: 0 | 1; modified: string };

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return coarse;
}

/**
 * 「今天」：本地日期变化时才换新 Date（到下一个本地午夜的一次性定时器；休眠唤醒、切回标签页时再核对一次），
 * 驱动「今天/昨天/近 7 天」分组和行尾时间重算。轮询时结构共享让 families 引用不变，所以不能指望数据变化来刷新。
 */
function useLocalToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = new Date();
      setToday((previous) => (localDayKey(previous) === localDayKey(now) ? previous : now));
    };
    const arm = () => {
      timer = setTimeout(() => { refresh(); arm(); }, msUntilNextLocalMidnight(new Date()));
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    arm();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return today;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 注入脚本写 html[data-pi-session-archive-view]（当前视图）和 html[data-pi-session-archive-total]（所有项目的归档数，来自代理）；
 * 列表头据此显示「已归档」，空态据此说明其他项目还有多少归档。
 */
function useArchiveView(): { archived: boolean; total: number } {
  const [state, setState] = useState({ archived: false, total: 0 });
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const archived = root.dataset.piSessionArchiveView === "archived";
      const total = Number(root.dataset.piSessionArchiveTotal);
      const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
      setState((previous) => (previous.archived === archived && previous.total === safeTotal ? previous : { archived, total: safeTotal }));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-pi-session-archive-view", "data-pi-session-archive-total"] });
    return () => observer.disconnect();
  }, []);
  return state;
}

export interface SessionListProps {
  families: SessionFamily[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  projects: NamedProject[];
  canCreate: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  listScrollRef: RefObject<HTMLDivElement | null>;
  subagentGlyph: ReactNode;
  labelForSession: (session: SessionInfo) => string;
  onSearchQueryChange: (query: string) => void;
  onSearchClose: () => void;
  onSelect: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  onNewSession: () => void;
  onRetry: () => void;
  onRenamed: () => void;
  onMoved: (info: SessionInfo) => void;
  onDeleted: (id: string) => void;
}

export const SessionList = memo(function SessionList({
  families,
  loading,
  error,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  projects,
  canCreate,
  searchOpen,
  searchQuery,
  searchInputRef,
  listScrollRef,
  subagentGlyph,
  labelForSession,
  onSearchQueryChange,
  onSearchClose,
  onSelect,
  onNewSession,
  onRetry,
  onRenamed,
  onMoved,
  onDeleted,
}: SessionListProps) {
  const { archived: archivedView, total: archiveTotal } = useArchiveView();
  // 归档视图里列表只显示当前项目的归档；把这个数写到 html[data-pi-session-archive-project-count]，注入脚本的列表头据此显示「N 个对话」
  // （脚本自己只知道所有项目的总数）。新列表还没到、加载中、出错时不写，脚本就不显示数字，而不是显示错的。
  const archivedCount = useMemo(() => (archivedView ? archivedProjectCount(families) : null), [archivedView, families]);
  const coarse = useCoarsePointer();
  const today = useLocalToday();
  const rowHeight = coarse ? 36 : 30;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [viewportH, setViewportH] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const pendingFocusRef = useRef<string | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const lastRevealedRef = useRef<string | null>(null);
  const autoExpandedForRef = useRef<string | null>(null);
  const searchActive = searchOpen && Boolean(searchQuery.trim());
  useScrollbarVisibility(listScrollRef);

  useEffect(() => {
    const root = document.documentElement;
    if (archivedView && !loading && !error && archivedCount !== null) root.dataset.piSessionArchiveProjectCount = String(archivedCount);
    else delete root.dataset.piSessionArchiveProjectCount;
    // The injected script re-renders the archive head on this event (no document-wide observer).
    document.dispatchEvent(new CustomEvent("pi-web:archive-project-count"));
  }, [archivedView, archivedCount, loading, error]);
  useEffect(() => () => {
    delete document.documentElement.dataset.piSessionArchiveProjectCount;
    document.dispatchEvent(new CustomEvent("pi-web:archive-project-count"));
  }, []);

  // 选中的是子代理时自动展开它所在的家族，让选中行可见——只在选中会话变化后做一次，
  // 之后用户手动折叠要被尊重（折叠后选中会汇总到主行）；所以依赖里没有 expanded。
  useEffect(() => {
    const { rootId, handledId } = resolveAutoExpand(families, selectedSessionId, autoExpandedForRef.current);
    autoExpandedForRef.current = handledId;
    if (rootId) setExpanded((previous) => (previous.has(rootId) ? previous : new Set(previous).add(rootId)));
  }, [families, selectedSessionId]);

  const items = useMemo<ListItem[]>(() => {
    const result: ListItem[] = [];
    const groups = groupSessionsByDay(families, (family) => family.latestModified, today);
    groups.forEach((group, index) => {
      result.push({ kind: "group", key: group.key, label: group.label, first: index === 0 });
      for (const family of group.items) {
        result.push({ kind: "row", session: family.root, family, depth: 0, modified: family.latestModified });
        if (family.subagents.length > 0 && expanded.has(family.root.id)) {
          for (const sub of family.subagents) result.push({ kind: "row", session: sub, family, depth: 1, modified: sub.modified });
        }
      }
    });
    return result;
  }, [expanded, families, today]);

  const layout = useMemo(() => buildLayout(items.map((item) => (
    item.kind === "group" ? (item.first ? GROUP_HEADER_FIRST_H : GROUP_HEADER_H) : rowHeight
  ))), [items, rowHeight]);

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => { if (item.kind === "row") map.set(item.session.id, index); });
    return map;
  }, [items]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, SessionInfo>();
    for (const family of families) {
      map.set(family.root.id, family.root);
      for (const sub of family.subagents) map.set(sub.id, sub);
    }
    return map;
  }, [families]);
  const sessionsByIdRef = useRef(sessionsById);
  sessionsByIdRef.current = sessionsById;
  const runningRef = useRef(runningSessionIds);
  runningRef.current = runningSessionIds;

  /** 折叠的家族把子代理的选中/运行/未读汇总到主会话行。 */
  const rowIndexForSelection = useMemo(() => {
    if (!selectedSessionId) return -1;
    const direct = indexById.get(selectedSessionId);
    if (direct !== undefined) return direct;
    const family = families.find((item) => item.subagents.some((session) => session.id === selectedSessionId));
    return family ? indexById.get(family.root.id) ?? -1 : -1;
  }, [families, indexById, selectedSessionId]);

  const computeRange = useCallback((scrollTop: number) => {
    const indices = visibleIndices(layout, scrollTop, viewportH, 8);
    return indices.length > 0 ? { start: indices[0], end: indices[indices.length - 1] + 1 } : { start: 0, end: 0 };
  }, [layout, viewportH]);

  const syncRange = useCallback(() => {
    const element = listScrollRef.current;
    const next = computeRange(element?.scrollTop ?? 0);
    setRange((previous) => (previous.start === next.start && previous.end === next.end ? previous : next));
  }, [computeRange, listScrollRef]);

  useLayoutEffect(() => { syncRange(); }, [syncRange]);

  useLayoutEffect(() => {
    const element = listScrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setViewportH(Math.round(entry.contentRect.height));
    });
    observer.observe(element);
    setViewportH(element.clientHeight);
    return () => observer.disconnect();
  }, [listScrollRef]);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      syncRange();
    });
  }, [syncRange]);
  useEffect(() => () => { if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current); }, []);

  // 选中会话变化（含首屏恢复）后，若不在视口内就滚到中间。首屏几秒内列表还会因 summary→完整目录、
  // worktree 过滤而重排，所以选中后 4 秒内持续保证可见；用户自己滚动（滚轮、触摸、拖滚动条、方向键）就停，不抢回来。
  const revealRef = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => {
    revealRef.current = selectedSessionId ? { id: selectedSessionId, until: performance.now() + 4000 } : null;
  }, [selectedSessionId]);
  useEffect(() => {
    const element = listScrollRef.current;
    if (!element) return;
    const stop = () => { revealRef.current = null; };
    element.addEventListener("wheel", stop, { passive: true });
    element.addEventListener("touchstart", stop, { passive: true });
    element.addEventListener("pointerdown", stop);
    element.addEventListener("keydown", stop);
    return () => {
      element.removeEventListener("wheel", stop);
      element.removeEventListener("touchstart", stop);
      element.removeEventListener("pointerdown", stop);
      element.removeEventListener("keydown", stop);
    };
  }, [listScrollRef]);
  useLayoutEffect(() => {
    const pending = revealRef.current;
    if (!pending || pending.id !== selectedSessionId || viewportH <= 0 || searchActive) return;
    if (performance.now() > pending.until) { revealRef.current = null; return; }
    if (rowIndexForSelection < 0) return;
    const element = listScrollRef.current;
    if (!element) return;
    const first = lastRevealedRef.current === null || lastRevealedRef.current === selectedSessionId;
    lastRevealedRef.current = selectedSessionId;
    const top = scrollTopToReveal(layout, rowIndexForSelection, element.scrollTop, viewportH, true);
    if (top === null) return;
    element.scrollTo({ top, behavior: first || prefersReducedMotion() ? "auto" : "smooth" });
    syncRange();
  }, [layout, listScrollRef, rowIndexForSelection, searchActive, selectedSessionId, syncRange, viewportH]);

  // 视口变矮（例如展开文件抽屉）时，原本看得见的选中行仍保持在视口内。
  const previousViewportRef = useRef(0);
  useLayoutEffect(() => {
    const previous = previousViewportRef.current;
    previousViewportRef.current = viewportH;
    const element = listScrollRef.current;
    if (!element || viewportH <= 0 || previous <= viewportH || rowIndexForSelection < 0) return;
    const rowTop = layout.offsets[rowIndexForSelection];
    const rowBottom = layout.offsets[rowIndexForSelection + 1];
    const scrollTop = element.scrollTop;
    const wasVisible = rowTop >= scrollTop && rowBottom <= scrollTop + previous;
    if (!wasVisible || rowBottom <= scrollTop + viewportH) return;
    element.scrollTop = Math.max(0, rowBottom - viewportH + 8);
    syncRange();
  }, [layout, listScrollRef, rowIndexForSelection, syncRange, viewportH]);

  // 键盘移动到尚未挂载的行：先滚进视口，渲染后再聚焦。
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const button = listScrollRef.current?.querySelector<HTMLButtonElement>(`[data-pi-session-id="${CSS.escape(id)}"] .pw-sess-main`);
    if (!button) return;
    pendingFocusRef.current = null;
    button.focus({ preventScroll: true });
  });

  const focusRow = useCallback((id: string) => {
    const index = indexById.get(id);
    const element = listScrollRef.current;
    if (index === undefined || !element) return;
    const top = scrollTopToReveal(layout, index, element.scrollTop, viewportH);
    if (top !== null) element.scrollTop = top;
    pendingFocusRef.current = id;
    setFocusedId(id);
    syncRange();
    const button = element.querySelector<HTMLButtonElement>(`[data-pi-session-id="${CSS.escape(id)}"] .pw-sess-main`);
    if (button) { pendingFocusRef.current = null; button.focus({ preventScroll: true }); }
  }, [indexById, layout, listScrollRef, syncRange, viewportH]);

  const rowIds = useMemo(() => items.flatMap((item) => (item.kind === "row" ? [item.session.id] : [])), [items]);

  const handleSelect = useCallback((id: string) => {
    const session = sessionsByIdRef.current.get(id);
    if (!session) return;
    setFocusedId(id);
    onSelect(session);
  }, [onSelect]);

  const handleToggleFamily = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpenMenu = useCallback((id: string, point: { x: number; y: number } | null) => {
    const session = sessionsByIdRef.current.get(id);
    if (!session || session.transient) return;
    let x = point?.x ?? 0;
    let y = point?.y ?? 0;
    if (!point) {
      const rect = listScrollRef.current
        ?.querySelector(`[data-pi-session-id="${CSS.escape(id)}"]`)
        ?.getBoundingClientRect();
      x = rect ? rect.left + 24 : 0;
      y = rect ? rect.bottom + 2 : 0;
    }
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: x,
      clientY: y,
      refresh: () => { onRenamed(); },
    });
    if (!handled) console.error("[pi-web sidebar] session menu host unavailable for", id);
  }, [listScrollRef, onRenamed]);

  const handleRenameCommit = useCallback(async (id: string, value: string | null) => {
    setRenamingId(null);
    pendingFocusRef.current = id;
    const session = sessionsByIdRef.current.get(id);
    if (value === null || !session || session.transient) return;
    const name = value.trim();
    // 没改动（RenameField 传 null）或与现有名字相同就不写：推导出来的显示标题不是真正的名字，不能被存成名字。
    if (name === (session.name ?? "")) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRenamed();
    } catch (cause) {
      console.error("[pi-web sidebar] rename failed:", cause);
    }
  }, [onRenamed]);

  const startRename = useCallback((id: string) => {
    const session = sessionsByIdRef.current.get(id);
    if (!session || session.transient) return;
    focusRow(id);
    setRenamingId(id);
  }, [focusRow]);

  const activeId = (focusedId && indexById.has(focusedId) ? focusedId : null)
    ?? (rowIndexForSelection >= 0 && items[rowIndexForSelection]?.kind === "row" ? (items[rowIndexForSelection] as Extract<ListItem, { kind: "row" }>).session.id : null)
    ?? rowIds[0]
    ?? null;

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("pw-sess-main")) return;
    const id = target.closest<HTMLElement>("[data-pi-session-id]")?.dataset.piSessionId;
    if (!id) return;
    const position = rowIds.indexOf(id);
    const item = items[indexById.get(id) ?? -1];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = rowIds[Math.max(0, Math.min(rowIds.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) focusRow(next);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? rowIds[0] : rowIds[rowIds.length - 1];
      if (next) focusRow(next);
    } else if (event.key === "F2") {
      event.preventDefault();
      startRename(id);
    } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      handleOpenMenu(id, null);
    } else if (event.key === "ArrowRight" && item?.kind === "row" && item.depth === 0 && item.family.subagents.length > 0 && !expanded.has(id)) {
      event.preventDefault();
      handleToggleFamily(id);
    } else if (event.key === "ArrowLeft" && item?.kind === "row") {
      if (item.depth === 1) { event.preventDefault(); focusRow(item.family.root.id); }
      else if (expanded.has(id)) { event.preventDefault(); handleToggleFamily(id); }
    }
  };

  const now = today;
  const visible = items.slice(range.start, Math.max(range.end, range.start));
  const pinned = [renamingId, focusedId]
    .map((id) => (id ? indexById.get(id) ?? -1 : -1))
    .filter((index) => index >= 0 && (index < range.start || index >= range.end));
  const renderIndices = [...visible.map((_, offset) => range.start + offset), ...pinned].sort((a, b) => a - b);

  const showSkeleton = loading && families.length === 0 && !error;
  const showEmpty = !loading && !error && families.length === 0;

  return (
    <div className="pw-sess" data-search={searchOpen ? "open" : undefined}>
      <div className="pw-sess-head">
        {searchOpen ? (
          <div className="pw-field pw-sess-search">
            <Icon name="search" size={14} />
            <input
              ref={searchInputRef}
              id="session-search-input"
              type="search"
              value={searchQuery}
              maxLength={200}
              aria-label="搜索所有会话"
              placeholder="搜索所有会话…"
              autoComplete="off"
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (searchQuery) onSearchQueryChange("");
                  else onSearchClose();
                } else if (event.key === "Enter") {
                  const first = document.querySelector<HTMLButtonElement>(".pw-search-item");
                  if (first) { event.preventDefault(); first.click(); }
                } else if (event.key === "ArrowDown") {
                  const first = document.querySelector<HTMLButtonElement>(".pw-search-item");
                  if (first) { event.preventDefault(); first.focus(); }
                }
              }}
            />
            <button type="button" className="pw-icon-btn pw-icon-btn--sm" aria-label="关闭搜索" title="关闭搜索（Esc）" onClick={onSearchClose}>
              <Icon name="close" />
            </button>
          </div>
        ) : (
          <span className="pw-sess-head-label">{archivedView ? "已归档会话" : "会话"}</span>
        )}
        <span data-pi-archive-slot="" />
      </div>

      <SessionSearch
        open={searchOpen}
        query={searchQuery}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelect}
        labelForSession={labelForSession}
      />

      <nav
        ref={listScrollRef as RefObject<HTMLDivElement>}
        className="pw-sess-scroll scrollbar-subtle"
        aria-label={archivedView ? "已归档会话" : "会话列表"}
        hidden={searchActive}
        onScroll={handleScroll}
        onKeyDown={onListKeyDown}
        onFocus={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>("[data-pi-session-id]")?.dataset.piSessionId;
          if (id && (event.target as HTMLElement).classList.contains("pw-sess-main")) setFocusedId(id);
        }}
      >
        {error && (
          <div className="pw-sess-state is-error" role="alert">
            <p>会话列表加载失败：{error}</p>
            <button type="button" className="pw-btn pw-btn--sm" onClick={onRetry}><Icon name="refresh" />重试</button>
          </div>
        )}
        {showSkeleton && (
          <div className="pw-sess-skeleton" aria-busy="true" aria-label="正在加载会话">
            <span className="pw-skeleton" style={{ width: "82%" }} />
            <span className="pw-skeleton" style={{ width: "64%" }} />
            <span className="pw-skeleton" style={{ width: "74%" }} />
          </div>
        )}
        {showEmpty && (
          <div className="pw-sess-state">
            <Icon name="chat" size={24} className="pw-sess-state-icon" />
            <p>{archivedView ? archiveEmptyMessage(archiveTotal) : "这个项目还没有会话"}</p>
            {!archivedView && canCreate && (
              <button type="button" className="pw-btn" onClick={onNewSession}><Icon name="newChat" />新建会话</button>
            )}
          </div>
        )}
        {items.length > 0 && (
          <div className="pw-vlist" style={{ height: layout.total }}>
            {renderIndices.map((index) => {
              const item = items[index];
              const top = layout.offsets[index];
              const height = layout.offsets[index + 1] - top;
              if (item.kind === "group") {
                return (
                  <div key={`g:${item.key}`} className={item.first ? "pw-sess-group is-first" : "pw-sess-group"} style={{ position: "absolute", top, height }}>
                    {item.label}
                  </div>
                );
              }
              const { session, family, depth } = item;
              const familyIds = depth === 0 && !expanded.has(session.id) ? [session, ...family.subagents] : [session];
              const isSelected = depth === 0 && !expanded.has(session.id)
                ? familyIds.some((member) => member.id === selectedSessionId)
                : session.id === selectedSessionId;
              const isRunning = familyIds.some((member) => runningSessionIds.has(member.id));
              const isUnread = familyIds.some((member) => unreadSessionIds.has(member.id));
              return (
                <div key={session.id} className="pw-vitem" style={{ position: "absolute", top, height, left: 0, right: 0 }}>
                  <SessionRow
                    session={session}
                    depth={depth}
                    timeLabel={formatSessionTime(item.modified, now)}
                    tooltipTime={formatSessionDateTime(item.modified, now)}
                    isSelected={isSelected}
                    isRunning={isRunning}
                    isUnread={isUnread}
                    subagentCount={depth === 0 ? family.subagents.length : 0}
                    expanded={expanded.has(session.id)}
                    renaming={renamingId === session.id}
                    tabbable={activeId === session.id}
                    menuOpen={menuId === session.id}
                    subagentGlyph={subagentGlyph}
                    onSelect={handleSelect}
                    onToggleFamily={handleToggleFamily}
                    onOpenMenu={handleOpenMenu}
                    onRenameCommit={handleRenameCommit}
                  />
                </div>
              );
            })}
          </div>
        )}
      </nav>

      <SessionContextActions
        resolveSession={(id) => sessionsByIdRef.current.get(id)}
        isRunning={(id) => runningRef.current.has(id)}
        projects={projects}
        onRename={startRename}
        onMenuChange={setMenuId}
        onMoved={onMoved}
        onDeleted={onDeleted}
      />
    </div>
  );
});
