// The same physical key must not both dismiss a control and stop an agent.
export function shouldStopOnGlobalEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target as HTMLElement | null;
  if (target && (["TEXTAREA", "INPUT", "SELECT"].includes(target.tagName) || target.isContentEditable
      || target.closest?.('[contenteditable="true"], [role="menu"], [role="dialog"], dialog'))) return false;
  return true;
}

// Stop and the next prompt may arrive in either order. They share one promise,
// so a late or repeated ticket cannot abort a newer run or re-execute a stop.
export function createStopGate(limit = 32) {
  const entries = new Map<string, { promise: Promise<unknown>; settled: boolean }>();
  function prune() {
    for (const [key, entry] of entries) {
      if (entries.size <= limit) break;
      if (entry.settled) entries.delete(key);
    }
  }
  return {
    async run<T>(token: unknown, action: () => Promise<T>): Promise<T> {
      if (typeof token !== "string" || !token) return action();
      const existing = entries.get(token);
      if (existing) return existing.promise as Promise<T>;
      const entry = { promise: Promise.resolve().then(action) as Promise<unknown>, settled: false };
      entries.set(token, entry);
      prune();
      try { return await entry.promise as T; }
      finally { entry.settled = true; prune(); }
    },
  };
}
