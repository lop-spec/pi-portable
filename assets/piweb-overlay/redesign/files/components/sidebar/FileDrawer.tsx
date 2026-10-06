"use client";
// 文件抽屉（方向 A spec §2.5，审计 D09）：默认收起，只占一条 38px 的栏「˄ 文件 · 项目名」+ 终端/搜索/上传/刷新；
// 点栏或 Ctrl Shift E 展开。展开后从底部向上占位，默认侧栏高度的 40%，顶边拖拽条可调高
// （最小 160px，最大保证会话列表至少 6 行），开合与高度记在 localStorage["pi-web:file-drawer"]。
// 展开不做高度动画，直接到位。
import { memo, useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { FileExplorer, type FileExplorerHandle } from "../FileExplorer";
import { Icon } from "./icons";

const STORAGE_KEY = "pi-web:file-drawer";
const MIN_HEIGHT = 160;
const DEFAULT_RATIO = 0.4;

interface DrawerState { open: boolean; height: number | null }

function readDrawerState(): DrawerState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { open: false, height: null };
    const parsed = JSON.parse(raw) as Partial<DrawerState>;
    return {
      open: parsed.open === true,
      height: typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : null,
    };
  } catch (error) {
    console.error("[pi-web sidebar] file drawer state unreadable; using defaults", error);
    return { open: false, height: null };
  }
}

function writeDrawerState(state: DrawerState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("[pi-web sidebar] file drawer state not saved", error);
  }
}

export interface FileDrawerProps {
  cwd: string;
  rootLabel: string;
  explorerRefreshKey?: number;
  /** 侧栏总高度（默认高度取它的 40%） */
  getSidebarHeight: () => number;
  /** 抽屉内容区最大高度：保证会话列表至少留 6 行 */
  getMaxHeight: () => number;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}

