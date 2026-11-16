// Which agent runs a session's next prompt. A session keeps the agent it last used; a
// session that has not chosen yet (a new draft included) follows the last choice made
// anywhere. Kept in the browser, like the other composer preferences.
export type AgentChoice = "pi" | "cline";

type Stored = { last?: AgentChoice; sessions?: Record<string, AgentChoice> };

const KEY = "pi-web:agent";
const CHANGED = "pi-web:agent-choice";
const MAX_SESSIONS = 300;

function read(): Stored {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored;
  } catch (error) {
    console.error("[pi-web] agent choice unreadable:", error);
    return {};
  }
}

export function getAgentChoice(sessionKey?: string): AgentChoice {
  const stored = read();
  const choice = (sessionKey ? stored.sessions?.[sessionKey] : undefined) ?? stored.last;
  return choice === "cline" ? "cline" : "pi";
}

export function setAgentChoice(sessionKey: string | undefined, choice: AgentChoice): void {
  const stored = read();
  const sessions = { ...stored.sessions };
  if (sessionKey) {
    delete sessions[sessionKey];
    sessions[sessionKey] = choice;
  }
  const keys = Object.keys(sessions);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete sessions[key];
  try {
    localStorage.setItem(KEY, JSON.stringify({ last: choice, sessions }));
  } catch (error) {
    console.error("[pi-web] agent choice not saved:", error);
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The agent for a prompt about to be sent; the session remembers it from here on. */
export function agentForPrompt(sessionId: string): AgentChoice {
  const choice = getAgentChoice(sessionId);
  if (read().sessions?.[sessionId] !== choice) setAgentChoice(sessionId, choice);
  return choice;
}

export function subscribeAgentChoice(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}
