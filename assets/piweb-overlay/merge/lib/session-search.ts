import { open, stat } from "node:fs/promises";
import type { SessionInfo } from "./types";

const MAX_RESULTS = 30;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const TIME_BUDGET_MS = 8000;
const CONCURRENCY = 4;
const CACHE_BYTES = 96 * 1024 * 1024;
const CACHE_FILES = 2048;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
}
export interface SessionSearchResponse { results: SessionSearchResult[]; truncated: boolean }

type TextEntry = { entryId?: string; text: string; blocks: { blockIndex: number; end: number }[] };
type QueryPlan = { phrase: RegExp; terms: RegExp[] };
type RankedHit = { result: Omit<SessionSearchResult, "session">; score: number };
type TextIndex = { entries: TextEntry[]; incomplete: boolean; bytes: number };
type Cached = { fingerprint: string; index: TextIndex };
const cache = new Map<string, Cached>();
const pending = new Map<string, Promise<TextIndex>>();
let cacheBytes = 0;
let readers = 0;
const waiting: (() => void)[] = [];
// Counts only; no transcript contents, paths or queries are persisted.
export const sessionSearchStats = { fileReads: 0, bytesRead: 0, cacheHits: 0 };

// Retained for callers of the original byte-prefilter helper.
export function searchPrefilterKey(query: string): string {
  const runs: string[] = [];
  let run = "";
  for (const char of query) {
    const caseless = char.charCodeAt(0) < 0x80 || (char.toLowerCase() === char && char.toUpperCase() === char);
    if (caseless && char !== "\n") run += char;
    else { if (run) runs.push(run); run = ""; }
  }
  if (run) runs.push(run);
  return runs.map(value => JSON.stringify(value).slice(1, -1))
    .reduce((best, value) => Buffer.byteLength(value) > Buffer.byteLength(best) ? value : best, "");
}

const fingerprint = (value: Awaited<ReturnType<typeof stat>>) => `${value.size}:${value.mtimeMs}:${value.ctimeMs}:${value.ino}`;
const LINE_TYPE_RE = /^\{"type":"([a-z_]+)"/;
const TOOL_RESULT_RE = /^\{"type":"message","id":"[^"\\]*","parentId":(?:"[^"\\]*"|null),"timestamp":"[^"\\]*","message":\{"role":"toolResult"/;

function extract(bytes: Buffer): TextEntry | null {
  const head = bytes.toString("latin1", 0, Math.min(bytes.length, 256));
  const type = LINE_TYPE_RE.exec(head)?.[1];
  if ((type !== undefined && type !== "message") || TOOL_RESULT_RE.test(head)) return null;
  let entry;
  try { entry = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) return null;
  const content = entry.message.content;
  const source = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const texts: string[] = [], blocks: TextEntry["blocks"] = [];
  let offset = 0;
  for (const [blockIndex, block] of source.entries()) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    offset += block.text.length;
    texts.push(block.text);
    blocks.push({ blockIndex, end: offset });
    offset++;
  }
  if (!texts.length) return null;
  return { ...(typeof entry.id === "string" ? { entryId: entry.id } : {}), text: texts.join("\n"), blocks };
}

// One shared reader pool across prewarming, overlapping queries and aborted
// requests. Typing never starts four fresh disk scans per keystroke.
async function readIndex(path: string): Promise<TextIndex> {
  if (readers >= CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
  else readers++;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const index: TextIndex = { entries: [], incomplete: false, bytes: 0 };
  try {
    handle = await open(path, "r");
    sessionSearchStats.fileReads++;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let parts: Buffer[] = [], length = 0, skipping = false;
    const add = (line: Buffer) => {
      const entry = extract(line);
      if (entry) {
        index.entries.push(entry);
        index.bytes += entry.text.length * 2 + entry.blocks.length * 24 + 128;
      }
    };
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      sessionSearchStats.bytesRead += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(start, end);
        if (!skipping) {
          length += piece.length;
          if (length > MAX_LINE_BYTES) { parts = []; length = 0; skipping = true; index.incomplete = true; }
          else if (newline < 0) parts.push(Buffer.from(piece));
          else if (parts.length) add(Buffer.concat([...parts, piece], length));
          else add(piece);
        }
        if (newline < 0) break;
        parts = []; length = 0; skipping = false; start = newline + 1;
      }
    }
    if (length) add(Buffer.concat(parts, length));
  } catch { index.incomplete = true; }
  finally {
    await handle?.close().catch(() => undefined);
    const next = waiting.shift();
    if (next) next(); else readers--;
  }
  return index;
}

async function indexFor(path: string): Promise<TextIndex> {
  let before;
  try { before = await stat(path); } catch { return { entries: [], incomplete: true, bytes: 0 }; }
  const key = fingerprint(before);
  const found = cache.get(path);
  if (found?.fingerprint === key) {
    sessionSearchStats.cacheHits++;
    cache.delete(path); cache.set(path, found);
    return found.index;
  }
  const pendingKey = `${path}\0${key}`;
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const task = (async () => {
    const index = await readIndex(path);
    let after;
    try { after = await stat(path); } catch { return { ...index, incomplete: true }; }
    // Never publish a stale index when the agent appended, moved or rewrote the
    // file during the read. The following query retries this file, not all files.
    if (fingerprint(after) !== key) return { ...index, incomplete: true };
    const old = cache.get(path);
    if (old) { cacheBytes -= old.index.bytes; cache.delete(path); }
    if (index.bytes <= CACHE_BYTES && !index.incomplete) {
      cache.set(path, { fingerprint: key, index }); cacheBytes += index.bytes;
      while (cacheBytes > CACHE_BYTES || cache.size > CACHE_FILES) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.index.bytes;
        cache.delete(oldest);
      }
    }
    return index;
  })();
  pending.set(pendingKey, task);
  try { return await task; } finally { pending.delete(pendingKey); }
}

