import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

// Cache for the allowed-roots set, stored on globalThis so it survives Next.js
// hot-reload. An access check must not wait on a session-catalogue rebuild:
// agent_end, model switches and renames invalidate the catalogue constantly,
// and a rebuild rescans changed transcripts (seconds when the index is cold).
// So roots are derived from the last complete catalogue (allowStale) and are
// recomputed — cheaply, without a rescan — as soon as a newer catalogue lands.
// New cwds are not delayed by this: creating a session, adding a project and
// moving sessions all register their directory through allowFileRoot().
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number; source?: unknown } | undefined;
}

// Back to the upstream 5 s: with allowStale a longer TTL kept a removed project's cwd allowed for up to ~60 s (QA2 R2).
const ALLOWED_ROOTS_TTL_MS = 5_000;

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  const latestCatalogue = globalThis.__piSessionListCache?.data;
  if (cached && cached.expiresAt > now && (!latestCatalogue || latestCatalogue === cached.source)) {
    return cached.roots;
  }

  const sessions = await listAllSessions({ allowStale: true });
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/pi-cwd-* directories created by the default-cwd endpoint.
  try {
    for (const name of readdirSync(homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS, source: sessions };
  return roots;
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
