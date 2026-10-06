// Cache session-list metadata without building the SDK's unused allMessagesText.
// Normal listings rescan only new/changed files; summary listings reuse whatever
// the index already holds and fall back to header/stat metadata for the files
// that changed, which a later normal listing hydrates.
//
// Changed files resume from where the previous scan stopped: session files are
// append-only JSONL, so the index remembers the byte offset of the last complete
// line plus a hash of the header line and of the bytes just before that offset.
// The header is rewritten in place by project moves/renames (see
// relocateSessionHeaders in portable-project-store.mjs: same length padded with
// spaces, or longer through a temp file), and the SDK rewrites whole files on
// migration; any header or anchor mismatch, or a shrunken file, falls back to a
// full rescan, so a resumed scan never starts at a misaligned offset.
//
// ponytail: size/mtime fingerprints miss same-size edits with restored mtime;
// use content hashes if detecting those edits becomes necessary.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ScannedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
	/** True when only header/stat metadata was available for this listing. */
	detailsPending?: boolean;
}

interface Fingerprint {
	size: number;
	mtimeMs: number;
}

/** Where the previous scan stopped, and what it must still look like to resume there. */
interface ScanState {
	/** Bytes consumed: the end of the last complete ("\n"-terminated) line. */
	offset: number;
	/** Byte length of the header line, including its line ending. */
	headerLen: number;
	/** sha1 of the header line bytes. */
	headerHash: string;
	/** sha1 of the bytes [max(headerLen, offset - SCAN_ANCHOR_BYTES), offset). */
	anchorHash: string;
	/** Newest user/assistant activity time seen so far. */
	lastActivity?: number;
	/** Whether the first user message has been found (info.firstMessage holds it). */
	firstFound: boolean;
}

interface IndexEntry {
	fp: Fingerprint;
	info: ScannedSessionInfo;
	/** Absent for entries written by older versions; the next change rescans fully. */
	scan?: ScanState;
}

/** The list API, the sidebar and the proxy only ever use the first 320 characters. */
export const FIRST_MESSAGE_MAX_CHARS = 320;
const HEADER_READ_INITIAL_BYTES = 4 * 1024;
const HEADER_READ_MAX_BYTES = 64 * 1024;
const SCAN_ANCHOR_BYTES = 256;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const SCAN_MIN_BUFFER_BYTES = 64 * 1024;
// Debounced, asynchronous index persistence: a turn ending rewrites one row, so
// a short delay coalesces bursts without risking much on a crash (the index is
// a cache and changed files are simply rescanned).
const INDEX_PERSIST_DELAY_MS = 2_000;

type RawEntry = Record<string, unknown>;

function isRecord(value: unknown): value is RawEntry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const INDEX_FORMAT_VERSION = 1;

interface PersistState {
	timer?: ReturnType<typeof setTimeout>;
	writing?: Promise<void>;
	dirty: boolean;
}

declare global {
	var __piWebScanIndex: Map<string, IndexEntry> | undefined;
	var __piWebScanIndexLoaded: boolean | undefined;
	var __piWebScanIndexPersist: PersistState | undefined;
}

function parseLine(line: string): RawEntry | null {
	if (!line.trim()) return null;
	try {
		const entry = JSON.parse(line) as RawEntry;
		return entry && typeof entry === "object" ? entry : null;
	} catch {
		return null;
	}
}

function sha1(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("base64");
}

