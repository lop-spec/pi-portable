"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getAgentChoice, setAgentChoice, subscribeAgentChoice, type AgentChoice } from "@/lib/portable-agent-choice";

const AGENTS: Array<{ id: AgentChoice; label: string; hint: string }> = [
  { id: "pi", label: "Pi", hint: "Pi 的提示词与工具" },
  { id: "cline", label: "Cline", hint: "Cline 的提示词与工具；模型、会话与扩展工具不变，下一条消息生效" },
];

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

/** Pi | Cline for the next prompt. Renders nothing where Cline is not installed. */
export function PortableAgentSwitch({ sessionKey }: { sessionKey?: string }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    void clineInstalled().then((value) => { if (current) setAvailable(value); });
    return () => { current = false; };
  }, []);
  const agent = useSyncExternalStore(subscribeAgentChoice, () => getAgentChoice(sessionKey), () => "pi" as AgentChoice);
  if (!available) return null;
  return (
    <div className="pw-agent-switch" role="radiogroup" aria-label="Agent">
      {AGENTS.map(({ id, label, hint }) => (
        <button key={id} type="button" role="radio" aria-checked={agent === id} title={hint} data-pi-agent={id} onClick={() => setAgentChoice(sessionKey, id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
