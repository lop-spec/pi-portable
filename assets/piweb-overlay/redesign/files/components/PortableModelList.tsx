"use client";

// Claude-style model list (lop 2026-09-29): primary models directly, the rest under
// "更多模型" (a side panel on desktop, inline on phones). The star on a row pins or unpins
// that model; the choice is kept by /api/model-menu for every browser of this pi-web.
// 2026-10-04: the eye on a row hides it into "隐藏模型", a third level at the bottom of
// "更多模型", and the same panel carries "一键归档超过 7 天的对话".
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ARCHIVE_OLDER_DAYS, archiveOlderSummary, hideModel, modelMenuKey, normalizeModelMenu, pinModel, placeNestedPanel, placeSidePanel, splitModelMenu } from "@/lib/portable-model-menu.mjs";
import type { ModelSelectorOption } from "./ModelSelector";

declare global {
  interface Window {
    /** Set by the UI proxy's injected archive script (src/piweb-archive-ui.js). */
    __piArchiveOlder?: (days: number) => Promise<{ groupCount?: number; skippedRunning?: number; failed?: number }>;
  }
}

type ModelMenu = { primary: string[]; hidden: string[]; custom: boolean };
// side is a plain string: the placement helpers are untyped .mjs and infer it that way.
type SidePlace = { side: string; maxWidth: number; left: number; right: number };
let cached: ModelMenu | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const publish = (menu: ModelMenu) => { cached = menu; listeners.forEach((listener) => listener()); };

function loadModelMenu(): Promise<void> {
  loading ??= fetch("/api/model-menu", { cache: "no-store" })
    .then(async (reply) => {
      if (!reply.ok) throw new Error(`HTTP ${reply.status} ${await reply.text()}`);
      return reply.json();
    })
    .then((value) => publish(normalizeModelMenu(value)))
    .catch((error) => {
      console.error("[pi-web model menu] load failed; showing the default primary models", error);
      if (!cached) publish(normalizeModelMenu(null));
    })
    .finally(() => { loading = null; });
  return loading;
}

export function useModelMenu() {
  const [menu, setMenu] = useState<ModelMenu | null>(cached);
  useEffect(() => {
    const listener = () => setMenu(cached);
    listeners.add(listener);
    // Another browser or the phone may have changed it: read it again whenever a menu opens.
    void loadModelMenu();
    return () => { listeners.delete(listener); };
  }, []);
  const save = useCallback(async (edit: (menu: ModelMenu) => { primary: string[]; hidden: string[] }) => {
    const before = cached ?? normalizeModelMenu(null);
    const next = { ...edit(before), custom: true };
    publish(next);
    try {
      const reply = await fetch("/api/model-menu", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary: next.primary, hidden: next.hidden }) });
      if (!reply.ok) throw new Error(`HTTP ${reply.status} ${await reply.text()}`);
      publish(normalizeModelMenu(await reply.json()));
    } catch (error) {
      console.error("[pi-web model menu] save failed; change reverted", error);
      publish(before);
    }
  }, []);
  const togglePin = useCallback((key: string) => save((current) => pinModel(current, key)), [save]);
  const toggleHidden = useCallback((key: string) => save((current) => hideModel(current, key)), [save]);
  return { menu: menu ?? normalizeModelMenu(null), loaded: menu !== null, togglePin, toggleHidden };
}

function groupByProvider(list: ModelSelectorOption[]) {
  const groups: { provider: string; options: ModelSelectorOption[] }[] = [];
  for (const option of list) {
    const group = groups.find((item) => item.provider === option.provider);
    if (group) group.options.push(option);
    else groups.push({ provider: option.provider, options: [option] });
  }
  return groups;
}

// Looks live in app/redesign-chrome.css (.pw-model-*); only geometry stays inline.
const groupClass = (border: boolean, dense = false) => `pw-model-group${border ? " has-border" : ""}${dense ? " is-dense" : ""}`;

