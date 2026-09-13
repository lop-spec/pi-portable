// Passive compact export only. No model/tool/prompt/continuation hooks, messages or commands.
// The success handler returns immediately; serialized file I/O runs outside Pi's awaited event path.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const VERSION = "goal-index-v3-pruning";
const LEGACY_HEADER = "# Pi compact 会话索引\n\n每会话保留最新成功 compact 的完整 Goal 原文，不限字数；仅作历史线索。按来源路径和 Compact ID 可提取 summary 全文。状态截至压缩时间，不代表后续消息或当前运行态。\n\n";
const V2_HEADER = "# Pi compact 会话索引\n\n保留每条成功 compact 的完整 Goal 原文，不限字数，按机器＋会话 ID＋Compact ID 去重；双端按条目取并集，近期回填不删除已有旧条目。按来源机器、路径和 Compact ID 提取 summary 全文。仅作历史线索，状态截至对应压缩时间，不代表后续消息或当前运行态。\n\n";
export const INDEX_HEADER = "# Pi compact 会话索引\n\n按长期复用价值精选，维护后不超过50条，不凑上限。保留条目的完整 Goal 原文及机器、会话、Compact ID、来源路径，不二次总结。已清理键由同目录 pi-compact.md.pruned.json 管理，双机合并与回填不得复活。仅作历史线索；按来源机器、路径和 Compact ID 提取 summary 全文，历史状态不代表当前运行态。\n\n";
const execute = promisify(execFile);
const digest = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const oneLine = (value: unknown) => String(value).replace(/[\r\n]/g, " ");
const recordKey = (machine: string, sessionId: string, compactId: string) => digest(`${machine.toLowerCase()}\0${sessionId}\0${compactId}`);

export function defaultIndexPath() {
  if (process.env.PI_COMPACT_INDEX_FILE) return path.resolve(process.env.PI_COMPACT_INDEX_FILE);
  // Portable Pi rewrites HOME / USERPROFILE. The global rule is the single source of truth.
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rules = fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8");
  const match = rules.match(/`([^`\r\n]+[\\/]pi-compact\.md)`/);
  if (!match || !path.isAbsolute(match[1])) throw new Error("absolute-pi-compact-path-missing-in-global-rules");
  return path.resolve(match[1]);
}

export function findBackupTool() {
  const candidates = process.env.PI_PORTABLE_HOME ? [path.join(process.env.PI_PORTABLE_HOME, "tools", "backup.mjs")] : [];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) { candidates.push(path.join(dir, "tools", "backup.mjs")); dir = path.dirname(dir); }
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error("bak-helper-missing: index left unchanged");
  return found;
}

// Heading boundaries, not text summarization. Ignore Markdown headings inside fenced code.
export function extractGoal(summary: string) {
  if (typeof summary !== "string" || !summary.trim()) throw new Error("empty-compaction-summary");
  const headings: Array<{ name: string; level: number; start: number; body: number }> = [];
  let offset = 0, fence = "", fenceLength = 0;
  for (const line of summary.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const text = line.replace(/\r?\n$/, "");
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence && marker[1].length >= fenceLength && text.slice(marker[0].length).trim() === "") fence = "";
    } else if (marker) {
      fence = marker[1][0]; fenceLength = marker[1].length;
    } else {
      const heading = text.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) headings.push({ name: heading[2].replace(/[*`]/g, "").replace(/[:：]\s*$/, "").trim().toLowerCase(), level: heading[1].length, start: offset, body: offset + line.length });
    }
    offset += line.length;
  }
  const section = (names: string[]) => {
    const h = headings.find(h => names.includes(h.name));
    if (!h) return undefined;
    const end = headings.find(next => next.start > h.start && next.level <= h.level)?.start ?? summary.length;
    const text = summary.slice(h.body, end);
    return text.trim() ? text : undefined;
  };
  const goal = section(["goal", "goals", "目标"]);
  if (goal !== undefined) return { text: goal, section: "Goal", fallback: "" };
  const request = section(["original request", "原始请求"]);
  if (request !== undefined) return { text: request, section: "Original Request", fallback: "goal-missing-or-empty; using-original-request" };
  // Do not invent an alternative summary or silently copy an arbitrary partial paragraph.
  return { text: "", section: "Goal", fallback: "goal-missing-or-empty; source-reference-only" };
}