export const FileDrawer = memo(function FileDrawer({
  cwd,
  rootLabel,
  explorerRefreshKey,
  getSidebarHeight,
  getMaxHeight,
  onOpenFile,
  onOpenTerminal,
  onExplorerRefresh,
  onAtMention,
  onAtMentions,
}: FileDrawerProps) {
  const bodyId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const explorerRef = useRef<FileExplorerHandle>(null);
  const [state, setState] = useState<DrawerState>({ open: false, height: null });
  const [explorerKey, setExplorerKey] = useState(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [refreshDone, setRefreshDone] = useState(false);
  const [resizing, setResizing] = useState(false);
  const pendingUploadRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveHeightRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; max: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // localStorage 只在浏览器里可读：挂载后恢复上次的开合与高度。
  useEffect(() => { setState(readDrawerState()); }, []);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((key) => key + 1);
  }, [explorerRefreshKey]);

  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  const clampHeight = useCallback((height: number) => {
    const max = Math.max(MIN_HEIGHT, getMaxHeight());
    return Math.round(Math.min(max, Math.max(MIN_HEIGHT, height)));
  }, [getMaxHeight]);

  const defaultHeight = useCallback(() => clampHeight(getSidebarHeight() * DEFAULT_RATIO), [clampHeight, getSidebarHeight]);
  const effectiveHeight = state.open ? clampHeight(state.height ?? defaultHeight()) : 0;
  liveHeightRef.current = effectiveHeight;

  // 窗口变矮时重新夹住高度（只影响显示，不改存档）。
  const [, forceLayout] = useState(0);
  useEffect(() => {
    if (!state.open) return;
    const onResize = () => forceLayout((value) => value + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state.open]);

  const setOpen = useCallback((open: boolean) => {
    setState((previous) => {
      const next = { ...previous, open };
      writeDrawerState(next);
      return next;
    });
  }, []);

  const toggle = useCallback(() => setOpen(!stateRef.current.open), [setOpen]);

  // Ctrl Shift E 开关文件抽屉（与现有快捷键不冲突）。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "e") return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  // 收起状态点「上传」：先展开，FileExplorer 挂载后再打开文件选择（仍在同一次用户操作的激活窗口内）。
  useEffect(() => {
    if (!state.open || !pendingUploadRef.current) return;
    const id = requestAnimationFrame(() => {
      if (!pendingUploadRef.current) return;
      pendingUploadRef.current = false;
      explorerRef.current?.openUploadPicker();
    });
    return () => cancelAnimationFrame(id);
  });

  const commitHeight = useCallback((height: number) => {
    setState((previous) => {
      const next = { ...previous, height: clampHeight(height) };
      writeDrawerState(next);
      return next;
    });
  }, [clampHeight]);

  const applyLiveHeight = (height: number) => {
    liveHeightRef.current = height;
    sectionRef.current?.style.setProperty("--pw-fd-h", `${height}px`);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: liveHeightRef.current, max: Math.max(MIN_HEIGHT, getMaxHeight()) };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setResizing(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = Math.round(Math.min(drag.max, Math.max(MIN_HEIGHT, drag.startHeight + (drag.startY - event.clientY))));
    applyLiveHeight(next);
    event.currentTarget.setAttribute("aria-valuenow", String(next));
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setResizing(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已被浏览器释放 */ }
    commitHeight(liveHeightRef.current);
  };
  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowUp") { event.preventDefault(); commitHeight(liveHeightRef.current + step); }
    else if (event.key === "ArrowDown") { event.preventDefault(); commitHeight(liveHeightRef.current - step); }
    else if (event.key === "Home") { event.preventDefault(); commitHeight(MIN_HEIGHT); }
    else if (event.key === "End") { event.preventDefault(); commitHeight(getMaxHeight()); }
    else if (event.key === "Enter") { event.preventDefault(); commitHeight(defaultHeight()); }
  };

  const refresh = () => {
    if (onExplorerRefresh) onExplorerRefresh();
    else setExplorerKey((key) => key + 1);
    setRefreshDone(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
  };

  const open = state.open;
  return (
    <section
      ref={sectionRef}
      className={`pw-fd${open ? " is-open" : ""}${resizing ? " is-resizing" : ""}`}
      aria-label="文件浏览器"
      style={{ "--pw-fd-h": `${effectiveHeight}px` } as CSSProperties}
    >
      {open && (
        <div
          className={`pw-fd-resize sidebar-section-resize-handle${resizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar-sections"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="调整文件区高度"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={Math.max(MIN_HEIGHT, getMaxHeight())}
          aria-valuenow={effectiveHeight}
          title="拖动调整文件区高度；双击或按 Enter 恢复默认"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          onDoubleClick={() => commitHeight(defaultHeight())}
          onKeyDown={onResizeKeyDown}
        />
      )}
      <div className="pw-fd-bar">
        <button
          type="button"
          className="pw-fd-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? "收起文件浏览器（Ctrl Shift E）" : "展开文件浏览器（Ctrl Shift E）"}
          onClick={toggle}
        >
          <Icon name={open ? "down" : "up"} size={12} />
          <span>文件</span>
          <span className="pw-fd-root">{rootLabel}</span>
        </button>
        <div className="pw-fd-tools">
          {onOpenTerminal && (
            <button type="button" className="pw-icon-btn pw-icon-btn--sm" aria-label="打开终端" title="在此目录打开终端" onClick={() => onOpenTerminal(cwd)}>
              <Icon name="terminal" />
            </button>
          )}
          {open && changesCount > 0 && (
            <button
              type="button"
              className="pw-icon-btn pw-icon-btn--sm pw-fd-changes"
              aria-pressed={!changesCollapsed}
              aria-label={`${changesCount} 个变更文件`}
              title={`${changesCount} 个变更文件`}
              onClick={() => setChangesCollapsed((value) => !value)}
            >
              <Icon name="changes" />
              <span className="pw-fd-changes-count pw-num" aria-hidden="true">{changesCount > 99 ? "99+" : changesCount}</span>
            </button>
          )}
          <button
            type="button"
            className="pw-icon-btn pw-icon-btn--sm"
            aria-pressed={open && fileSearchOpen}
            aria-label="搜索文件"
            title="搜索文件"
            onClick={() => {
              if (!open) { setOpen(true); setFileSearchOpen(true); return; }
              setFileSearchOpen((value) => !value);
            }}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="pw-icon-btn pw-icon-btn--sm"
            disabled={uploadBusy}
            aria-label="上传文件"
            title="将文件上传到项目根目录"
            onClick={() => {
              if (!open) { pendingUploadRef.current = true; setOpen(true); return; }
              explorerRef.current?.openUploadPicker();
            }}
          >
            <Icon name="upload" />
          </button>
          <button
            type="button"
            className={`pw-icon-btn pw-icon-btn--sm${refreshDone ? " is-done" : ""}`}
            aria-label="刷新文件浏览器"
            title={refreshDone ? "已刷新" : "刷新文件浏览器"}
            onClick={refresh}
          >
            <Icon name={refreshDone ? "check" : "refresh"} />
          </button>
        </div>
      </div>
      {open && (
        <div id={bodyId} className="pw-fd-body">
          <FileExplorer
            ref={explorerRef}
            cwd={cwd}
            onOpenFile={onOpenFile ?? noopOpenFile}
            refreshKey={explorerKey}
            onAtMention={onAtMention}
            onAtMentions={onAtMentions}
            onUploadBusyChange={setUploadBusy}
            changesCollapsed={changesCollapsed}
            onChangesCountChange={setChangesCount}
            fileSearchOpen={fileSearchOpen}
            onFileSearchOpenChange={setFileSearchOpen}
          />
        </div>
      )}
    </section>
  );
});

function noopOpenFile() {}
