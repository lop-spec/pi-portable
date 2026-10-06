"use client";

import { useEffect, useRef, useState } from "react";

type Result = { handled: boolean; error?: string };
type FollowupProps = {
  disabled: boolean;
  run?: (command: string) => Promise<Result>;
  load?: () => unknown;
  /** lop-followup 扩展的状态文字（extensionStatuses 里 key 为 "lop-followup" 的 text），用来标出当前模式。 */
  status?: string | null;
  /** 只显示图标（窄屏输入框）。 */
  iconOnly?: boolean;
};

// 文案取自 lop-followup 扩展的实际行为：每轮追问一句，直到模型最后一行写出确认语，最多 8 轮。
const MAX_FOLLOWUPS = 8;
const modes = [
  { mode: "thorough", label: "彻底", status: "目标 · 彻底", hint: "追问到回复“已确认彻底”" },
  { mode: "target", label: "达标", status: "目标 · 达标", hint: "追问到回复“已确认达标”" },
  { mode: "root-cause", label: "根因", status: "目标 · 根因", hint: "追问到回复“已确认根因”" },
  { mode: "root-fix", label: "根治", status: "目标 · 根治", hint: "追问到回复“已确认根治”" },
  { mode: "plan", label: "校准并执行", status: "计划", hint: "先校准方案，确认后按方案执行" },
] as const;

export type FollowupState = { mode: string; label: string; phase: "armed" | "paused" | "active"; progress: string };

/** 解析扩展状态「自动追问 · 目标 · 根因 · 3/8」「… · 已暂停」「… · 待发送」。 */
export function parseFollowupStatus(text: string | null | undefined): FollowupState | null {
  const match = String(text ?? "").trim().match(/^自动追问\s*·\s*(.*?)\s*·\s*(已暂停|待发送|\d+\/\d+)$/u);
  if (!match) return null;
  const entry = modes.find((item) => item.status === match[1]);
  if (!entry) return null;
  const phase = match[2] === "已暂停" ? "paused" : match[2] === "待发送" ? "armed" : "active";
  return { mode: entry.mode, label: entry.label, phase, progress: match[2] };
}

const RepeatIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5h5v5h-5z" /></svg>
);

export function PortableFollowup({ disabled, run, load, status, iconOnly = false }: FollowupProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = parseFollowupStatus(status);
  const phaseText = current ? (current.phase === "paused" ? "已暂停" : current.phase === "armed" ? "待发送" : `第 ${current.progress} 轮`) : "";
  const triggerLabel = current ? `自动追问：${current.label}（${phaseText}）` : "自动追问";
  useEffect(() => {
    if (!open) return;
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]');
    const checked = root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  async function select(mode: string) {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      if (!run) throw new Error("命令通道不可用");
      let commands = await load?.();
      const hasExtension = (value: unknown) => Array.isArray(value) && value.some(item => item?.name === "lop-followup" && item?.source === "extension");
      if (!hasExtension(commands)) {
        const result = await run("/reload");
        if (result.error) throw new Error(result.error);
        commands = await load?.();
      }
      if (!hasExtension(commands)) throw new Error("自动追问扩展未加载");
      const result = await run(`/lop-followup-ui ${mode}`);
      if (!result.handled || result.error) throw new Error(result.error || "自动追问命令未处理");
      setOpen(false); requestAnimationFrame(() => trigger.current?.focus());
    } catch (cause) {
      console.error("[lop-followup-ui] command failed:", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  return <div ref={root} className="pw-followup" onBlur={event => {
    if (!busy && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') || [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
  }}>
    <button
      ref={trigger}
      type="button"
      disabled={disabled || busy}
      className={`pw-composer-chip pw-followup-trigger${current ? " is-on" : ""}${iconOnly ? " is-icon" : ""}`}
      data-phase={current?.phase}
      aria-label={triggerLabel}
      aria-busy={busy}
      title={busy ? "正在设置自动追问模式…" : current ? `${triggerLabel}，点击切换或停止` : "自动追问：选择一种模式，模型答完后自动继续追问"}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => { setError(""); setOpen(value => !value); }}
    >
      <RepeatIcon />
      {!iconOnly && <span className="pw-composer-chip-text">{current ? <>追问<span className="pw-composer-chip-sep">·</span>{current.label}</> : "追问"}</span>}
      {current && <span className={`pw-dot${current.phase === "paused" ? " pw-dot--muted" : ""}`} aria-hidden="true" />}
    </button>
    {open && <div className="pw-menu pw-menu--up pw-followup-menu" role="menu" aria-label="自动追问模式">
      <div className="pw-menu-header"><span>自动追问</span><span>{current ? `${current.label} · ${phaseText}` : `最多 ${MAX_FOLLOWUPS} 轮`}</span></div>
      {modes.map(({ mode, label, hint }) => {
        const checked = current?.mode === mode;
        return (
          <button key={mode} type="button" role="menuitemradio" aria-checked={checked} className="pw-menu-item pw-menu-item--two" data-lop-followup-action={mode} disabled={busy || disabled} onClick={() => void select(mode)}>
            <span className="pw-menu-check">{checked && <CheckIcon />}</span>
            <span className="pw-menu-text">
              <span className="pw-menu-title">{label}</span>
              <span className="pw-menu-sub">{hint}</span>
            </span>
          </button>
        );
      })}
      <div className="pw-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="pw-menu-item" data-lop-followup-action="off" disabled={busy || disabled} onClick={() => void select("off")}>
        <StopIcon /><span className="pw-menu-label">停止自动追问</span>
      </button>
      {error && <p className="pw-followup-error" role="alert">{error}</p>}
    </div>}
  </div>;
}
