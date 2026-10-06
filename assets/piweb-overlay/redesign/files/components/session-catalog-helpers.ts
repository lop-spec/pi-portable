import type { SessionInfo } from "@/lib/types";

/**
 * Overlay a catalogue row onto the session already on screen.
 *
 * Catalogue rows omit optional keys instead of setting them to undefined, so a
 * plain spread can never clear one that stopped being true: a hydrated row drops
 * `detailsPending`, a session that left a worktree drops `branch`/`isWorktree`,
 * and a fork whose parent went away drops `relation`. Reset those from the
 * refreshed row explicitly. Locally applied fields such as an auto-generated
 * title still survive until the next listing carries them.
 */
export function mergeCatalogRow(current: SessionInfo, refreshed: SessionInfo): SessionInfo {
  const merged: SessionInfo = {
    ...current,
    ...refreshed,
    detailsPending: refreshed.detailsPending,
    relation: refreshed.relation,
    branch: refreshed.branch,
    isWorktree: refreshed.isWorktree,
  };
  // Structural sharing (P10): a background listing that changed nothing about the
  // selected session must not hand AppShell a new object, or every refresh
  // re-renders the whole shell and ChatWindow for nothing.
  return sameRowValues(current, merged) ? current : merged;
}

/** Same values for every key either row carries; an absent key equals an explicit undefined. */
function sameRowValues(a: SessionInfo, b: SessionInfo): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const x = left[key];
    const y = right[key];
    if (Object.is(x, y)) continue;
    // relation is the only nested field: a flat object of primitives.
    if (!x || !y || typeof x !== "object" || typeof y !== "object") return false;
    const xs = x as Record<string, unknown>;
    const ys = y as Record<string, unknown>;
    const nestedKeys = new Set([...Object.keys(xs), ...Object.keys(ys)]);
    for (const nested of nestedKeys) if (!Object.is(xs[nested], ys[nested])) return false;
  }
  return true;
}