type Compaction = { type?: string; id: string; timestamp: string | number; summary: string };
export type IndexRecord = { key: string; machine: string; sessionId: string; sessionFile: string; compactId: string; time: number; text: string; section: string; fallback: string };
export function makeRecord(entry: Compaction, sessionId: string, sessionFile: string, machine = os.hostname()): IndexRecord {
  if (!entry?.id || !sessionId || !sessionFile || !path.isAbsolute(sessionFile)) throw new Error("missing-persisted-session-identity");
  const time = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp);
  if (!Number.isFinite(time)) throw new Error("invalid-compaction-timestamp");
  const excerpt = extractGoal(entry.summary);
  return { key: recordKey(machine, sessionId, entry.id), machine, sessionId, sessionFile: path.resolve(sessionFile), compactId: entry.id, time, ...excerpt };
}

export function renderRecord(r: IndexRecord) {
  const id = Buffer.from(r.compactId).toString("base64url");
  const end = `<!-- /pi-compact ${r.key} -->`;
  if (r.text.includes(end)) throw new Error("index-marker-in-goal: source left untouched");
  return `<!-- pi-compact ${r.key} ${r.time} ${id} ${r.text.length} -->\n## ${oneLine(r.machine)} / ${oneLine(r.sessionId)}\n压缩：${new Date(r.time).toISOString()} · Compact ID：${oneLine(r.compactId)}\n来源：\`${oneLine(r.sessionFile)}\`\n\n### ${r.section}（原文）\n${r.fallback ? `提取说明：${r.fallback}\n` : ""}\n${r.text}${r.text.endsWith("\n") ? "" : "\n"}${end}\n\n`;
}

