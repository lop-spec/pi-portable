// The default is independent of the composer’s explicit per-session overrides.
export type AgentChoice = "pi" | "cline" | "opencode";
export type InstalledAgents = { installed?: boolean; opencode?: boolean };
type Stored = { defaultAgent?: AgentChoice; sessions?: Record<string, AgentChoice> };

export const DEFAULT_AGENT: AgentChoice = "opencode";
// v2 automatically pinned every prompt, so its saved entries cannot distinguish overrides.
const KEY = "pi-web:agent-v3";
const CHANGED = "pi-web:agent-choice";
const MAX_SESSIONS = 300;

export function isAgentChoice(value: unknown): value is AgentChoice {
  return value === "pi" || value === "cline" || value === "opencode";
}

function read(): Stored {
  if (typeof window === "undefined") return {};
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored | null) ?? {};
  } catch (error) {
    console.error("[pi-web] agent choice unreadable:", error);
    return {};
  }
}

function save(stored: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch (error) {
    console.error("[pi-web] agent choice not saved:", error);
    return false;
  }
  window.dispatchEvent(new Event(CHANGED));
  return true;
}

export function getDefaultAgent(): AgentChoice {
  const choice = read().defaultAgent;
  return isAgentChoice(choice) ? choice : DEFAULT_AGENT;
}

export function setDefaultAgent(choice: AgentChoice): boolean {
  return save({ ...read(), defaultAgent: choice });
}

export function getAgentOverride(sessionKey?: string): AgentChoice | undefined {
  const choice = sessionKey ? read().sessions?.[sessionKey] : undefined;
  return isAgentChoice(choice) ? choice : undefined;
}

export function getAgentChoice(sessionKey?: string): AgentChoice {
  return getAgentOverride(sessionKey) ?? getDefaultAgent();
}

export function setAgentChoice(sessionKey: string | undefined, choice: AgentChoice | undefined): void {
  if (!sessionKey) return;
  const stored = read();
  const sessions = { ...stored.sessions };
  delete sessions[sessionKey];
  if (choice) sessions[sessionKey] = choice;
  const keys = Object.keys(sessions);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete sessions[key];
  save({ ...stored, sessions });
}

// Once the draft has an ID, its explicit choice belongs to that conversation.
export function moveAgentChoice(draftKey: string | null, sessionId: string): void {
  if (!draftKey || draftKey === sessionId) return;
  const stored = read();
  const choice = stored.sessions?.[draftKey];
  if (!isAgentChoice(choice)) return;
  const sessions = { ...stored.sessions };
  delete sessions[draftKey];
  sessions[sessionId] = choice;
  save({ ...stored, sessions });
}

let installed: Promise<InstalledAgents> | undefined;
export function loadInstalledAgents(): Promise<InstalledAgents> {
  installed ??= fetch("/api/cline-agent", { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<InstalledAgents>;
    })
    .catch((error) => {
      console.error("[pi-web] agent availability check failed:", error);
      installed = undefined;
      return {};
    });
  return installed;
}

export function agentAvailable(agent: AgentChoice, available: InstalledAgents): boolean {
  return agent === "pi" || (agent === "cline" ? available.installed === true : available.opencode === true);
}

export async function agentForPrompt(sessionId: string): Promise<AgentChoice> {
  if (getAgentChoice(sessionId) === "pi") return "pi";
  const available = await loadInstalledAgents();
  const choice = getAgentChoice(sessionId);
  return agentAvailable(choice, available) ? choice : "pi";
}

export function subscribeAgentChoice(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}
