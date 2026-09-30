"use client";

// Claude-style model list (lop 2026-09-29): primary models directly, the rest under
// "更多模型" (a side panel on desktop, inline on phones). The star on a row pins or unpins
// that model; the choice is kept by /api/model-menu for every browser of this pi-web.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { modelMenuKey, normalizeModelMenu, placeSidePanel, splitModelMenu, togglePrimaryModel } from "@/lib/portable-model-menu.mjs";
import type { ModelSelectorOption } from "./ModelSelector";

type ModelMenu = { primary: string[]; custom: boolean };
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
  const toggle = useCallback(async (key: string) => {
    const before = cached ?? normalizeModelMenu(null);
    const next = { primary: togglePrimaryModel(before.primary, key), custom: true };
    publish(next);
    try {
      const reply = await fetch("/api/model-menu", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary: next.primary }) });
      if (!reply.ok) throw new Error(`HTTP ${reply.status} ${await reply.text()}`);
      publish(normalizeModelMenu(await reply.json()));
    } catch (error) {
      console.error("[pi-web model menu] save failed; change reverted", error);
      publish(before);
    }
  }, []);
  return { menu: menu ?? normalizeModelMenu(null), loaded: menu !== null, toggle };
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

function ModelPin({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  const label = pinned ? "移出主力（放进更多模型）" : "设为主力（直接显示在列表里）";
  const act = (event: { preventDefault: () => void; stopPropagation: () => void }) => { event.preventDefault(); event.stopPropagation(); onToggle(); };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`pw-model-pin${pinned ? " is-pinned" : ""}`}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={act}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") act(event); }}
      style={{ display: "inline-flex", flexShrink: 0, marginLeft: "auto", paddingLeft: 12, color: pinned ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </span>
  );
}

// The side panel lists every other model, so its rows are tighter than the main menu's (26 px, not 32).
const PIN_CSS = `.pw-model-row .pw-model-pin{opacity:0;transition:opacity .12s}.pw-model-row:hover .pw-model-pin,.pw-model-row .pw-model-pin:focus-visible{opacity:.85}@media (hover:none){.pw-model-row .pw-model-pin{opacity:.6}}.pw-model-side .pw-model-row{padding-top:4px!important;padding-bottom:4px!important}`;

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
  const { menu, toggle } = useModelMenu();
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreRect, setMoreRect] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pinned = new Set(menu.primary);
  const row = (option: ModelSelectorOption) => renderOption(option, <ModelPin pinned={pinned.has(modelMenuKey(option))} onToggle={() => void toggle(modelMenuKey(option))} />);
  const groups = (list: ModelSelectorOption[], leadBorder: boolean, dense = false) => groupByProvider(list).map((group, index, all) => (
    <div key={group.provider}>
      {all.length > 1 && <div style={headerStyle(index > 0 || leadBorder, dense)}>{group.provider}</div>}
      {group.options.map((option) => <div key={modelMenuKey(option)}>{row(option)}</div>)}
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

  if (filterActive) return <><style>{PIN_CSS}</style>{groups(filtered, hasClear)}</>;
  const split: { primary: ModelSelectorOption[]; more: ModelSelectorOption[]; fallback: boolean } = splitModelMenu(options, menu.primary);
  if (split.fallback || split.more.length === 0) return <><style>{PIN_CSS}</style>{split.fallback ? groups(split.primary, hasClear) : split.primary.map((option) => <div key={modelMenuKey(option)}>{row(option)}</div>)}</>;

  const current = split.more.find(isActive);
  const viewportWidth = typeof window === "undefined" ? 0 : window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 0 : window.visualViewport?.height ?? window.innerHeight;
  // The panel sits beside the whole menu, not beside the "更多模型" row: the row is as wide as the menu.
  const place = moreRect && !isMobile ? placeSidePanel(moreRect, { width: viewportWidth }) : null;
  const sideStyle: CSSProperties | null = place ? {
    position: "fixed",
    ...(place.side === "right" ? { left: place.left } : { right: place.right }),
    bottom: Math.max(8, viewportHeight - moreRect!.bottom - 5),
    maxHeight: Math.max(120, moreRect!.bottom - 3),
    width: "max-content",
    minWidth: 200,
    maxWidth: place.maxWidth,
    zIndex: 501,
    overflowY: "auto",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
  } : null;

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
        {current
          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
          : <span style={{ width: 10, flexShrink: 0 }} />}
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
        ? <div>{groups(split.more, true)}</div>
        : <div role="group" aria-label="更多模型" className="pw-model-side" style={sideStyle}>
            {groups(split.more, false, true)}
            <div style={{ padding: "4px 12px 5px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10 }}>星标 = 设为主力</div>
          </div>)}
    </>
  );
}