export function parseIndex(text: string) {
  const records: IndexRecord[] = [], notes = new Map<string, string>();
  const header = /^<!-- pi-compact ([a-f0-9]{64}) (\d+) ([A-Za-z0-9_-]+)(?: (\d+))? -->\r?$/gm;
  let match: RegExpExecArray | null, prefix = text, endOfLast = 0;
  while ((match = header.exec(text))) {
    const gap = text.slice(endOfLast, match.index);
    if (!records.length) prefix = gap;
    else if (gap.trim()) notes.set(records.at(-1)!.key, gap);
    const close = `<!-- /pi-compact ${match[1]} -->`;
    const end = text.indexOf(close, header.lastIndex);
    if (end < 0) throw new Error(`index-block-not-closed:${match[1]}`);
    const body = text.slice(header.lastIndex, end);
    const identity = body.match(/^## (.+?) \/ (.+)\r?$/m);
    const source = body.match(/^来源：`([^`]+)`\r?$/m);
    const section = body.match(/^### (Goal|Original Request)（原文）\r?\n(?:提取说明：([^\r\n]*)\r?\n)?\r?\n/m);
    if (!identity || !source || !section) throw new Error(`invalid-index-metadata:${match[1]}`);
    const compactId = Buffer.from(match[3], "base64url").toString();
    const key = recordKey(identity[1], identity[2], compactId);
    if (match[1] !== key && match[1] !== digest(`${identity[1].toLowerCase()}\0${identity[2]}`)) throw new Error("index-identity-mismatch");
    const content = body.slice(section.index! + section[0].length);
    const goal = match[4] === undefined ? content : content.slice(0, Number(match[4]));
    if (match[4] !== undefined && (goal.length !== Number(match[4]) || content.slice(goal.length).trim())) throw new Error("index-goal-length-mismatch");
    records.push({ key, machine: identity[1], sessionId: identity[2], sessionFile: source[1], compactId, time: Number(match[2]), text: goal, section: section[1], fallback: section[2] || "" });
    endOfLast = end + close.length;
    header.lastIndex = endOfLast;
  }
  return { records, prefix, suffix: records.length ? text.slice(endOfLast).replace(/^(?:\r?\n){0,2}/, "") : "", notes };
}

export type PrunedRecord = { key: string; reason: string };
export function mergePruned(...sets: PrunedRecord[][]): PrunedRecord[] {
  const all = new Map<string, PrunedRecord>();
  for (const entries of sets) {
    if (!Array.isArray(entries)) throw new Error("invalid-pruned-state");
    for (const r of entries) {
      if (!r || !/^[a-f0-9]{64}$/.test(r.key) || typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 300) throw new Error("invalid-pruned-record");
      const previous = all.get(r.key);
      if (!previous || r.reason < previous.reason) all.set(r.key, { key: r.key, reason: r.reason });
    }
  }
  return [...all.values()].sort((a, b) => a.key.localeCompare(b.key, "en"));
}
export function readPruned(indexPath: string): PrunedRecord[] {
  const file = `${indexPath}.pruned.json`;
  try { return mergePruned(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
}
export function mergeIndex(original: string, records: IndexRecord[], pruned: PrunedRecord[] = []) {
  const existing = parseIndex(original);
  const all = new Map<string, IndexRecord>();
  for (const r of [...existing.records, ...records]) {
    if (r.key !== recordKey(r.machine, r.sessionId, r.compactId) || !path.isAbsolute(r.sessionFile) || !Number.isFinite(r.time)) throw new Error("invalid-incoming-index-record");
    const previous = all.get(r.key);
    if (previous && (previous.time !== r.time || previous.text.trimEnd() !== r.text.trimEnd() || previous.section !== r.section)) throw new Error(`conflicting-compact-record:${r.key}`);
    all.set(r.key, r);
  }
  const prefix = (existing.prefix || INDEX_HEADER).replace(LEGACY_HEADER, INDEX_HEADER).replace(V2_HEADER, INDEX_HEADER);
  const excluded = new Set(mergePruned(pruned).map(r => r.key));
  const sorted = [...all.values()].filter(r => !excluded.has(r.key)).sort((a, b) => b.time - a.time || a.key.localeCompare(b.key, "en"));
  return prefix + (prefix.endsWith("\n") ? "" : "\n") + sorted.map(r => renderRecord(r) + (existing.notes.get(r.key) || "")).join("") + existing.suffix;
}

async function readOptional(file: string) {
  try { return await fsp.readFile(file); } catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
}

export function createIndexWriter(options: { indexPath?: string; backupTool?: string; lockTimeoutMs?: number; log?: (line: string) => void } = {}) {
  const indexPath = path.resolve(options.indexPath || defaultIndexPath());
  const lockPath = `${indexPath}.lock`;
  const log = options.log || ((line: string) => {
    const message = `[${new Date().toISOString()}] [lop-compact] ${oneLine(line)}\n`;
    try { fs.mkdirSync(path.dirname(indexPath), { recursive: true }); fs.appendFileSync(`${indexPath}.log`, message); }
    catch (e) { console.error(message.trimEnd(), oneLine(e)); }
  });
  let pending = Promise.resolve<unknown>(undefined);

  async function acquireLock() {
    const token = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
    const deadline = Date.now() + (options.lockTimeoutMs ?? 5000);
    while (true) {
      try {
        const handle = await fsp.open(lockPath, "wx");
        try { await handle.writeFile(token); } finally { await handle.close(); }
        return token;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        const existing = await readOptional(lockPath);
        if (!existing) continue;
        let dead = false;
        try {
          const owner = JSON.parse(existing.toString());
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid-lock-owner");
          try { process.kill(owner.pid, 0); } catch (err: any) { if (err.code === "ESRCH") dead = true; }
        } catch {
          const stat = await fsp.stat(lockPath).catch(() => undefined);
          dead = !!stat && Date.now() - stat.mtimeMs > 30000;
        }
        if (dead && (await readOptional(lockPath))?.equals(existing)) {
          // Reaping is serialized too: a second reaper must not remove a new writer's lock.
          const reaperPath = `${lockPath}.reap`;
          let reaper;
          try { reaper = await fsp.open(reaperPath, "wx"); }
          catch (err: any) { if (err.code !== "EEXIST") throw err; }
          if (reaper) {
            try {
              if ((await readOptional(lockPath))?.equals(existing)) { await fsp.unlink(lockPath); log("RECOVER dead-writer-lock"); }
            } finally { await reaper.close(); await fsp.unlink(reaperPath); }
            continue;
          }
        }
        if (Date.now() >= deadline) throw new Error("index-lock-timeout: index left unchanged");
        await wait(25);
      }
    }
  }

  async function write(records: IndexRecord[], removals: PrunedRecord[]) {
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    const token = await acquireLock();
    const temp = `${indexPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const prunedPath = `${indexPath}.pruned.json`, prunedTemp = `${temp}.pruned`;
    try {
      const before = await readOptional(indexPath);
      const priorPruned = await readOptional(prunedPath);
      const pruned = mergePruned(priorPruned ? JSON.parse(priorPruned.toString("utf8")) : [], removals);
      const prunedBytes = Buffer.from(JSON.stringify(pruned, null, 2) + "\n");
      const stateChanged = pruned.length > 0 && !priorPruned?.equals(prunedBytes);
      const after = Buffer.from(mergeIndex(before?.toString("utf8") || "", records, pruned));
      const excluded = new Set(pruned.map(r => r.key));
      const suppressed = [...parseIndex(before?.toString("utf8") || "").records, ...records].filter(r => excluded.has(r.key));
      if (suppressed.length) log(`PRUNED_SUPPRESSED count=${new Set(suppressed.map(r => r.key)).size} reason=reviewed-low-value`);
      if (before?.equals(after) && !stateChanged) return { status: "unchanged", indexPath, bytes: after.length };
      if (before) {
        // Invoke the same implementation as `bak <file>`; hidden, no shell or model tool call.
        const backup = await execute(process.execPath, [options.backupTool || findBackupTool(), indexPath, "--label", `compact-${crypto.randomUUID()}`], { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
        if (!backup.stdout.startsWith("OK ")) throw new Error("backup-did-not-confirm-success");
        log(backup.stdout.trim());
      }
      if (stateChanged && priorPruned) {
        const backup = await execute(process.execPath, [options.backupTool || findBackupTool(), prunedPath, "--label", `compact-${crypto.randomUUID()}`], { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
        if (!backup.stdout.startsWith("OK ")) throw new Error("pruned-backup-did-not-confirm-success");
        log(backup.stdout.trim());
      }
      const currentPruned = await readOptional(prunedPath);
      if ((priorPruned === undefined) !== (currentPruned === undefined) || (priorPruned && !priorPruned.equals(currentPruned!))) throw new Error("pruned-state-changed-outside-lock");
      const current = await readOptional(indexPath);
      if ((before === undefined) !== (current === undefined) || (before && !before.equals(current!))) throw new Error("index-changed-outside-lock: refusing-overwrite");
      // Persist exclusions first: a crash between files is repaired by the next writer.
      // No source session is changed; both files share this writer's lock and backup gate.
      if (stateChanged) {
        const state = await fsp.open(prunedTemp, "wx");
        try { await state.writeFile(prunedBytes); await state.sync(); } finally { await state.close(); }
        await fsp.rename(prunedTemp, prunedPath);
        if (!(await fsp.readFile(prunedPath)).equals(prunedBytes)) throw new Error("pruned-readback-mismatch");
      }
      const file = await fsp.open(temp, "wx");
      try { await file.writeFile(after); await file.sync(); } finally { await file.close(); }
      await fsp.rename(temp, indexPath);
      if (digest(await fsp.readFile(indexPath)) !== digest(after)) throw new Error("index-readback-mismatch");
      for (const r of records) if (r.fallback) log(`FALLBACK session=${r.sessionId} compact=${r.compactId} reason=${r.fallback}`);
      log(`UPDATED compacts=${records.length} bytes=${after.length} file=${indexPath}`);
      return { status: "updated", indexPath, bytes: after.length };
    } finally {
      for (const file of [temp, prunedTemp]) await fsp.unlink(file).catch((e: any) => { if (e.code !== "ENOENT") log(`TEMP_CLEANUP_FAILED ${e.message}`); });
      if ((await readOptional(lockPath))?.toString() === token) await fsp.unlink(lockPath);
    }
  }
  return {
    indexPath, log,
    update(records: IndexRecord[], removals: PrunedRecord[] = []) {
      const job = pending.then(() => write(records, removals));
      pending = job.catch(() => undefined); // A failed export must not poison subsequent exports.
      return job;
    },
    drain: () => pending,
  };
}

export function registerCompactExport(pi: Pick<ExtensionAPI, "on">, writer = createIndexWriter()) {
  pi.on("session_compact", (event, ctx) => {
    try {
      const sm = ctx.sessionManager;
      // Some Pi versions resolve the event by summary equality. Recover the actual newest
      // saved entry from the active branch when two checkpoints have identical summaries.
      const saved = sm.getBranch().findLast(e => e.type === "compaction");
      if (!saved || saved.type !== "compaction" || saved.summary !== event.compactionEntry.summary) throw new Error("success-event-does-not-match-saved-branch");
      if (saved.id !== event.compactionEntry.id) writer.log(`EVENT_ID_RESOLVED old=${event.compactionEntry.id} saved=${saved.id}`);
      const record = makeRecord(saved, sm.getSessionId(), sm.getSessionFile() || "");
      void writer.update([record]).catch(e => writer.log(`EXPORT_FAILED session=${record.sessionId} compact=${record.compactId} reason=${oneLine(e)}`));
    } catch (e) { writer.log(`EXPORT_FAILED reason=${oneLine(e)}`); }
    // No Promise, return value, message, model call, or mutation of the event/context.
  });
  return writer;
}

export default function (pi: ExtensionAPI) { registerCompactExport(pi); }
