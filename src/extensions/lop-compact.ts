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

export const VERSION = "goal-index-v1";
export const INDEX_HEADER = "# Pi compact 会话索引\n\n每会话保留最新成功 compact 的完整 Goal 原文，不限字数；仅作历史线索。按来源路径和 Compact ID 可提取 summary 全文。状态截至压缩时间，不代表后续消息或当前运行态。\n\n";
const execute = promisify(execFile);
const digest = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const oneLine = (value: unknown) => String(value).replace(/[\r\n]/g, " ");

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
  return { key: digest(`${machine.toLowerCase()}\0${sessionId}`), machine, sessionId, sessionFile: path.resolve(sessionFile), compactId: entry.id, time, ...excerpt };
}

export function renderRecord(r: IndexRecord) {
  const id = Buffer.from(r.compactId).toString("base64url");
  const end = `<!-- /pi-compact ${r.key} -->`;
  if (r.text.includes(end)) throw new Error("index-marker-in-goal: source left untouched");
  return `<!-- pi-compact ${r.key} ${r.time} ${id} -->\n## ${oneLine(r.machine)} / ${oneLine(r.sessionId)}\n压缩：${new Date(r.time).toISOString()} · Compact ID：${oneLine(r.compactId)}\n来源：\`${oneLine(r.sessionFile)}\`\n\n### ${r.section}（原文）\n${r.fallback ? `提取说明：${r.fallback}\n` : ""}\n${r.text}${r.text.endsWith("\n") ? "" : "\n"}${end}\n\n`;
}

export function mergeIndex(original: string, records: IndexRecord[]) {
  let text = original || INDEX_HEADER;
  for (const r of records) {
    const start = new RegExp(`^<!-- pi-compact ${r.key} (\\d+) ([A-Za-z0-9_-]+) -->\\r?$`, "gm");
    const matches = [...text.matchAll(start)];
    if (matches.length > 1) throw new Error(`duplicate-index-session:${r.key}`);
    const block = renderRecord(r);
    if (!matches.length) { text += `${text.endsWith("\n") ? "" : "\n"}${block}`; continue; }
    const match = matches[0];
    if (Number(match[1]) > r.time) continue; // Delayed delivery must not roll back a newer checkpoint.
    const begin = match.index!;
    const close = `<!-- /pi-compact ${r.key} -->`;
    const end = text.indexOf(close, begin);
    if (end < 0) throw new Error(`index-block-not-closed:${r.key}`);
    const suffix = text.slice(end + close.length).replace(/^(?:\r?\n){0,2}/, "");
    text = text.slice(0, begin) + block + suffix;
  }
  return text;
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

  async function write(records: IndexRecord[]) {
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    const token = await acquireLock();
    const temp = `${indexPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const before = await readOptional(indexPath);
      const after = Buffer.from(mergeIndex(before?.toString("utf8") || "", records));
      if (before?.equals(after)) return { status: "unchanged", indexPath, bytes: after.length };
      if (before) {
        // Invoke the same implementation as `bak <file>`; hidden, no shell or model tool call.
        const backup = await execute(process.execPath, [options.backupTool || findBackupTool(), indexPath, "--label", `compact-${crypto.randomUUID()}`], { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
        if (!backup.stdout.startsWith("OK ")) throw new Error("backup-did-not-confirm-success");
        log(backup.stdout.trim());
      }
      const current = await readOptional(indexPath);
      if ((before === undefined) !== (current === undefined) || (before && !before.equals(current!))) throw new Error("index-changed-outside-lock: refusing-overwrite");
      const file = await fsp.open(temp, "wx");
      try { await file.writeFile(after); await file.sync(); } finally { await file.close(); }
      await fsp.rename(temp, indexPath);
      if (digest(await fsp.readFile(indexPath)) !== digest(after)) throw new Error("index-readback-mismatch");
      for (const r of records) if (r.fallback) log(`FALLBACK session=${r.sessionId} compact=${r.compactId} reason=${r.fallback}`);
      log(`UPDATED sessions=${records.length} bytes=${after.length} file=${indexPath}`);
      return { status: "updated", indexPath, bytes: after.length };
    } finally {
      await fsp.unlink(temp).catch((e: any) => { if (e.code !== "ENOENT") log(`TEMP_CLEANUP_FAILED ${e.message}`); });
      if ((await readOptional(lockPath))?.toString() === token) await fsp.unlink(lockPath);
    }
  }
  return {
    indexPath, log,
    update(records: IndexRecord[]) {
      const job = pending.then(() => write(records));
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