function truncateFirstMessage(text: string): string {
	return text.length > FIRST_MESSAGE_MAX_CHARS ? text.slice(0, FIRST_MESSAGE_MAX_CHARS) : text;
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

/**
 * The first physical line including its "\n", reading 4KB first and growing to
 * 64KB only for unusually long headers. Null when no newline is found.
 */
async function readFirstLine(handle: FileHandle): Promise<Buffer | null> {
	let length = HEADER_READ_INITIAL_BYTES;
	for (;;) {
		const bytes = await readRange(handle, 0, length);
		const newline = bytes.indexOf(0x0a);
		if (newline >= 0) return bytes.subarray(0, newline + 1);
		if (bytes.length < length || length >= HEADER_READ_MAX_BYTES) return null;
		length = Math.min(length * 4, HEADER_READ_MAX_BYTES);
	}
}

/** Read only the first physical line needed to identify a session file. */
async function readSessionHeaderSummary(filePath: string): Promise<RawEntry | null> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(filePath, "r");
		const firstLine = await readFirstLine(handle);
		// Same as before: a header without a newline in the bounded window is
		// still accepted when the bounded read holds the whole (tiny) file.
		const source = firstLine
			? firstLine.toString("utf8")
			: (await readRange(handle, 0, HEADER_READ_MAX_BYTES)).toString("utf8");
		for (const line of source.split("\n")) {
			const entry = parseLine(line.replace(/\r$/, ""));
			if (!entry) continue;
			return entry.type === "session" ? entry : null;
		}
		return null;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function hasMatchingFingerprint(
	cached: IndexEntry | undefined,
	fingerprint: Fingerprint,
): cached is IndexEntry {
	return Boolean(
		cached
		&& cached.fp.size === fingerprint.size
		&& cached.fp.mtimeMs === fingerprint.mtimeMs,
	);
}

/** Build a session row from the header alone, without parsing the transcript. */
async function deferredSessionInfo(
	filePath: string,
	fingerprint: Fingerprint,
): Promise<ScannedSessionInfo | null> {
	const header = await readSessionHeaderSummary(filePath);
	if (
		!header
		|| typeof header.id !== "string"
		|| typeof header.cwd !== "string"
		|| typeof header.timestamp !== "string"
	) return null;

	const created = new Date(header.timestamp);
	if (!Number.isFinite(created.getTime())) return null;

	return {
		path: filePath,
		id: header.id,
		cwd: header.cwd,
		created,
		modified: new Date(fingerprint.mtimeMs),
		messageCount: 0,
		firstMessage: "",
		...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
		detailsPending: true,
	};
}

function extractTextContent(message: RawEntry): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as RawEntry).type === "text" &&
				typeof (block as RawEntry).text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function activityTimeOf(entry: RawEntry): number | undefined {
	const message = entry.message as RawEntry | undefined;
	if (
		!message ||
		typeof message.role !== "string" ||
		!("content" in message) ||
		(message.role !== "user" && message.role !== "assistant")
	) {
		return undefined;
	}
	if (typeof message.timestamp === "number") return message.timestamp;
	const t = new Date(entry.timestamp as string).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/** Running totals of one scan; the persisted index stores them to resume later. */
interface ScanAccumulator {
	header: RawEntry | null;
	name: string | undefined;
	messageCount: number;
	firstMessage: string;
	firstFound: boolean;
	lastActivity: number | undefined;
}

// JSON.stringify writes entries as {"type":...} with no whitespace, and the SDK
// builds message entries in a fixed key order. Lines matching these prefixes are
// classified from their first bytes; anything else is parsed exactly as before.
const LINE_TYPE_RE = /^\{"type":"([a-z_]+)"/;
const TOOL_RESULT_LINE_RE = /^\{"type":"message","id":"[^"\\]*","parentId":(?:"[^"\\]*"|null),"timestamp":"[^"\\]*","message":\{"role":"toolResult"/;
const LINE_HEAD_BYTES = 256;
const LINE_SEPARATOR = Buffer.from("\u2028");
const PARAGRAPH_SEPARATOR = Buffer.from("\u2029");
const READLINE_BREAK_RE = /\r|\u2028|\u2029/;

/** Bytes that readline treats as a line end besides "\n" (checked per chunk, then per line). */
function hasReadlineBreak(bytes: Buffer): boolean {
	return bytes.indexOf(0x0d) !== -1
		|| bytes.indexOf(LINE_SEPARATOR) !== -1
		|| bytes.indexOf(PARAGRAPH_SEPARATOR) !== -1;
}

/** Apply one parsed entry; false when the file turns out not to be a session. */
function applyEntry(acc: ScanAccumulator, entry: RawEntry): boolean {
	if (!acc.header) {
		if (entry.type !== "session") return false;
		acc.header = entry;
		return true;
	}

	if (entry.type === "session_info") {
		acc.name =
			typeof entry.name === "string" && entry.name.trim()
				? entry.name.trim()
				: undefined;
	}
	if (entry.type !== "message") return true;
	acc.messageCount++;

	const activityTime = activityTimeOf(entry);
	if (typeof activityTime === "number") {
		acc.lastActivity = Math.max(acc.lastActivity ?? 0, activityTime);
	}

	const message = entry.message as RawEntry | undefined;
	if (
		!message ||
		typeof message.role !== "string" ||
		!("content" in message)
	)
		return true;
	if (message.role !== "user" && message.role !== "assistant") return true;
	if (acc.firstFound || message.role !== "user") return true;

	const textContent = extractTextContent(message);
	if (!textContent) return true;
	acc.firstMessage = truncateFirstMessage(textContent);
	acc.firstFound = true;
	return true;
}

/**
 * Process one complete line (without its "\n"). Tool results — over half of a
 * typical transcript's bytes — only bump the message count, and entry types
 * that never affect the listing are skipped, both without decoding the line.
 */
function applyLine(acc: ScanAccumulator, bytes: Buffer, start: number, end: number, special: boolean): boolean {
	if (end > start && bytes[end - 1] === 0x0d) end--;
	if (end <= start) return true;
	if (special && hasReadlineBreak(bytes.subarray(start, end))) {
		// The SDK listing reads with readline, which also ends lines at a lone
		// "\r", U+2028 and U+2029; JSON.stringify leaves the latter two raw inside
		// strings. Split the same way so counts match SessionManager.listAll().
		for (const fragment of bytes.toString("utf8", start, end).split(READLINE_BREAK_RE)) {
			const entry = parseLine(fragment);
			if (entry && !applyEntry(acc, entry)) return false;
		}
		return true;
	}
	if (acc.header && bytes[start] === 0x7b) {
		const head = bytes.toString("latin1", start, Math.min(end, start + LINE_HEAD_BYTES));
		const type = LINE_TYPE_RE.exec(head)?.[1];
		if (type !== undefined && type !== "message" && type !== "session_info") return true;
		if (type === "message" && TOOL_RESULT_LINE_RE.test(head)) {
			acc.messageCount++;
			return true;
		}
	}
	const entry = parseLine(bytes.toString("utf8", start, end));
	return entry ? applyEntry(acc, entry) : true;
}

interface ScanOutcome {
	info: ScannedSessionInfo;
	scan?: ScanState;
}

function anchorStart(state: { headerLen: number }, offset: number): number {
	return Math.max(state.headerLen, offset - SCAN_ANCHOR_BYTES);
}

/** Load the prior state only when the file still starts with the same bytes up to its offset. */
async function resumableState(
	filePath: string,
	prior: IndexEntry | undefined,
	size: number,
): Promise<{ state: ScanState; info: ScannedSessionInfo; anchor: Buffer } | null> {
	const scan = prior?.scan;
	if (!prior || !scan) return null;
	let reason: string | null = null;
	let anchor: Buffer | null = null;
	let handle: FileHandle | undefined;
	try {
		if (size < scan.offset) reason = "file shrank";
		else {
			handle = await open(filePath, "r");
			const header = await readFirstLine(handle);
			if (!header || header.length !== scan.headerLen || sha1(header) !== scan.headerHash) {
				reason = "header line changed";
			} else {
				const from = anchorStart(scan, scan.offset);
				anchor = await readRange(handle, from, scan.offset - from);
				if (anchor.length !== scan.offset - from || sha1(anchor) !== scan.anchorHash) reason = "anchor bytes changed";
			}
		}
	} catch (error) {
		reason = `resume probe failed: ${(error as Error).message}`;
	} finally {
		await handle?.close().catch(() => undefined);
	}
	if (reason || !anchor) {
		// Fallback is expected after a project move/rename or an SDK rewrite.
		console.info(`[pi-web] session index: full rescan of ${basename(filePath)} (${reason})`);
		return null;
	}
	return { state: scan, info: prior.info, anchor: Buffer.from(anchor) };
}

/** The last `n` bytes across `parts` (in order), copied. */
function lastBytes(parts: readonly Buffer[], n: number): Buffer {
	const picked: Buffer[] = [];
	let need = n;
	for (let i = parts.length - 1; i >= 0 && need > 0; i--) {
		const part = parts[i];
		const take = Math.min(need, part.length);
		picked.unshift(part.subarray(part.length - take));
		need -= take;
	}
	return Buffer.concat(picked);
}

let readTrace: Array<[string, number]> | null = null;

/** Test seam: record [path, start offset] of every transcript read until stop(). */
export function traceSessionScanReadsForTests(): { reads: Array<[string, number]>; stop(): void } {
	const reads: Array<[string, number]> = [];
	readTrace = reads;
	return { reads, stop: () => { if (readTrace === reads) readTrace = null; } };
}

async function scanSessionFile(
	filePath: string,
	prior?: IndexEntry,
): Promise<ScanOutcome | null> {
	try {
		const stats = await stat(filePath);
		const resume = await resumableState(filePath, prior, stats.size);
		const acc: ScanAccumulator = resume
			? {
				header: { type: "session" },
				name: resume.info.name,
				messageCount: resume.info.messageCount,
				firstMessage: resume.state.firstFound ? resume.info.firstMessage : "",
				firstFound: resume.state.firstFound,
				lastActivity: resume.state.lastActivity,
			}
			: { header: null, name: undefined, messageCount: 0, firstMessage: "", firstFound: false, lastActivity: undefined };
		const startOffset = resume ? resume.state.offset : 0;
		readTrace?.push([filePath, startOffset]);

		// Track the header line (first physical line) and the consumed offset.
		let headerLen = resume ? resume.state.headerLen : -1;
		let headerHash = resume ? resume.state.headerHash : "";
		let headerOnFirstLine = Boolean(resume);
		let lineIndex = 0;
		let consumed = startOffset;
		// Bytes of an unfinished line, kept as a list so one huge line (an inline
		// image) is concatenated once rather than once per chunk.
		let pending: Buffer[] = [];
		let pendingLength = 0;
		let notSession = false;
		// The last bytes before `consumed`, kept to hash the resume anchor.
		let anchorTail: Buffer = resume ? resume.anchor : Buffer.alloc(0);

		const processLine = (bytes: Buffer, start: number, end: number, special: boolean): boolean => {
			if (lineIndex === 0 && !resume) {
				const headerBytes = bytes.subarray(start, end + 1);
				headerLen = headerBytes.length;
				headerHash = sha1(headerBytes);
			}
			const hadHeader = Boolean(acc.header);
			if (!applyLine(acc, bytes, start, end, special)) return false;
			if (lineIndex === 0 && !resume) headerOnFirstLine = !hadHeader && Boolean(acc.header);
			lineIndex++;
			return true;
		};

		// One buffer per scan, reused across reads (sized to the bytes left, so the
		// many small files stay cheap): far less allocation than a read stream.
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(Math.max(SCAN_MIN_BUFFER_BYTES, Math.min(SCAN_CHUNK_BYTES, stats.size - startOffset + 1)));
			let position = startOffset;
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) break;
				position += bytesRead;
				const chunk = buffer.subarray(0, bytesRead);
				const lastNewline = chunk.lastIndexOf(0x0a);
				if (lastNewline === -1) {
					pending.push(Buffer.from(chunk));
					pendingLength += chunk.length;
					continue;
				}
				const special = hasReadlineBreak(chunk);
				let lineStart = 0;
				let newline = chunk.indexOf(0x0a);
				if (pendingLength > 0) {
					const line = Buffer.concat([...pending, chunk.subarray(0, newline + 1)]);
					if (!processLine(line, 0, line.length - 1, true)) { notSession = true; break; }
					lineStart = newline + 1;
					newline = chunk.indexOf(0x0a, lineStart);
				}
				while (newline !== -1) {
					if (!processLine(chunk, lineStart, newline, special)) { notSession = true; break; }
					lineStart = newline + 1;
					newline = chunk.indexOf(0x0a, lineStart);
				}
				if (notSession) break;
				const done = chunk.subarray(0, lastNewline + 1);
				anchorTail = lastBytes(
					done.length >= SCAN_ANCHOR_BYTES ? [done] : [anchorTail, ...pending, done],
					SCAN_ANCHOR_BYTES,
				);
				consumed += pendingLength + done.length;
				pending = lastNewline + 1 < chunk.length ? [Buffer.from(chunk.subarray(lastNewline + 1))] : [];
				pendingLength = chunk.length - (lastNewline + 1);
			}
		} finally {
			await handle.close().catch(() => undefined);
		}
		if (notSession) return null;

		// A trailing line without "\n" is either a write in progress (unparseable,
		// ignored exactly like before) or a complete entry from a writer that
		// omits the final newline. The latter counts, but cannot be resumed from.
		// A resumed scan rebuilds created/modified from the stored ISO timestamp,
		// so only headers with a string timestamp (all SDK-written ones) resume.
		let resumable = headerOnFirstLine && headerLen > 0 && (Boolean(resume) || typeof acc.header?.timestamp === "string");
		if (pendingLength > 0) {
			for (const fragment of Buffer.concat(pending).toString("utf8").split(READLINE_BREAK_RE)) {
				const tailEntry = parseLine(fragment);
				if (!tailEntry) continue;
				if (!applyEntry(acc, tailEntry)) return null;
				resumable = false;
			}
		}

		const header = acc.header;
		if (!header) return null;
		const base = resume ? resume.info : null;

		const cwd = base ? base.cwd : typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = base
			? base.parentSessionPath
			: typeof header.parentSession === "string"
				? header.parentSession
				: undefined;
		const created = base ? base.created : new Date(header.timestamp as string);
		const headerTime = base
			? base.created.getTime()
			: typeof header.timestamp === "string"
				? new Date(header.timestamp).getTime()
				: NaN;
		const modified =
			typeof acc.lastActivity === "number" && acc.lastActivity > 0
				? new Date(acc.lastActivity)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		const info: ScannedSessionInfo = {
			path: filePath,
			id: base ? base.id : header.id as string,
			cwd,
			name: acc.name,
			parentSessionPath,
			created,
			modified,
			messageCount: acc.messageCount,
			firstMessage: acc.firstMessage || "(no messages)",
		};
		const anchorLength = consumed - anchorStart({ headerLen }, consumed);
		if (!resumable || anchorLength < 0 || anchorTail.length < anchorLength) return { info };
		const anchor = anchorTail.subarray(anchorTail.length - anchorLength);
		return {
			info,
			scan: {
				offset: consumed,
				headerLen,
				headerHash,
				anchorHash: sha1(anchor),
				...(acc.lastActivity !== undefined ? { lastActivity: acc.lastActivity } : {}),
				firstFound: acc.firstFound,
			},
		};
	} catch {
		return null;
	}
}

