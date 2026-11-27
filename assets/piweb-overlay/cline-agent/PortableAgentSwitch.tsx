"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAgentChoice, setAgentChoice, setAgentAvailability, subscribeAgentChoice, type AgentChoice } from "@/lib/portable-agent-choice";

const AGENTS: Array<{ id: AgentChoice; label: string; hint: string }> = [
  { id: "pi", label: "Pi", hint: "Pi 的提示词与工具" },
  { id: "cline", label: "Cline", hint: "Cline 的提示词与工具；模型、会话与扩展工具不变，下一条消息生效" },
  { id: "opencode", label: "OpenCode", hint: "OpenCode 精简模式；下一条消息生效" },
];
const MENU_WIDTH = 200;
const MENU_INSET = 8;

const ChevronIcon = () => <svg className="pw-composer-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
const CheckIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;

type InstalledAgents = { installed?: boolean; opencode?: boolean };
let installed: Promise<InstalledAgents> | undefined;
function installedAgents(): Promise<InstalledAgents> {
  installed ??= fetch("/api/cline-agent")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<InstalledAgents>;
    })
    .then((value) => { setAgentAvailability(value); return value; })
    .catch((error) => {
      console.error("[pi-web] agent availability check failed:", error);
      installed = undefined;
      return {};
    });
  return installed;
}

/** Agent for the next prompt, as a composer dropdown. Renders nothing where Cline is not installed. */
export function PortableAgentSwitch({ sessionKey }: { sessionKey?: string }) {
  const [available, setAvailable] = useState<InstalledAgents>({});
  const [menuRight, setMenuRight] = useState<number | null>(null);
  const open = menuRight !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    void installedAgents().then((value) => { if (current) setAvailable(value); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuRight(null);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);
  const choice = useSyncExternalStore(subscribeAgentChoice, () => getAgentChoice(sessionKey), () => "cline" as AgentChoice);
  if (!available.installed && !available.opencode) return null;
  const agents = AGENTS.filter(({ id }) => id === "pi" || (id === "cline" ? available.installed : available.opencode));
  const selected = agents.find(({ id }) => id === choice) ?? AGENTS[0];
  const agent = selected.id;
  return (
    <div
      ref={rootRef}
      className="pw-composer-dropdown"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setMenuRight(null);
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
        onClick={(event) => {
          const { right } = event.currentTarget.getBoundingClientRect();
          setMenuRight(open ? null : Math.min(0, right - MENU_WIDTH - MENU_INSET));
        }}
      >
        <span className="pw-composer-chip-text">{selected.label}</span>
        <ChevronIcon />
      </button>
      {menuRight !== null && (
        <div
          className="pw-menu pw-menu--up pw-composer-menu"
          role="menu"
          aria-label="Agent"
          style={{ position: "absolute", bottom: "calc(100% + 6px)", right: menuRight, width: MENU_WIDTH }}
        >
          {agents.map(({ id, label, hint }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={agent === id}
              className="pw-menu-item"
              title={hint}
              data-pi-agent={id}
              onClick={() => { setMenuRight(null); setAgentChoice(sessionKey, id); }}
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
