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

const headerStyle = (border: boolean, dense = false): CSSProperties => ({ padding: dense ? "4px 12px 1px" : "6px 12px 4px", borderTop: border ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: 0, textTransform: "uppercase" });
const noteStyle: CSSProperties = { padding: "6px 12px", color: "var(--text-dim)", fontSize: 11 };
const footRowStyle = (open: boolean, tone: string): CSSProperties => ({ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 12px", border: "none", background: open ? "var(--bg-hover)" : "none", color: tone, cursor: "pointer", fontSize: 12, textAlign: "left" });

const Icon = ({ children, size = 12, fill = "none", width = 2 }: { children: ReactNode; size?: number; fill?: string; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const StarIcon = ({ filled }: { filled: boolean }) => <Icon fill={filled ? "currentColor" : "none"}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></Icon>;
const EyeIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Icon>;
const EyeOffIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" y1="2" x2="22" y2="22" /></Icon>;
const ArchiveIcon = () => <Icon size={12}><path d="M3 8h18v13H3z" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></Icon>;
const CheckIcon = () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>;

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
      style={{ display: "inline-flex", flexShrink: 0, ...(first ? { marginLeft: "auto", paddingLeft: 12 } : { paddingLeft: 8 }), color: accent ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
    >
      {children}
    </span>
  );
}

// The side panel lists every other model, so its rows are tighter than the main menu's (26 px, not 32).
const PIN_CSS = `.pw-model-row .pw-model-pin{opacity:0;transition:opacity .12s}.pw-model-row:hover .pw-model-pin,.pw-model-row .pw-model-pin:focus-visible{opacity:.85}@media (hover:none){.pw-model-row .pw-model-pin{opacity:.6}}.pw-model-side .pw-model-row{padding-top:4px!important;padding-bottom:4px!important}`;

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
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; onEnter?.(); }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
      style={{ ...footRowStyle(false, status.error ? "#dc4444" : "var(--text-muted)"), alignItems: "flex-start", opacity: status.busy ? 0.6 : 1, cursor: status.busy ? "default" : "pointer" }}
    >
      <span style={{ display: "inline-flex", paddingTop: 2 }}><ArchiveIcon /></span>
      <span style={{ lineHeight: 1.45 }}>{status.busy ? "归档中…" : status.text || `一键归档超过 ${ARCHIVE_OLDER_DAYS} 天的对话`}</span>
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
      {all.length > 1 && <div style={headerStyle(index > 0 || leadBorder, dense)}>{group.provider}</div>}
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

  if (filterActive) return <><style>{PIN_CSS}</style>{groups(filtered, hasClear)}</>;
  if (split.fallback) return <><style>{PIN_CSS}</style>{groups(split.primary, hasClear)}</>;

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
    overflowY: "auto",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
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
  const hiddenEmpty = <div style={noteStyle}>还没有隐藏的模型：点模型行尾的眼睛图标即可隐藏</div>;
  const hiddenRow = (
    <button
      ref={hiddenRef}
      type="button"
      aria-haspopup="true"
      aria-expanded={hiddenOpen}
      onClick={() => openHidden(true)}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; if (!isMobile) openHidden(false); }}
      onMouseLeave={(event) => { event.currentTarget.style.background = hiddenOpen ? "var(--bg-hover)" : "none"; }}
      style={{ ...footRowStyle(hiddenOpen, currentHidden ? "var(--text)" : "var(--text-muted)"), whiteSpace: "nowrap" }}
    >
      {currentHidden ? <CheckIcon /> : <span style={{ width: 10, flexShrink: 0 }} />}
      <span>隐藏模型</span>
      {currentHidden && <span title={currentHidden.name} style={{ minWidth: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>· {currentHidden.name}</span>}
      <span style={{ marginLeft: "auto", paddingLeft: 12, display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-dim)" }}>
        {split.hidden.length}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: hiddenInline ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </span>
    </button>
  );

  return (
    <>
      <style>{PIN_CSS}</style>
      {split.primary.map((option) => (
        <div key={modelMenuKey(option)} onMouseEnter={() => { if (!isMobile) setMoreOpen(false); }}>{row(option)}</div>
      ))}
      <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 0" }} />
      <button
        ref={moreRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={moreOpen}
        onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; if (!isMobile) openMore(); }}
        onMouseLeave={(event) => { event.currentTarget.style.background = moreOpen && isMobile ? "var(--bg-hover)" : "none"; }}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", border: "none", background: moreOpen ? "var(--bg-hover)" : "none", color: current ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left", whiteSpace: "nowrap" }}
      >
        {current ? <CheckIcon /> : <span style={{ width: 10, flexShrink: 0 }} />}
        <span>更多模型</span>
        {current && <span title={current.name} style={{ minWidth: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>· {current.name}</span>}
        <span style={{ marginLeft: "auto", paddingLeft: 12, display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-dim)" }}>
          {split.more.length}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: isMobile && moreOpen ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </span>
      </button>
      {moreOpen && (isMobile || !sideStyle
        ? <div>
            {groups(split.more, true)}
            <div style={{ borderTop: "1px solid var(--border)" }}>{hiddenRow}</div>
            {hiddenInline && <div style={{ paddingLeft: 10 }}>{split.hidden.length ? groups(split.hidden, false) : hiddenEmpty}</div>}
            <ArchiveOlderButton />
          </div>
        : <>
            <div ref={sideRef} role="group" aria-label="更多模型" className="pw-model-side" style={sideStyle}>
              {groups(split.more, false, true, closeHidden)}
              {split.more.length === 0 && <div style={noteStyle}>没有其他模型</div>}
              {hiddenInline && <div style={{ borderTop: "1px solid var(--border)" }}>{split.hidden.length ? groups(split.hidden, false, true) : hiddenEmpty}</div>}
              <div style={{ position: "sticky", bottom: 0, background: "var(--bg)", borderTop: "1px solid var(--border)" }}>
                {hiddenRow}
                <ArchiveOlderButton onEnter={closeHidden} />
                <div style={{ padding: "2px 12px 5px", color: "var(--text-dim)", fontSize: 10 }} onMouseEnter={closeHidden}>星标 = 设为主力 · 眼睛 = 隐藏</div>
              </div>
            </div>
            {hiddenOpen && flyStyle && (
              <div role="group" aria-label="隐藏模型" className="pw-model-side" style={flyStyle}>
                {split.hidden.length ? groups(split.hidden, false, true) : hiddenEmpty}
                <div style={{ padding: "4px 12px 5px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10 }}>眼睛 = 放回更多模型 · 星标 = 设为主力</div>
              </div>
            )}
          </>)}
    </>
  );
}
