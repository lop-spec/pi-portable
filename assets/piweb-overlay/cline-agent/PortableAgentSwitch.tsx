"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAgentChoice, setAgentChoice, subscribeAgentChoice, type AgentChoice } from "@/lib/portable-agent-choice";

const AGENTS: Array<{ id: AgentChoice; label: string; hint: string }> = [
  { id: "pi", label: "Pi", hint: "Pi 的提示词与工具" },
  { id: "cline", label: "Cline", hint: "Cline 的提示词与工具；模型、会话与扩展工具不变，下一条消息生效" },
];

const ChevronIcon = () => <svg className="pw-composer-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
const CheckIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;

let installed: Promise<boolean> | undefined;
function clineInstalled(): Promise<boolean> {
  installed ??= fetch("/api/cline-agent")
    .then((res) => (res.ok ? res.json() : null))
    .then((body: { installed?: boolean } | null) => body?.installed === true)
    .catch((error) => {
      console.error("[pi-web] Cline availability check failed:", error);
      installed = undefined;
      return false;
    });
  return installed;
}

/** Agent for the next prompt, as a composer dropdown. Renders nothing where Cline is not installed. */
export function PortableAgentSwitch({ sessionKey }: { sessionKey?: string }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    void clineInstalled().then((value) => { if (current) setAvailable(value); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);
  const agent = useSyncExternalStore(subscribeAgentChoice, () => getAgentChoice(sessionKey), () => "cline" as AgentChoice);
  if (!available) return null;
  const selected = AGENTS.find(({ id }) => id === agent) ?? AGENTS[0];
  return (
    <div
      ref={rootRef}
      className="pw-composer-dropdown"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLElement>("button")?.focus();
      }}
    >
      <button
        type="button"
        className="pw-composer-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Agent"
        title={selected.hint}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pw-composer-chip-text">{selected.label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          className="pw-menu pw-menu--up pw-composer-menu"
          role="menu"
          aria-label="Agent"
          style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0 }}
        >
          {AGENTS.map(({ id, label, hint }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={agent === id}
              className="pw-menu-item"
              title={hint}
              data-pi-agent={id}
              onClick={() => { setOpen(false); setAgentChoice(sessionKey, id); }}
            >
              <span className="pw-menu-check">{agent === id && <CheckIcon />}</span>
              <span className="pw-menu-label">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
