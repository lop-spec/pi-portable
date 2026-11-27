"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_AGENT, agentAvailable, getDefaultAgent, isAgentChoice, loadInstalledAgents, setDefaultAgent, subscribeAgentChoice, type AgentChoice, type InstalledAgents } from "@/lib/portable-agent-choice";

const options: [AgentChoice, string][] = [["opencode", "OpenCode"], ["pi", "Pi"], ["cline", "Cline"]];

export function DefaultAgentSetting() {
  const choice = useSyncExternalStore(subscribeAgentChoice, getDefaultAgent, () => DEFAULT_AGENT);
  const [available, setAvailable] = useState<InstalledAgents | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    void loadInstalledAgents().then((value) => { if (mounted) setAvailable(value); });
    return () => { mounted = false; };
  }, []);
  return <>
    <label className="pw-default-field" htmlFor="pw-default-agent">
      <span>默认 Agent</span>
      <select id="pw-default-agent" value={choice} disabled={!available} aria-describedby="pw-default-agent-note" onChange={(event) => {
        const value = event.target.value;
        if (isAgentChoice(value)) setFailed(!setDefaultAgent(value));
      }}>
        {options.map(([id, label]) => <option key={id} value={id} disabled={available !== null && !agentAvailable(id, available)}>{label}{available !== null && !agentAvailable(id, available) ? "（不可用）" : ""}</option>)}
      </select>
    </label>
    <p id="pw-default-agent-note" className="settings-general-description">选中即生效；单独选择的会话不变。</p>
    {failed && <p className="settings-general-error" role="alert">无法保存默认 Agent。</p>}
  </>;
}