// Uses the SDK's buildSessionInfo() semantics for displayed metadata, except
// that firstMessage is capped at FIRST_MESSAGE_MAX_CHARS.
export async function scanSessionFileInfo(
	filePath: string,
): Promise<ScannedSessionInfo | null> {
	return (await scanSessionFile(filePath))?.info ?? null;
}

async function enumerateSessionFiles(sessionsDir: string): Promise<string[]> {
	let dirs: Dirent[];
	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		dirs = entries.filter(
			(entry) => entry.isDirectory() || entry.isSymbolicLink(),
		);
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const dir of dirs) {
		const dirPath = join(sessionsDir, dir.name);
		try {
			for (const f of await readdir(dirPath)) {
				if (f.endsWith(".jsonl")) files.push(join(dirPath, f));
			}
		} catch {
			// unreadable project dir: same skip-as-absent semantics as the SDK
		}
	}
	return files;
}

const MAX_CONCURRENT_SCANS = 10;

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
	let next = 0;
	const inFlight = new Set<Promise<void>>();
	while (next < items.length || inFlight.size > 0) {
		while (next < items.length && inFlight.size < MAX_CONCURRENT_SCANS) {
			const item = items[next++];
			const task = worker(item).finally(() => inFlight.delete(task));
			inFlight.add(task);
		}
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
}

