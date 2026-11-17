// Pure rules of the fork actions (message-level fork, as in the Claude desktop app). No DOM, no
// network: the client wrapper (lib/portable-fork.ts), the forks route and the tests share them.

/** A fork inherits the parent's title; the part kept before "(fork)" stays readable in a narrow sidebar. */
export const FORK_BASE_MAX = 40;

/**
 * First line of a title, whitespace collapsed, clipped to FORK_BASE_MAX characters.
 * @param {unknown} title
 * @returns {string}
 */
export function forkBase(title) {
  const line = String(title ?? '').split(/\r?\n/).find(part => part.trim()) ?? '';
  const chars = Array.from(line.replace(/\s+/g, ' ').trim());
  return chars.length > FORK_BASE_MAX ? `${chars.slice(0, FORK_BASE_MAX - 1).join('').trimEnd()}…` : chars.join('');
}

/**
 * Title of the session a fork creates: "X" -> "X (fork)" -> "X (fork 2)" -> "X (fork 3)", the Claude desktop
 * naming. An untitled parent gives "" (the fork keeps showing its first message).
 * @param {unknown} title
 * @returns {string}
 */
export function forkTitle(title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  const numbered = clean.match(/^(.*) \(fork(?: (\d+))?\)$/);
  if (numbered) return `${numbered[1]} (fork ${numbered[2] ? Number(numbered[2]) + 1 : 2})`;
  const base = forkBase(clean);
  return base ? `${base} (fork)` : '';
}

/**
 * Where a fork child leaves its parent: the last entry of the child's leading run that the parent also has,
 * walked up to the nearest message entry (what the transcript shows). null means the very top, i.e. the
 * child was forked before the first message. Fork-time copies keep entry ids, and entries the fork adds
 * (labels re-created at the end of the copy, its own turns) have new ids, so the first foreign id ends the run.
 * @param {ReadonlyArray<{ id: string; parentId?: string | null; type?: string }>} parentEntries
 * @param {ReadonlyArray<{ id: string }>} childEntries child entries in file order
 * @returns {string | null}
 */
export function forkAnchor(parentEntries, childEntries) {
  const byId = new Map(parentEntries.map(entry => [entry.id, entry]));
  /** @type {string | null} */
  let last = null;
  for (const entry of childEntries) {
    if (!byId.has(entry.id)) break;
    last = entry.id;
  }
  while (last !== null) {
    const entry = byId.get(last);
    if (!entry) return null;
    if (entry.type === 'message') return entry.id;
    last = entry.parentId ?? null;
  }
  return null;
}

/**
 * Display title of a session in the fork markers: its name, else its first message.
 * @param {{ name?: string; firstMessage?: string }} session
 * @returns {string}
 */
export function forkMarkerTitle(session) {
  const raw = (session.name?.trim() || session.firstMessage || '').split(/\r?\n/).find(part => part.trim()) ?? '';
  const clean = raw.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? `${clean.slice(0, 119).trimEnd()}…` : clean;
}

/**
 * Pins are kept per session as a list of entry ids; a toggle adds or removes one and keeps the list bounded.
 * @param {readonly string[]} ids
 * @param {string} entryId
 * @param {number} [limit]
 * @returns {string[]}
 */
export function togglePinned(ids, entryId, limit = 200) {
  if (ids.includes(entryId)) return ids.filter(id => id !== entryId);
  return [...ids, entryId].slice(-limit);
}
