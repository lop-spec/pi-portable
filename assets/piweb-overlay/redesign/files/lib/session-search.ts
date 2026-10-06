import { open } from "node:fs/promises";
import type { SessionInfo } from "./types";

const MAX_RESULTS = 30;
// Lines longer than this are not parsed (reported as incomplete when the query
// may occur in them). Inline images make user lines a few MB at most.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
// Safety net only: every catalogued file is searched, and a raw-byte prefilter
// keeps a full pass over ~800MB of transcripts to about a second or two.
const TIME_BUDGET_MS = 8000;
const SEARCH_CONCURRENCY = 4;
const READ_CHUNK_BYTES = 1024 * 1024;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

/**
 * A query fragment that must appear verbatim (up to ASCII case) in the raw
 * JSONL bytes of any line whose text matches the query.
 *
 * Text is stored through JSON.stringify, so quotes, backslashes and control
 * characters appear escaped while other characters stay raw UTF-8. The matcher
 * is a case-insensitive regex without the `u` flag: ASCII letters fold only to
 * ASCII, and non-ASCII characters with a case partner (Ä/ä) could match bytes
 * that differ from the query's, so they split the query into runs. Text blocks
 * are joined with "\n" before matching, so "\n" splits runs too. The longest
 * remaining run, JSON-escaped, is the key ("" when no run is left).
 */
export function searchPrefilterKey(query: string): string {
  const runs: string[] = [];
  let run = "";
  for (const char of query) {
    const caseless = char.charCodeAt(0) < 0x80
      || (char.toLowerCase() === char && char.toUpperCase() === char);
    if (caseless && char !== "\n") {
      run += char;
    } else {
      if (run) runs.push(run);
      run = "";
    }
  }
  if (run) runs.push(run);
  let best = "";
  for (const candidate of runs) {
    const escaped = JSON.stringify(candidate).slice(1, -1);
    if (Buffer.byteLength(escaped) > Buffer.byteLength(best)) best = escaped;
  }
  return best;
}

const MIN_ANCHOR_BYTES = 3;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds candidate lines for a key. Native Buffer.indexOf is about five times
 * faster than case-insensitive string search, so it is used whenever the key
 * (or a letter-free part of it, verified per line) has no ASCII letters.
 */
interface Prefilter {
  /** Next candidate byte position in [from, end), or -1. */
  find(bytes: Buffer, from: number, end: number): number;
  /** Whether the whole key occurs in the line (anchor mode only). */
  verify?(bytes: Buffer, lineStart: number, lineEnd: number): boolean;
}

function buildPrefilter(key: string): Prefilter | null {
  if (!key) return null;
  const keyBytes = Buffer.from(key, "utf8");
  const exactFind = (needle: Buffer) => (bytes: Buffer, from: number, end: number) => {
    const position = bytes.indexOf(needle, from);
    return position !== -1 && position < end ? position : -1;
  };
  if (!/[A-Za-z]/.test(key)) return { find: exactFind(keyBytes) };
  // Haystack bytes are viewed as latin1 so one char is one byte; the `i` flag
  // then folds ASCII letters (and some latin1 pairs, which only adds harmless
  // false positives — every line is confirmed by the real matcher).
  const keyRegex = new RegExp(escapeRegExp(keyBytes.toString("latin1")), "i");
  const anchor = key.split(/[A-Za-z]+/)
    .map((part) => Buffer.from(part, "utf8"))
    .reduce((longest, part) => (part.length > longest.length ? part : longest), Buffer.alloc(0));
  if (anchor.length >= MIN_ANCHOR_BYTES) {
    return {
      find: exactFind(anchor),
      verify: (bytes, lineStart, lineEnd) => keyRegex.test(bytes.toString("latin1", lineStart, lineEnd)),
    };
  }
  const scanRegex = new RegExp(keyRegex.source, "gi");
  let haystack: { bytes: Buffer; start: number; end: number; text: string } | null = null;
  return {
    find(bytes, from, end) {
      if (!haystack || haystack.bytes !== bytes || haystack.end !== end || from < haystack.start) {
        haystack = { bytes, start: from, end, text: bytes.toString("latin1", from, end) };
      }
      scanRegex.lastIndex = from - haystack.start;
      const match = scanRegex.exec(haystack.text);
      return match ? haystack.start + match.index : -1;
    },
  };
}

