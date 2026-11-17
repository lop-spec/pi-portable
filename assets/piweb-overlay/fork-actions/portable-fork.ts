// Message-level fork, as in the Claude desktop app: a new session from this point, the one you are in
// stays as it is (running or not). The rules live in portable-fork-core.mjs; this file is the browser
// side: the request, the composer prefill, and two small stores the transcript reads without prop drilling
// (which session can fork right now, and the fork markers of a session).
import { useEffect, useSyncExternalStore } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { restoreDraftSubmission, type ChatDraftImage } from "@/lib/draft-store";
import { forkTitle } from "@/lib/portable-fork-core.mjs";

export { forkTitle };

/** What the new session's composer starts with when a fork leaves a user message behind. */
export interface PortableForkPrefill {
  text: string;
  images?: ChatDraftImage[];
}

/** Prefill from a user message: its text and the base64 images it carries (either on-disk shape). */
export function forkPrefillFrom(text: string, images: readonly unknown[]): PortableForkPrefill {
  const kept: ChatDraftImage[] = [];
  for (const image of images) {
    const block = image as { data?: string; mimeType?: string; source?: { type?: string; data?: string; media_type?: string } } | null;
    if (block?.source?.type === "base64" && block.source.data && block.source.media_type) kept.push({ data: block.source.data, mimeType: block.source.media_type });
    else if (block?.data && block.mimeType) kept.push({ data: block.data, mimeType: block.mimeType });
  }
  return kept.length > 0 ? { text, images: kept } : { text };
}

export interface ForkRequest {
  entryId: string;
  /** Leave the entry itself behind (a user message); the default keeps it, as a finished turn does. */
  before?: boolean;
  title?: string;
  prefill?: PortableForkPrefill;
}

/** Forks the session at an entry. Resolves with the new session id, or null while the session is not saved yet. */
export async function forkSessionAt(sessionId: string, request: ForkRequest): Promise<string | null> {
  const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sessionId, {
    type: "fork_branch",
    entryId: request.entryId,
    ...(request.before ? { before: true } : {}),
    ...(request.title ? { name: request.title } : {}),
  });
  if (!result || result.cancelled || !result.newSessionId) return null;
  const prefill = request.prefill;
  if (prefill && (prefill.text || prefill.images?.length)) restoreDraftSubmission(result.newSessionId, prefill.text, prefill.images);
  invalidateForkInfo(sessionId);
  return result.newSessionId;
}

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// ---- Which session can fork after a finished turn (registered by its chat hook) ----
type ForkAfter = (entryId: string) => Promise<boolean>;
const forkActions = new Map<string, ForkAfter>();

export function registerForkAfter(sessionId: string, action: ForkAfter): () => void {
  forkActions.set(sessionId, action);
  notify();
  return () => {
    if (forkActions.get(sessionId) !== action) return;
    forkActions.delete(sessionId);
    notify();
  };
}

export function useForkAfter(sessionId: string | undefined): ForkAfter | undefined {
  return useSyncExternalStore(subscribe, () => (sessionId ? forkActions.get(sessionId) : undefined), () => undefined);
}

// ---- Fork markers: "forked from" at the top of a fork, "forked here" under the turn a fork left ----
export interface ForkChild {
  id: string;
  title: string;
  created: string;
  anchorEntryId: string | null;
}

export interface ForkInfo {
  loaded: boolean;
  origin: { id: string; title: string } | null;
  forks: ForkChild[];
}

const NOT_LOADED: ForkInfo = { loaded: false, origin: null, forks: [] };
const FORK_INFO_TTL_MS = 60_000;
const forkInfo = new Map<string, { info: ForkInfo; at: number }>();
const forkInfoPending = new Set<string>();

function loadForkInfo(sessionId: string): void {
  const cached = forkInfo.get(sessionId);
  if ((cached && Date.now() - cached.at < FORK_INFO_TTL_MS) || forkInfoPending.has(sessionId)) return;
  forkInfoPending.add(sessionId);
  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/forks`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Partial<ForkInfo>;
      forkInfo.set(sessionId, { at: Date.now(), info: { loaded: true, origin: data.origin ?? null, forks: Array.isArray(data.forks) ? data.forks : [] } });
    })
    .catch((error) => {
      console.error("[pi-web] fork markers unavailable:", error);
      forkInfo.set(sessionId, { at: Date.now(), info: { loaded: true, origin: null, forks: [] } });
    })
    .finally(() => {
      forkInfoPending.delete(sessionId);
      notify();
    });
}

/** A fork just created from this session shows up in it at once: refetch, keeping what is shown meanwhile. */
export function invalidateForkInfo(sessionId: string): void {
  const cached = forkInfo.get(sessionId);
  if (cached) forkInfo.set(sessionId, { ...cached, at: 0 });
  loadForkInfo(sessionId);
}

export function useForkInfo(sessionId: string | undefined): ForkInfo {
  const info = useSyncExternalStore(subscribe, () => (sessionId ? forkInfo.get(sessionId)?.info : undefined) ?? NOT_LOADED, () => NOT_LOADED);
  useEffect(() => {
    if (!sessionId) return;
    // Opening a session must not wait for its markers.
    const timer = setTimeout(() => loadForkInfo(sessionId), 300);
    return () => clearTimeout(timer);
  }, [sessionId]);
  return info;
}