function getIndex(): Map<string, IndexEntry> {
	if (!globalThis.__piWebScanIndex) globalThis.__piWebScanIndex = new Map();
	return globalThis.__piWebScanIndex;
}

function indexFilePath(): string {
	return join(getAgentDir(), "pi-web-session-index.json");
}

function parseScanState(value: unknown): ScanState | undefined {
	if (!isRecord(value)) return undefined;
	const { offset, headerLen, headerHash, anchorHash, lastActivity, firstFound } = value;
	if (
		typeof offset !== "number" || !Number.isSafeInteger(offset) ||
		typeof headerLen !== "number" || !Number.isSafeInteger(headerLen) || headerLen <= 0 || offset < headerLen ||
		typeof headerHash !== "string" || typeof anchorHash !== "string" ||
		(lastActivity !== undefined && (typeof lastActivity !== "number" || !Number.isFinite(lastActivity))) ||
		typeof firstFound !== "boolean"
	) return undefined;
	return {
		offset,
		headerLen,
		headerHash,
		anchorHash,
		...(lastActivity !== undefined ? { lastActivity } : {}),
		firstFound,
	};
}

function loadPersistedIndex(): void {
	if (globalThis.__piWebScanIndexLoaded) return;
	globalThis.__piWebScanIndexLoaded = true;
	const path = indexFilePath();
	if (!existsSync(path)) return;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || parsed.version !== INDEX_FORMAT_VERSION || !isRecord(parsed.entries)) {
			console.info("[pi-web] session index: unrecognized persisted index, rebuilding");
			return;
		}
		const index = getIndex();
		let shrunk = false;
		for (const [pathKey, entry] of Object.entries(parsed.entries)) {
			if (!isRecord(entry) || !isRecord(entry.fp) || !isRecord(entry.info)) continue;
			const { fp, info } = entry;
			if (
				typeof fp.size !== "number" || !Number.isSafeInteger(fp.size) || fp.size < 0 ||
				typeof fp.mtimeMs !== "number" || !Number.isFinite(fp.mtimeMs) ||
				info.path !== pathKey ||
				typeof info.id !== "string" ||
				typeof info.cwd !== "string" ||
				typeof info.firstMessage !== "string" ||
				(info.name !== undefined && typeof info.name !== "string") ||
				(info.parentSessionPath !== undefined && typeof info.parentSessionPath !== "string") ||
				typeof info.messageCount !== "number" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0 ||
				typeof info.created !== "string" || typeof info.modified !== "string"
			) continue;
			const created = new Date(info.created);
			const modified = new Date(info.modified);
			if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) continue;
			// Entries from older versions carry no scan state: they stay valid
			// for unchanged files and get a full rescan on their next change.
			const scan = parseScanState(entry.scan);
			if (info.firstMessage.length > FIRST_MESSAGE_MAX_CHARS) shrunk = true;
			index.set(pathKey, {
				fp: { size: fp.size, mtimeMs: fp.mtimeMs },
				info: {
					path: pathKey,
					id: info.id,
					cwd: info.cwd,
					name: info.name,
					parentSessionPath: info.parentSessionPath,
					// Older indexes stored the whole message (up to ~100KB each).
					firstMessage: truncateFirstMessage(info.firstMessage),
					messageCount: info.messageCount,
					created,
					modified,
				},
				...(scan ? { scan } : {}),
			});
		}
		// An index written before first messages were capped is ~10x larger;
		// rewrite it once instead of re-parsing it on every start.
		if (shrunk) queueIndexPersist();
	} catch (error) {
		// corrupt index => cold rebuild, never an error surfaced to callers
		console.info("[pi-web] session index: unreadable persisted index, rebuilding:", (error as Error).message);
	}
}