const Icon = ({ children, size = 12, fill = "none", width = 2 }: { children: ReactNode; size?: number; fill?: string; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const StarIcon = ({ filled }: { filled: boolean }) => <Icon fill={filled ? "currentColor" : "none"}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></Icon>;
const EyeIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Icon>;
const EyeOffIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" y1="2" x2="22" y2="22" /></Icon>;
const ArchiveIcon = () => <Icon size={12}><path d="M3 8h18v13H3z" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></Icon>;
const CheckIcon = () => <span className="pw-model-row-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg></span>;
const NoCheck = () => <span className="pw-model-row-check" aria-hidden="true" />;
const Arrow = ({ turned }: { turned: boolean }) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`pw-model-arrow${turned ? " is-turned" : ""}`}><polyline points="9 6 15 12 9 18" /></svg>;

/** An icon at a row's end (the star, the eye); shown on hover, always on touch screens. */
function RowAction({ label, pressed, accent, first, onToggle, className, children }: { label: string; pressed: boolean; accent: boolean; first: boolean; onToggle: () => void; className: string; children: ReactNode }) {
  const act = (event: { preventDefault: () => void; stopPropagation: () => void }) => { event.preventDefault(); event.stopPropagation(); onToggle(); };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`pw-model-pin ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={act}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") act(event); }}
      data-first={first || undefined}
      data-accent={accent || undefined}
    >
      {children}
    </span>
  );
}

// The side panel lists every other model, so its rows are tighter than the main menu's: see .pw-model-side in app/redesign-chrome.css.

/** "一键归档超过 7 天的对话": the UI proxy archives them (running and the open one excepted); the answer shows in the button. */
function ArchiveOlderButton({ onEnter }: { onEnter?: () => void }) {
  const [status, setStatus] = useState({ busy: false, text: "", error: false });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const finish = (text: string, error: boolean) => {
    setStatus({ busy: false, text, error });
    timer.current = window.setTimeout(() => setStatus({ busy: false, text: "", error: false }), error ? 8000 : 4000);
  };
  const run = async () => {
    if (status.busy) return;
    window.clearTimeout(timer.current);
    const archive = window.__piArchiveOlder;
    if (!archive) {
      console.error("[pi-web model menu] archive-older unavailable: the page's archive script is not loaded");
      finish("归档组件未就绪，请刷新页面后重试", true);
      return;
    }
    setStatus({ busy: true, text: "", error: false });
    try {
      const summary = archiveOlderSummary(await archive(ARCHIVE_OLDER_DAYS));
      finish(summary.text, summary.error);
    } catch (error) {
      console.error("[pi-web model menu] archive-older failed", error);
      finish(error instanceof Error ? error.message : String(error), true);
    }
  };
  return (
    <button
      type="button"
      disabled={status.busy}
      title={`把超过 ${ARCHIVE_OLDER_DAYS} 天没有更新的对话全部归档（运行中的和当前打开的除外，可在“查看归档会话”里恢复）`}
      onClick={() => void run()}
      onMouseEnter={() => onEnter?.()}
      className="pw-model-foot is-wrap"
      data-tone={status.error ? "danger" : undefined}
      aria-busy={status.busy || undefined}
    >
      <span className="pw-model-foot-icon"><ArchiveIcon /></span>
      <span className="pw-model-foot-text">{status.busy ? "归档中…" : status.text || `一键归档超过 ${ARCHIVE_OLDER_DAYS} 天的对话`}</span>
    </button>
  );
}

interface PortableModelListProps {
  /** Every model, sorted. */
  options: ModelSelectorOption[];
  /** The models matching the filter text. */
  filtered: ModelSelectorOption[];
  filterActive: boolean;
  isMobile: boolean;
  hasClear: boolean;
  isActive: (option: ModelSelectorOption) => boolean;
  renderOption: (option: ModelSelectorOption, trailing: ReactNode) => ReactNode;
}

export function PortableModelList({ options, filtered, filterActive, isMobile, hasClear, isActive, renderOption }: PortableModelListProps) {
  const { menu, togglePin, toggleHidden } = useModelMenu();
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreRect, setMoreRect] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenAnchor, setHiddenAnchor] = useState<{ bottom: number; place: SidePlace } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLButtonElement>(null);
  const pinned = new Set(menu.primary);
  const hiddenKeys = new Set(menu.hidden);
  const split: { primary: ModelSelectorOption[]; more: ModelSelectorOption[]; hidden: ModelSelectorOption[]; fallback: boolean } = splitModelMenu(options, menu.primary, menu.hidden);
  const row = (option: ModelSelectorOption) => {
    const key = modelMenuKey(option);
    const isPinned = pinned.has(key), isHidden = hiddenKeys.has(key);
    const hideLabel = isHidden ? "取消隐藏（放回更多模型）" : "隐藏（放进更多模型里的隐藏模型）";
    return renderOption(option, (
      <>
        <RowAction first accent={isPinned} pressed={isPinned} className={isPinned ? "is-pinned" : ""} label={isPinned ? "移出主力（放进更多模型）" : "设为主力（直接显示在列表里）"} onToggle={() => void togglePin(key)}><StarIcon filled={isPinned} /></RowAction>
        {!isPinned && !split.fallback && <RowAction first={false} accent={false} pressed={isHidden} className="pw-model-hide" label={hideLabel} onToggle={() => void toggleHidden(key)}>{isHidden ? <EyeIcon /> : <EyeOffIcon />}</RowAction>}
      </>
    ));
  };
  const groups = (list: ModelSelectorOption[], leadBorder: boolean, dense = false, onRowEnter?: () => void) => groupByProvider(list).map((group, index, all) => (
    <div key={group.provider}>
      {all.length > 1 && <div className={groupClass(index > 0 || leadBorder, dense)}>{group.provider}</div>}
      {group.options.map((option) => <div key={modelMenuKey(option)} onMouseEnter={onRowEnter}>{row(option)}</div>)}
    </div>
  ));
  const openMore = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (rect) setMoreRect({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    setMoreOpen(true);
  };

  // The side panel is placed from the row's position; a resized window closes it.
  useEffect(() => {
    if (!moreOpen || isMobile) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [moreOpen, isMobile]);
  // Closing 更多模型 closes its third level too, so it does not reappear on the next hover.
  useEffect(() => { if (!moreOpen) { setHiddenOpen(false); setHiddenAnchor(null); } }, [moreOpen]);

  if (filterActive) return <>{groups(filtered, hasClear)}</>;
  if (split.fallback) return <>{groups(split.primary, hasClear)}</>;

  const current = split.more.find(isActive);
  const currentHidden = split.hidden.find(isActive);
  const viewportWidth = typeof window === "undefined" ? 0 : window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 0 : window.visualViewport?.height ?? window.innerHeight;
  // The panel sits beside the whole menu, not beside the "更多模型" row: the row is as wide as the menu.
  const place = moreRect && !isMobile ? placeSidePanel(moreRect, { width: viewportWidth }) : null;
  const panelStyle = (anchor: { bottom: number }, at: SidePlace): CSSProperties => ({
    position: "fixed",
    ...(at.side === "right" ? { left: at.left } : { right: at.right }),
    bottom: Math.max(8, viewportHeight - anchor.bottom - 5),
    maxHeight: Math.max(120, anchor.bottom - 3),
    width: "max-content",
    minWidth: 200,
    maxWidth: at.maxWidth,
    zIndex: 501,
  });
  const sideStyle = place && moreRect ? panelStyle(moreRect, place) : null;
  const flyStyle = hiddenAnchor ? panelStyle(hiddenAnchor, hiddenAnchor.place) : null;
  const hiddenInline = hiddenOpen && !flyStyle;

  // The third level opens beside the second-level panel when there is room, else inside it.
  const openHidden = (byClick: boolean) => {
    if (byClick && hiddenOpen) { setHiddenOpen(false); setHiddenAnchor(null); return; }
    const panel = sideRef.current?.getBoundingClientRect();
    const rowRect = hiddenRef.current?.getBoundingClientRect();
    const nested = !isMobile && panel && rowRect && place ? placeNestedPanel(panel, { width: viewportWidth }, place.side) : null;
    if (nested && rowRect) { setHiddenAnchor({ bottom: rowRect.bottom, place: nested }); setHiddenOpen(true); return; }
    setHiddenAnchor(null);
    if (byClick) setHiddenOpen(true);
  };
  const closeHidden = () => { if (hiddenOpen) { setHiddenOpen(false); setHiddenAnchor(null); } };
  const hiddenEmpty = <div className="pw-model-note">还没有隐藏的模型：点模型行尾的眼睛图标即可隐藏</div>;
  const hiddenRow = (
    <button
      ref={hiddenRef}
      type="button"
      aria-haspopup="true"
      aria-expanded={hiddenOpen}
      onClick={() => openHidden(true)}
      onMouseEnter={() => { if (!isMobile) openHidden(false); }}
      className={`pw-model-foot${hiddenOpen ? " is-open" : ""}${currentHidden ? " is-current" : ""}`}
    >
      {currentHidden ? <CheckIcon /> : <NoCheck />}
      <span>隐藏模型</span>
      {currentHidden && <span title={currentHidden.name} className="pw-model-current-hint">· {currentHidden.name}</span>}
      <span className="pw-model-count">
        {split.hidden.length}
        <Arrow turned={hiddenInline} />
      </span>
    </button>
  );

  return (
    <>
      {split.primary.map((option) => (
        <div key={modelMenuKey(option)} onMouseEnter={() => { if (!isMobile) setMoreOpen(false); }}>{row(option)}</div>
      ))}
      <div className="pw-model-sep" role="separator" />
      <button
        ref={moreRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={moreOpen}
        onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
        onMouseEnter={() => { if (!isMobile) openMore(); }}
        className={`pw-model-foot pw-model-more${moreOpen ? " is-open" : ""}${current ? " is-current" : ""}`}
      >
        {current ? <CheckIcon /> : <NoCheck />}
        <span>更多模型</span>
        {current && <span title={current.name} className="pw-model-current-hint">· {current.name}</span>}
        <span className="pw-model-count">
          {split.more.length}
          <Arrow turned={isMobile && moreOpen} />
        </span>
      </button>
      {moreOpen && (isMobile || !sideStyle
        ? <div>
            {groups(split.more, true)}
            <div className="pw-model-sep" role="separator" />
            {hiddenRow}
            {hiddenInline && <div className="pw-model-nested">{split.hidden.length ? groups(split.hidden, false) : hiddenEmpty}</div>}
            <ArchiveOlderButton />
          </div>
        : <>
            <div ref={sideRef} role="group" aria-label="更多模型" className="pw-model-side" style={sideStyle}>
              {groups(split.more, false, true, closeHidden)}
              {split.more.length === 0 && <div className="pw-model-note">没有其他模型</div>}
              {hiddenInline && <div className="pw-model-nested is-flat has-border">{split.hidden.length ? groups(split.hidden, false, true) : hiddenEmpty}</div>}
              <div className="pw-model-side-foot">
                {hiddenRow}
                <ArchiveOlderButton onEnter={closeHidden} />
                <div className="pw-model-legend" onMouseEnter={closeHidden}>星标 = 设为主力 · 眼睛 = 隐藏</div>
              </div>
            </div>
            {hiddenOpen && flyStyle && (
              <div role="group" aria-label="隐藏模型" className="pw-model-side" style={flyStyle}>
                {split.hidden.length ? groups(split.hidden, false, true) : hiddenEmpty}
                <div className="pw-model-legend has-border">眼睛 = 放回更多模型 · 星标 = 设为主力</div>
              </div>
            )}
          </>)}
    </>
  );
}