// Only user/assistant message lines are searchable. JSON.stringify writes the
// entry type first and the SDK writes message entries in a fixed key order, so
// other entry types and tool results (most of the bytes, and most prefilter
// hits for paths or code) are recognised from their first bytes, unparsed.
const LINE_TYPE_RE = /^\{"type":"([a-z_]+)"/;
const TOOL_RESULT_LINE_RE = /^\{"type":"message","id":"[^"\\]*","parentId":(?:"[^"\\]*"|null),"timestamp":"[^"\\]*","message":\{"role":"toolResult"/;

function isUnsearchableLine(bytes: Buffer, lineStart: number, lineEnd: number): boolean {
  const head = bytes.toString("latin1", lineStart, Math.min(lineEnd, lineStart + 256));
  const type = LINE_TYPE_RE.exec(head)?.[1];
  if (type === undefined) return false;
  return type !== "message" || TOOL_RESULT_LINE_RE.test(head);
}

type FileOutcome = { result?: Omit<SessionSearchResult, "session">; incomplete: boolean };

function matchLine(line: string, matcher: RegExp): Omit<SessionSearchResult, "session"> | null {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) return null;
  const content: unknown = entry.message.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
  const text = textBlocks.map((block) => block.text).join("\n");
  const match = matcher.exec(text);
  if (!match) return null;
  const start = match.index;
  const end = start + match[0].length;
  let blockOffset = 0;
  const matchedBlock = textBlocks.find((block) => {
    const blockEnd = blockOffset + block.text.length;
    blockOffset = blockEnd + 1;
    return start <= blockEnd;
  });
  return {
    ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
    blockIndex: matchedBlock!.blockIndex,
    before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
    match: match[0].replace(/\s+/g, " "),
    after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
  };
}

/**
 * First matching user/assistant line of one file, in file order. Only lines
 * whose raw bytes contain the prefilter key are decoded and parsed.
 */