function getPersistState(): PersistState {
	if (!globalThis.__piWebScanIndexPersist) globalThis.__piWebScanIndexPersist = { dirty: false };
	return globalThis.__piWebScanIndexPersist;
}

async function writeIndexFileAtomic(path: string, contents: string): Promise<void> {
	const tempPath = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
		await rename(tempPath, path);
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
}

function runIndexPersist(): Promise<void> {
	const state = getPersistState();
	if (state.writing) return state.writing;
	const writing = (async () => {
		while (state.dirty) {
			state.dirty = false;
			try {
				const entries: Record<string, IndexEntry> = {};
				for (const [pathKey, entry] of getIndex()) entries[pathKey] = entry;
				await writeIndexFileAtomic(
					indexFilePath(),
					JSON.stringify({ version: INDEX_FORMAT_VERSION, entries }),
				);
			} catch (error) {
				// persistence is best-effort; the in-memory index remains authoritative
				console.warn("[pi-web] session index persist failed:", (error as Error).message);
			}
		}
	})().finally(() => {
		if (state.writing === writing) state.writing = undefined;
	});
	state.writing = writing;
	return writing;
}

function queueIndexPersist(): void {
	const state = getPersistState();
	state.dirty = true;
	if (state.timer || state.writing) return; // a running writer re-checks `dirty`
	state.timer = setTimeout(() => {
		state.timer = undefined;
		void runIndexPersist();
	}, INDEX_PERSIST_DELAY_MS);
	state.timer.unref?.();
}

