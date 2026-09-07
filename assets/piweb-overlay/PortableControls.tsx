"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

type Result = { handled: boolean; error?: string };
type FollowupProps = {
  disabled: boolean;
  run?: (command: string) => Promise<Result>;
  load?: () => unknown;
};
const modes = [["thorough", "彻底"], ["target", "达标"], ["root-cause", "根因"], ["root-fix", "根治"], ["plan", "校准并执行"], ["off", "停止自动追问"]];

export function PortableFollowup({ disabled, run, load }: FollowupProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
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
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
  }}>
    <button ref={trigger} type="button" disabled={disabled || busy} className="pw-icon-button" aria-label="自动追问模式" aria-busy={busy} title={busy ? "正在设置自动追问模式…" : "自动追问模式"} aria-haspopup="menu" aria-expanded={open} onClick={() => { setError(""); setOpen(value => !value); }}>＋</button>
    {open && <div className="pw-followup-menu" role="menu" aria-label="自动追问模式">
      {modes.map(([mode, label]) => <button key={mode} type="button" role="menuitem" data-lop-followup-action={mode} disabled={busy || disabled} onClick={() => void select(mode)}>{label}</button>)}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}

export function PortableScrollBottom({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let frame = 0;
    const update = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setAway(element.scrollHeight - element.clientHeight - element.scrollTop > 8); }); };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    element.addEventListener("scroll", update, { passive: true }); update();
    return () => { resize.disconnect(); element.removeEventListener("scroll", update); cancelAnimationFrame(frame); };
  }, [container]);
  return away ? <button type="button" className="pw-scroll-bottom" data-pw-scroll-bottom="true" title="回到底部" aria-label="回到底部" onClick={() => {
    const element = container.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }}>↓</button> : null;
}
