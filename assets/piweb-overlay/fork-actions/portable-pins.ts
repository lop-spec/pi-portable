// Pinned chapters: a turn can be pinned from its footer and shows up in the Q/A navigation. Kept in the
// browser per session (like the composer preferences); the pin belongs to the turn's final answer entry.
import { useSyncExternalStore } from "react";
import { togglePinned } from "@/lib/portable-fork-core.mjs";

const PREFIX = "pi-web:pins:";
const NONE: ReadonlySet<string> = new Set();
const cache = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function load(sessionId: string): ReadonlySet<string> {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  let ids: string[] = [];
  if (typeof window !== "undefined") {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + sessionId) ?? "[]");
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
    } catch (error) {
      console.error("[pi-web] pinned chapters unreadable:", error);
    }
  }
  const pins = new Set(ids);
  cache.set(sessionId, pins);
  return pins;
}

/** Pins or unpins an entry; resolves with the new state. */
export function togglePortablePin(sessionId: string, entryId: string): boolean {
  const next = togglePinned([...load(sessionId)], entryId);
  cache.set(sessionId, new Set(next));
  try {
    if (next.length > 0) localStorage.setItem(PREFIX + sessionId, JSON.stringify(next));
    else localStorage.removeItem(PREFIX + sessionId);
  } catch (error) {
    console.error("[pi-web] pinned chapters not saved:", error);
  }
  notify();
  return next.includes(entryId);
}

// Another tab changed the pins.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(PREFIX)) return;
    cache.delete(event.key.slice(PREFIX.length));
    notify();
  });
}

export function usePortablePins(sessionId: string | undefined): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => (sessionId ? load(sessionId) : NONE), () => NONE);
}

export function usePortablePin(sessionId: string | undefined, entryId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(sessionId && entryId && load(sessionId).has(entryId)), () => false);
}