const candidatesFor = (sessions: readonly SessionInfo[]) => sessions
  .filter(session => !session.transient && session.path)
  .sort((a, b) => b.modified.localeCompare(a.modified));

// Runs once after the sidebar mounts, outside the interactive search path.
// No disk sidecars or additional transcript copies; cache dies with the server.
let warming: Promise<void> | null = null;
export function warmSessionSearch(sessions: readonly SessionInfo[]): Promise<void> {
  if (warming) return warming;
  const candidates = candidatesFor(sessions);
  const paths = new Set(candidates.map(session => session.path));
  for (const [path, item] of cache) if (!paths.has(path)) { cacheBytes -= item.index.bytes; cache.delete(path); }
  let next = 0;
  const worker = async () => { while (next < candidates.length) await indexFor(candidates[next++].path); };
  warming = Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker)).then(() => undefined)
    .finally(() => { warming = null; });
  return warming;
}

function snippet(entry: TextEntry, hit: RegExpExecArray): Omit<SessionSearchResult, "session"> {
  const start = hit.index, end = start + hit[0].length;
  return {
    ...(entry.entryId ? { entryId: entry.entryId } : {}),
    blockIndex: entry.blocks.find(block => start <= block.end)!.blockIndex,
    before: (start > 80 ? "..." : "") + entry.text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
    match: hit[0].replace(/\s+/g, " "),
    after: entry.text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < entry.text.length ? "..." : ""),
  };
}

function metadataHit(session: SessionInfo, plan: QueryPlan): RankedHit | undefined {
  for (const [text, score] of [[session.name?.trim(), 200], [session.firstMessage, 100]] as const) {
    if (!text) continue;
    const phrase = plan.phrase.exec(text);
    const all = phrase || (plan.terms.length > 1 && plan.terms.every(term => term.test(text)));
    if (!all) continue;
    const hit = phrase || plan.terms.map(term => term.exec(text)).find(Boolean)!;
    return { result: snippet({ text, blocks: [{ blockIndex: 0, end: text.length }] }, hit), score: score + (phrase ? 20 : 0) + (hit[0].length === text.length ? 10 : 0) };
  }
}

function matchIndex(index: TextIndex, plan: QueryPlan, session: SessionInfo): RankedHit | undefined {
  const metadata = metadataHit(session, plan);
  // Still find a real entry for title/first-message hits when possible, so Enter
  // opens the matching historical message rather than only opening the session.
  for (const entry of index.entries) {
    const hit = plan.phrase.exec(entry.text);
    if (hit) return { result: snippet(entry, hit), score: metadata?.score ?? 40 };
  }
  if (metadata) return metadata;
  if (plan.terms.length < 2) return undefined;
  const seen = plan.terms.map(term => term.test(session.name ?? "") || term.test(session.firstMessage));
  let best: { entry: TextEntry; hit: RegExpExecArray; count: number } | undefined;
  for (const entry of index.entries) {
    let count = 0;
    let first: RegExpExecArray | undefined;
    for (const [i, term] of plan.terms.entries()) {
      const hit = term.exec(entry.text);
      if (hit) { seen[i] = true; count++; first ??= hit; }
    }
    if (first && (!best || count > best.count)) best = { entry, hit: first, count };
  }
  // All words must be present in this session, not just any one of them.
  if (seen.every(Boolean) && best) return { result: snippet(best.entry, best.hit), score: 20 + best.count / plan.terms.length };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function searchSessionContents(sessions: readonly SessionInfo[], query: string, requestSignal?: AbortSignal): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  const literal = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const plan: QueryPlan = { phrase: literal(needle), terms: [...new Set(needle.split(/\s+/).filter(Boolean))].map(literal) };
  const deadline = Date.now() + TIME_BUDGET_MS;
  const signal = AbortSignal.any([AbortSignal.timeout(TIME_BUDGET_MS), ...(requestSignal ? [requestSignal] : [])]);
  const candidates = candidatesFor(sessions);
  type Outcome = { hit?: RankedHit; incomplete: boolean };
  const outcomes: (Outcome | undefined)[] = new Array(candidates.length);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length && !signal.aborted && Date.now() < deadline) {
      const position = next++;
      const index = await untilAborted(indexFor(candidates[position].path), signal);
      if (!index) break;
      outcomes[position] = { hit: matchIndex(index, plan, candidates[position]), incomplete: index.incomplete };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
  const ranked: { session: SessionInfo; hit: RankedHit; position: number }[] = [];
  for (const [position, session] of candidates.entries()) {
    const outcome = outcomes[position];
    if (!outcome || outcome.incomplete) response.truncated = true;
    if (outcome?.hit) ranked.push({ session, hit: outcome.hit, position });
  }
  ranked.sort((a, b) => b.hit.score - a.hit.score || a.position - b.position);
  response.results = ranked.slice(0, MAX_RESULTS).map(({ session, hit }) => ({ session, ...hit.result }));
  if (ranked.length > MAX_RESULTS) response.truncated = true;
  return response;
}