async function searchFile(
  path: string,
  matcher: RegExp,
  prefilter: Prefilter | null,
  signal: AbortSignal,
  deadline: number,
  buffer: Buffer,
): Promise<FileOutcome> {
  let incomplete = false;
  const scanRegion = (bytes: Buffer, start: number, end: number): Omit<SessionSearchResult, "session"> | null => {
    if (end <= start) return null;
    const lineAt = (from: number, to: number) => {
      const trimmed = to > from && bytes[to - 1] === 0x0d ? to - 1 : to;
      return matchLine(bytes.toString("utf8", from, trimmed), matcher);
    };
    if (!prefilter) {
      // No case-safe fragment (e.g. a query of only "Ä"): parse every line.
      for (let lineStart = start; lineStart < end;) {
        let lineEnd = bytes.indexOf(0x0a, lineStart);
        if (lineEnd === -1 || lineEnd > end) lineEnd = end;
        const hit = isUnsearchableLine(bytes, lineStart, lineEnd) ? null : lineAt(lineStart, lineEnd);
        if (hit) return hit;
        lineStart = lineEnd + 1;
      }
      return null;
    }
    let position = prefilter.find(bytes, start, end);
    while (position !== -1) {
      const lineStart = Math.max(start, bytes.lastIndexOf(0x0a, position) + 1);
      let lineEnd = bytes.indexOf(0x0a, position);
      if (lineEnd === -1 || lineEnd > end) lineEnd = end;
      if (!isUnsearchableLine(bytes, lineStart, lineEnd) && (!prefilter.verify || prefilter.verify(bytes, lineStart, lineEnd))) {
        const hit = lineAt(lineStart, lineEnd);
        if (hit) return hit;
      }
      if (lineEnd + 1 >= end) break;
      position = prefilter.find(bytes, lineEnd + 1, end);
    }
    return null;
  };

  // One reused read buffer per worker: far less allocation than a stream, so
  // a full pass is bound by the disk cache rather than by the GC.
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let skippingLongLine = false;
  try {
    handle = await open(path, "r");
    for (;;) {
      if (signal.aborted || Date.now() >= deadline) return { incomplete: true };
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let regionStart = 0;
      const firstNewline = chunk.indexOf(0x0a);
      if (firstNewline === -1) {
        if (!skippingLongLine) {
          pending.push(Buffer.from(chunk));
          pendingLength += chunk.length;
          if (pendingLength > MAX_LINE_BYTES) {
            pending = [];
            pendingLength = 0;
            skippingLongLine = true;
            incomplete = true;
          }
        }
        continue;
      }
      if (skippingLongLine) {
        skippingLongLine = false;
        regionStart = firstNewline + 1;
      } else if (pendingLength > 0) {
        const line = Buffer.concat([...pending, chunk.subarray(0, firstNewline)]);
        const hit = scanRegion(line, 0, line.length);
        if (hit) return { result: hit, incomplete };
        regionStart = firstNewline + 1;
      }
      pending = [];
      pendingLength = 0;
      const lastNewline = chunk.lastIndexOf(0x0a);
      const hit = scanRegion(chunk, regionStart, lastNewline);
      if (hit) return { result: hit, incomplete };
      if (lastNewline + 1 < chunk.length) {
        pending = [Buffer.from(chunk.subarray(lastNewline + 1))];
        pendingLength = chunk.length - lastNewline - 1;
      }
    }
    if (pendingLength > 0) {
      const line = Buffer.concat(pending);
      const hit = scanRegion(line, 0, line.length);
      if (hit) return { result: hit, incomplete };
    }
  } catch {
    // Missing/unreadable files and interrupted reads must not hide other results.
    return { incomplete: true };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return { incomplete };
}

export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // Escape every operator: this is literal search, with offsets in the original text.
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const prefilter = buildPrefilter(searchPrefilterKey(needle));
  const deadline = Date.now() + TIME_BUDGET_MS;
  const stop = new AbortController();
  const signal = AbortSignal.any([
    stop.signal,
    AbortSignal.timeout(TIME_BUDGET_MS),
    ...(requestSignal ? [requestSignal] : []),
  ]);
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified));

  // Files are searched concurrently but reported in catalogue order: the
  // result list is the first MAX_RESULTS matching sessions, newest first.
  const outcomes: (FileOutcome | undefined)[] = new Array(candidates.length);
  let next = 0;
  let settledPrefix = 0;
  let matchesInPrefix = 0;
  const advancePrefix = () => {
    while (settledPrefix < candidates.length && outcomes[settledPrefix]) {
      if (outcomes[settledPrefix]!.result) matchesInPrefix++;
      settledPrefix++;
      if (matchesInPrefix >= MAX_RESULTS) {
        stop.abort();
        return;
      }
    }
  };
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (next < candidates.length && !signal.aborted && Date.now() < deadline) {
      const index = next++;
      outcomes[index] = await searchFile(candidates[index].path, matcher, prefilter, signal, deadline, buffer);
      advancePrefix();
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, candidates.length) }, worker));

  for (const [index, session] of candidates.entries()) {
    if (response.results.length >= MAX_RESULTS) {
      // More catalogued files remained unread after the result cap.
      response.truncated = true;
      break;
    }
    const outcome = outcomes[index];
    if (!outcome) {
      response.truncated = true;
      break;
    }
    if (outcome.result) response.results.push({ session, ...outcome.result });
    if (outcome.incomplete) response.truncated = true;
  }
  return response;
}