/** Write any pending index changes now (tests, shutdown). */
export async function flushSessionScanIndexPersist(): Promise<void> {
	const state = getPersistState();
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = undefined;
	}
	if (state.writing) await state.writing;
	if (state.dirty) await runIndexPersist();
}

/**
 * Incremental equivalent of SessionManager.listAll(): rescans only files whose
 * (size, mtimeMs) changed since the last pass. Output ordering matches the SDK
 * catalogue (modified descending).
 */
export async function listSessionsIncremental(
	options: { deferDetails?: boolean } = {},
): Promise<ScannedSessionInfo[]> {
	loadPersistedIndex();
	const deferDetails = options.deferDetails ?? false;

	const sessionsDir = join(getAgentDir(), "sessions");
	const files = await enumerateSessionFiles(sessionsDir);

	const index = getIndex();
	const present = new Set(files);
	const stale: string[] = [];
	for (const known of index.keys()) {
		if (!present.has(known)) stale.push(known);
	}
	for (const pathKey of stale) index.delete(pathKey);

	const fingerprints = await Promise.all(
		files.map(async (filePath) => {
			try {
				const s = await stat(filePath);
				return {
					filePath,
					fp: { size: s.size, mtimeMs: s.mtimeMs } as Fingerprint,
				};
			} catch {
				return { filePath, fp: null as Fingerprint | null };
			}
		}),
	);

	const changed: Array<{ filePath: string; fp: Fingerprint; resultIndex: number }> = [];
	const deferred: Array<{ filePath: string; fp: Fingerprint; resultIndex: number }> = [];
	const results: (ScannedSessionInfo | null)[] = new Array(files.length).fill(null);
	const mtimes: number[] = new Array(files.length).fill(Number.NEGATIVE_INFINITY);
	let removed = stale.length > 0;
	for (const [resultIndex, { filePath, fp }] of fingerprints.entries()) {
		if (!fp) {
			if (index.delete(filePath)) removed = true;
			continue;
		}
		mtimes[resultIndex] = fp.mtimeMs;
		const cached = index.get(filePath);
		if (hasMatchingFingerprint(cached, fp)) {
			// Complete details are already in memory and the index is persisted
			// across restarts, so on the common warm path every unchanged file
			// can paint its real count and first message immediately. Blanking
			// them would cost a request to get back what we are already holding.
			results[resultIndex] = cached.info;
			continue;
		}
		if (deferDetails) {
			// Header and stat only: a later normal listing fills in the transcript
			// details, so a first paint does not wait on parsing every file.
			deferred.push({ filePath, fp, resultIndex });
			continue;
		}
		changed.push({ filePath, fp, resultIndex });
	}

	await runPool(deferred, async ({ filePath, fp, resultIndex }) => {
		const summary = await deferredSessionInfo(filePath, fp);
		if (summary) results[resultIndex] = summary;
		else if (index.delete(filePath)) removed = true;
	});

	await runPool(changed, async ({ filePath, fp, resultIndex }) => {
		const outcome = await scanSessionFile(filePath, index.get(filePath));
		if (outcome) {
			index.set(filePath, { fp, info: outcome.info, ...(outcome.scan ? { scan: outcome.scan } : {}) });
			results[resultIndex] = outcome.info;
		} else {
			index.delete(filePath);
		}
	});

	if (changed.length > 0 || removed) queueIndexPersist();

	// Preserve catalogue order for timestamp ties, independently of cache hits
	// and the order in which concurrent file reads complete. Since pi 0.86 the
	// SDK reads files newest-mtime first (then reverse filename) so resume can
	// show results progressively, and its stable sort keeps that order for
	// sessions with equal activity time.
	return results
		.flatMap((info, resultIndex) => (info ? [{ info, mtimeMs: mtimes[resultIndex] }] : []))
		.sort((a, b) =>
			b.info.modified.getTime() - a.info.modified.getTime()
			|| b.mtimeMs - a.mtimeMs
			|| basename(b.info.path).localeCompare(basename(a.info.path)),
		)
		.map(({ info }) => info);
}

/** Test seam: drop all in-memory index state (pending writes are discarded). */
export function resetSessionScanIndexForTests(): void {
	const persist = globalThis.__piWebScanIndexPersist;
	if (persist?.timer) clearTimeout(persist.timer);
	globalThis.__piWebScanIndex = undefined;
	globalThis.__piWebScanIndexLoaded = undefined;
	globalThis.__piWebScanIndexPersist = undefined;
}
