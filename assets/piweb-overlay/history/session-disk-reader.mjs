// UI-only reader. Never constructs a SessionManager, repairs JSONL or loads an agent.
// Cold first paint reads a reverse page; a cooperative metadata scan runs separately.
// The in-process index retains offsets and small display metadata, never tool bodies.
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
const CHUNK = 128 * 1024;
const MAX_SESSIONS = 12;
const MAX_ROWS = 200_000;
const key = Symbol.for('pi-web.disk-read-index.v1');
const indexes = globalThis[key] ??= new Map();
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
const fingerprint = s => `${identity(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const hash = b => createHash('sha256').update(b).digest('hex');
const pathKey = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
async function range(fd, start, length, state) {
  const b = Buffer.allocUnsafe(length); let n = 0;
  while (n < length) { const r = await fd.read(b, n, length - n, start + n); if (!r.bytesRead) break; n += r.bytesRead; }
  if (state) state.ioBytes += n;
  return b.subarray(0, n);
}
function parse(bytes) { try { const e = JSON.parse(bytes.toString('utf8')); return e && typeof e === 'object' ? e : null; } catch { return null; } }
async function header(fd, state) {
  let b = Buffer.alloc(0);
  for (let at = 0; at < 1024 * 1024; at += 4096) {
    const c = await range(fd, at, 4096, state); b = Buffer.concat([b, c]);
    const end = b.indexOf(10);
    if (end >= 0) { const raw = b.subarray(0, end + 1); return { value: parse(raw), bytes: raw.length, hash: hash(raw) }; }
    if (c.length < 4096) return { value: parse(b), bytes: b.length, hash: hash(b) };
  }
  throw new Error('Session header exceeds read limit');
}
function thin(e) {
  if (e.type !== 'message') {
    const out = { ...e };
    // UI does not apply model-context edits. Full summaries are read for their page.
    for (const k of ['details', 'replacement', 'content', 'summary']) delete out[k];
    return out;
  }
  const m = e.message ?? {};
  const content = typeof m.content === 'string' ? m.content.slice(0, 4000)
    : Array.isArray(m.content) ? m.content.flatMap(b => {
      if (!b || typeof b !== 'object') return [];
      if (b.type === 'text') return [{ type: 'text', text: String(b.text ?? '').slice(0, 4000) }];
      if (b.type === 'toolCall') return [{ type: 'toolCall', toolCallId: b.toolCallId ?? b.id, toolName: b.toolName ?? b.name, input: {} }];
      return [];
    }) : [];
  return { type: e.type, id: e.id, parentId: e.parentId, timestamp: e.timestamp, message: {
    role: m.role === 'hookMessage' ? 'custom' : m.role,
    content: m.role === 'toolResult' || m.role === 'system' ? [] : content,
    timestamp: m.timestamp, model: m.model, provider: m.provider, usage: m.usage,
    stopReason: m.stopReason, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError,
  } };
}
function normalize(e, state, offset, previousId) {
  if (!e || e.type === 'session') return null;
  if ((state.header.value.version ?? 1) < 2) {
    e.id = hash(Buffer.from(`${state.header.value.id}:${offset}`)).slice(0, 16);
    e.parentId = previousId ?? null;
  }
  if (typeof e.id !== 'string' || typeof e.type !== 'string') return null;
  if (e.type === 'compaction' && typeof e.firstKeptEntryIndex === 'number') {
    e.firstKeptEntryId = state.rows[e.firstKeptEntryIndex - 1]?.entry.id;
    delete e.firstKeptEntryIndex;
  }
  if (e.type === 'message' && e.message?.role === 'hookMessage') e.message.role = 'custom';
  return e;
}
function row(e, start, length) { return { start, length, entry: thin(e) }; }
function located(e, r, state) {
  if ((state?.header.value.version ?? 3) >= 2) Object.defineProperty(e, Symbol.for('pi-web.entry-location'), { value: { start: r.start, length: r.length } });
  return e;
}
async function stateFor(file) {
  const p = pathKey(file); const fd = await open(file, 'r');
  try {
    const s = await fd.stat(); let state = indexes.get(p);
    const h = await header(fd, state);
    state = indexes.get(p); // another request may have installed it while the header read yielded
    if (h.value?.type !== 'session' || typeof h.value.id !== 'string') throw new Error('Invalid session header');
    if (!state || identity(s) !== state.identity || h.hash !== state.header.hash || s.size < state.size || (s.size === state.size && fingerprint(s) !== state.fp)) {
      state = { file: resolve(file), identity: identity(s), header: h, rows: [], byId: new Map(), known: new Map(), offset: h.bytes, size: s.size, fp: fingerprint(s), ready: false, ioBytes: 0, scans: 0, flight: null, anchor: null };
      indexes.set(p, state);
    }
    indexes.delete(p); indexes.set(p, state);
    // Active scans retain their state until done. Bound retained metadata by rows too.
    let total = [...indexes.values()].reduce((n, x) => n + x.rows.length, 0);
    for (const [old, x] of indexes) {
      if (indexes.size <= MAX_SESSIONS && total <= MAX_ROWS) break;
      if (x !== state && !x.flight) { indexes.delete(old); total -= x.rows.length; }
    }
    return { state, stat: s };
  } finally { await fd.close(); }
}
async function buildIndex(state) {
  const fd = await open(state.file, 'r');
  try {
    const stat = await fd.stat();
    const h = await header(fd, state);
    if (h.hash !== state.header.hash || identity(stat) !== state.identity) throw new Error('Session replaced during read');
    // Check append boundaries, not just size/mtime. A rewrite must never reuse offsets.
    let reset = false;
    if (state.anchor) {
      const b = await range(fd, state.anchor.start, state.anchor.length, state);
      reset = hash(b) !== state.anchor.hash || stat.size < state.offset;
    }
    const rows = reset ? [] : state.rows.slice();
    const byId = reset ? new Map() : new Map(state.byId);
    const scanning = { ...state, rows };
    state.scans++;
    let at = reset ? h.bytes : state.offset; let pending = Buffer.alloc(0); let lineAt = at;
    while (at < stat.size) {
      const b = await range(fd, at, Math.min(CHUNK, stat.size - at), state); if (!b.length) break;
      at += b.length; pending = pending.length ? Buffer.concat([pending, b]) : b;
      let start = 0; let end;
      while ((end = pending.indexOf(10, start)) >= 0) {
        const e = normalize(parse(pending.subarray(start, end)), scanning, lineAt, rows.at(-1)?.entry.id);
        if (e) { const r = row(e, lineAt, end - start); rows.push(r); byId.set(e.id, r); }
        lineAt += end - start + 1; start = end + 1;
      }
      pending = pending.subarray(start);
      await yieldTurn(); // parsing one file must not freeze the Next event loop
    }
    const final = normalize(parse(pending), scanning, lineAt, rows.at(-1)?.entry.id);
    const anchorStart = Math.max(h.bytes, lineAt - 256);
    const bytes = await range(fd, anchorStart, lineAt - anchorStart, state);
    const latest = await fd.stat();
    if (identity(latest) !== state.identity || latest.size < stat.size) throw new Error('Session changed during metadata scan');
    // Commit together: a failed/cancelled I/O must not append the same rows twice.
    state.rows = rows; state.byId = byId; state.offset = lineAt;
    state.provisional = final ? row(final, lineAt, pending.length) : null;
    if (reset) state.known.clear();
    state.anchor = { start: anchorStart, length: bytes.length, hash: hash(bytes) };
    state.size = stat.size; state.fp = fingerprint(stat); state.ready = true;
    return state;
  } finally { await fd.close(); }
}
async function metadata(state) {
  if (state.flight) return state.flight;
  state.flight = buildIndex(state).finally(() => { state.flight = null; });
  return state.flight;
}
async function readRow(fd, r, state) {
  const e = parse(await range(fd, r.start, r.length, state));
  const value = normalize(e, state, r.start, r.entry.parentId);
  if (!value || value.id !== r.entry.id) throw new Error('Session changed during entry read');
  return located(value, r, state);
}
// Reverse physical-line iterator: byte boundaries preserve split UTF-8 and CRLF.
async function* backwards(fd, end, minimum, state) {
  let at = end; let pending = Buffer.alloc(0);
  while (at > minimum) {
    const start = Math.max(minimum, at - CHUNK);
    const b = await range(fd, start, at - start, state); at = start;
    pending = pending.length ? Buffer.concat([b, pending]) : b;
    let right = pending.length; let newline;
    while ((newline = pending.lastIndexOf(10, right - 1)) >= 0) {
      if (newline + 1 < right) yield { bytes: pending.subarray(newline + 1, right), start: start + newline + 1 };
      right = newline;
      if (right === 0) break;
    }
    pending = pending.subarray(0, right);
    await yieldTurn();
  }
  if (pending.length) yield { bytes: pending, start: minimum };
}
const counts = e => e.type === 'compaction' || e.type === 'message' && ['user', 'assistant'].includes(e.message?.role);
class DiskView {
  constructor(state, rows, page, pending) {
    this.file = state.file; this.header = state.header.value; this.metadataPending = pending;
    this.revision = pending ? null : 'display-v1-' + hash(Buffer.from(state.fp)).slice(0, 22);
    const full = new Map(page.map(e => [e.id, e]));
    this.entries = rows.map(r => full.get(r.entry.id) ?? r.entry);
    this.byId = new Map(this.entries.map(e => [e.id, e]));
    this.leaf = rows.at(-1)?.entry.id ?? null;
  }
  getHeader() { return this.header; }
  getSessionFile() { return this.file; }
  getEntries() { return this.entries; }
  getLeafId() { return this.leaf; }
  getSessionName() { return this.entries.findLast(e => e.type === 'session_info')?.name?.trim() || undefined; }
  getBranch(id = this.leaf) {
    const out = []; const seen = new Set(); let e = this.byId.get(id);
    while (e && !seen.has(e.id)) { seen.add(e.id); out.push(e); e = this.byId.get(e.parentId); }
    return out.reverse();
  }
  getTree() {
    const nodes = new Map(this.entries.map(entry => [entry.id, { entry, children: [] }])); const roots = [];
    for (const e of this.entries) { const n = nodes.get(e.id); const p = nodes.get(e.parentId); if (p && p !== n) p.children.push(n); else roots.push(n); }
    for (const e of this.entries) if (e.type === 'label' && nodes.has(e.targetId)) nodes.get(e.targetId).label = e.label;
    for (const n of nodes.values()) n.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
    return roots;
  }
}
export async function openDiskSession(file, options = {}) {
  const { state, stat } = await stateFor(file);
  // Legacy linear logs require their prefix for stable parent/compaction IDs.
  if (options.metadata || options.nodes || (state.header.value.version ?? 1) < 2 || state.ready) {
    if (!state.ready || state.fp !== fingerprint(stat)) await metadata(state);
  }
  const fd = await open(file, 'r'); const page = []; const tail = options.tail ?? 50; const cap = Math.max(200, tail * 6);
  let visible = 0; let rows;
  try {
    if (state.ready && state.fp === fingerprint(await fd.stat())) {
      rows = state.provisional ? [...state.rows, state.provisional] : state.rows;
      const byId = new Map(rows.map(r => [r.entry.id, r]));
      let r = options.before ? byId.get(byId.get(options.before)?.entry.parentId) : byId.get(options.leafId ?? rows.at(-1)?.entry.id);
      const seen = new Set();
      while (r && !seen.has(r.entry.id)) {
        seen.add(r.entry.id); page.push(await readRow(fd, r, state));
        if (counts(r.entry)) visible++;
        if (visible >= tail || page.length >= cap) break;
        r = byId.get(r.entry.parentId);
      }
    } else {
      let needed = options.before ?? options.leafId; let skip = Boolean(options.before); const foundRows = [];
      const cached = needed ? state.known.get(needed) : null;
      const end = cached ? cached.start + cached.length : stat.size;
      for await (const line of backwards(fd, end, state.header.bytes, state)) {
        const e = normalize(parse(line.bytes), state, line.start, null); if (!e) continue;
        const r = row(e, line.start, line.bytes.length); state.known.set(e.id, r);
        while (state.known.size > 4096) state.known.delete(state.known.keys().next().value);
        if (needed && e.id !== needed) continue;
        needed = e.parentId;
        if (skip) { foundRows.push(r); skip = false; continue; }
        foundRows.push(r); page.push(located(e, r, state)); if (counts(e)) visible++;
        if (visible >= tail || page.length >= cap || !needed) break;
      }
      rows = foundRows.reverse();
    }
    page.reverse();
    const result = new DiskView(state, rows, page, !state.ready);
    // Full metadata is an explicit second request, never a side effect of reading a tail.
    return result;
  } finally { await fd.close(); }
}
export async function readDiskEntry(file, id, hints) {
  // Hints cross processes with the page. Validate physical-line boundaries and id;
  // never trust an offset as authorization or accept a nested JSON fragment.
  if (hints?.has('offset') && hints?.has('length')) {
    const start = Number(hints.get('offset')), length = Number(hints.get('length'));
    if (!Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(length) || length <= 0 || length > 64 * 1024 * 1024) return null;
    const fd = await open(file, 'r');
    try {
      const size = (await fd.stat()).size;
      if (start + length > size) return null;
      const prev = await range(fd, start - 1, 1);
      const next = start + length < size ? await range(fd, start + length, 1) : null;
      if (prev[0] !== 10 || next && next[0] !== 10) return null;
      const e = parse(await range(fd, start, length));
      return e?.type !== 'session' && e?.id === id ? located(e, { start, length }) : null;
    } finally { await fd.close(); }
  }
  const { state, stat } = await stateFor(file);
  let r = state.known.get(id) ?? (state.ready ? state.byId.get(id) : null);
  if (!state.ready && !r || state.ready && state.fp !== fingerprint(stat)) await metadata(state);
  if (state.ready) r = state.byId.get(id) ?? (state.provisional?.entry.id === id ? state.provisional : null);
  if (!r) return null;
  const fd = await open(file, 'r'); try { return await readRow(fd, r, state); } finally { await fd.close(); }
}
export function diskReadDiagnostics(file) {
  const s = indexes.get(pathKey(file));
  return s ? { ioBytes: s.ioBytes, scans: s.scans, rows: s.rows.length, ready: s.ready, offset: s.offset } : null;
}
export function clearDiskReadIndex() { indexes.clear(); }
export async function diskViewRevision(file) { return 'display-v1-' + hash(Buffer.from(fingerprint(await stat(file)))).slice(0, 22); }
