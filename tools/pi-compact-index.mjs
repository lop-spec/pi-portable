// Explicit administration / source lookup only; never invoked by an extension or model hook.
// backfill --sessions <dir> [--days 7] [--index <md>]; sync --days 7; show <jsonl> <compact-id>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIndexWriter, defaultIndexPath, makeRecord, mergeIndex, parseIndex } from "../src/extensions/lop-compact.ts";
import { SITES, PEER_OF, localSiteName } from "./peer-sync.mjs";

const execute = promisify(execFile);
const defaultSessionsDir = () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || os.homedir(), ".pi", "agent"), "sessions");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export function indexSnapshot(indexPath = defaultIndexPath()) {
  const bytes = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : Buffer.alloc(0);
  return { indexPath, hash: sha(bytes), bytes: bytes.length, records: parseIndex(bytes.toString("utf8")).records };
}

export async function readCompaction(file, wantedId, { since = -Infinity, until = Infinity, onCompact } = {}) {
  let sessionId, compact, count = 0, matches = 0;
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!/"type"\s*:\s*"(?:session|compaction)"/.test(line.slice(0, 160))) continue;
      const entry = JSON.parse(line);
      if (entry.type === "session") sessionId = entry.id;
      if (entry.type === "compaction") {
        count++;
        if (wantedId === undefined || entry.id === wantedId) { compact = entry; matches++; }
        if (onCompact) {
          const time = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp);
          if (!Number.isFinite(time)) throw new Error(`invalid-compact-time:${entry.id}`);
          if (time >= since && time <= until) onCompact(entry, sessionId);
        }
      }
    }
  } finally { lines.close(); input.destroy(); }
  if (wantedId !== undefined && matches !== 1) throw new Error(`compact-id-matches=${matches}: ${wantedId}`);
  return { sessionId, compact, count };
}

export async function collectCompactions({ sessionsDir = defaultSessionsDir(), concurrency = 4, since = -Infinity, until = Infinity } = {}) {
  if (!(since <= until) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("invalid-scan-window-or-concurrency");
  sessionsDir = fs.realpathSync(sessionsDir);
  const files = [];
  for (const dir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (dir.isFile() && dir.name.endsWith(".jsonl")) files.push(path.join(sessionsDir, dir.name));
    if (!dir.isDirectory() || !dir.name.startsWith("--")) continue;
    for (const f of fs.readdirSync(path.join(sessionsDir, dir.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".jsonl")) files.push(path.join(sessionsDir, dir.name, f.name));
    }
  }
  const records = [], failed = [];
  let cursor = 0, done = 0, compactions = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++], selected = [];
      try {
        const { count } = await readCompaction(file, undefined, { since, until, onCompact: (entry, sessionId) => selected.push(makeRecord(entry, sessionId, path.resolve(file))) });
        compactions += count;
        records.push(...selected);
      } catch (e) { failed.push({ file, reason: String(e.message || e) }); }
      done++;
      if (done % 50 === 0 || done === files.length) console.log(JSON.stringify({ phase: "scan", done, total: files.length, selectedCompacts: records.length, failed: failed.length }));
    }
  }));
  return { machine: os.hostname(), files: files.length, compactions, indexed: records.length, fallback: records.filter(r => r.fallback).length, failed, records };
}

export async function backfill(options) {
  const scan = await collectCompactions(options);
  if (scan.failed.length) throw new Error(`incomplete-source-scan; index unchanged: ${JSON.stringify(scan.failed)}`);
  const { records, ...stats } = scan;
  const result = await createIndexWriter({ indexPath: options.indexPath }).update(records);
  return { ...result, ...stats };
}

export async function exportIndexBundle(options) {
  const scan = await collectCompactions(options);
  if (scan.failed.length) throw new Error(`incomplete-source-scan; sync cancelled: ${JSON.stringify(scan.failed)}`);
  const { records: recent, ...stats } = scan;
  return { ...stats, recent, existing: indexSnapshot(options.indexPath).records };
}

// stdin carries code / Goal records over the authorized SSH connection, never shell arguments.
// No credentials or original session files are copied. Connection stays open until I/O finishes.
async function peerCall(peer, action, payload) {
  const toolUrl = pathToFileURL(path.join(peer.repo, "tools/pi-compact-index.mjs")).href;
  const code = `process.env.PI_PORTABLE_HOME=${JSON.stringify(peer.repo)};process.env.PI_CODING_AGENT_DIR=${JSON.stringify(peer.agent)};
console.log=(...args)=>process.stderr.write(args.join(' ')+'\\n');
(async()=>{const t=await import(${JSON.stringify(toolUrl)});const p=${JSON.stringify(payload)};let result;
if(${JSON.stringify(action)}==='export')result=await t.exportIndexBundle({...p,sessionsDir:${JSON.stringify(path.join(peer.agent, "sessions"))}});
else {await t.importIndexRecords(p.records);result=t.indexSnapshot();}
process.stdout.write(JSON.stringify(result));})().catch(e=>{console.error(String(e.stack||e));process.exitCode=1;});`;
  const job = execute("ssh", ["-i", "C:/Users/lop/.ssh/id_ed25519", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", `lop@${peer.host}`, `"${peer.node}" -`], { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  job.child.stdin.on("error", e => console.error(`[compact-sync] stdin ${e.message}`));
  job.child.stdin.end(code);
  const output = await job;
  if (output.stderr.trim()) console.error(output.stderr.trim());
  return JSON.parse(output.stdout);
}

export async function importIndexRecords(records, indexPath) {
  return createIndexWriter({ indexPath }).update(records);
}

export async function syncRecent({ days = 7, until = Date.now(), sessionsDir = defaultSessionsDir(), indexPath = defaultIndexPath() } = {}) {
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(until)) throw new Error("invalid-sync-days-or-time");
  const since = until - days * 86400000;
  const peer = SITES[PEER_OF[localSiteName()]];
  console.log(JSON.stringify({ phase: "sync-start", since: new Date(since).toISOString(), until: new Date(until).toISOString(), peer: peer.host }));
  const [local, remote] = await Promise.all([exportIndexBundle({ sessionsDir, indexPath, since, until }), peerCall(peer, "export", { since, until })]);
  // Native recent records take precedence over legacy Markdown framing whitespace.
  let records = parseIndex(mergeIndex("", [...local.existing, ...remote.existing, ...local.recent, ...remote.recent])).records;
  const expected = new Set(records.map(r => r.key));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await importIndexRecords(records, indexPath);
    let here = indexSnapshot(indexPath);
    const there = await peerCall(peer, "import", { records: here.records });
    await importIndexRecords(there.records, indexPath); // Preserve concurrent additions from either side.
    here = indexSnapshot(indexPath);
    for (const key of expected) if (!here.records.some(r => r.key === key) || !there.records.some(r => r.key === key)) throw new Error(`sync-missing-record:${key}`);
    if (here.hash === there.hash) {
      const recent = here.records.filter(r => r.time >= since && r.time <= until);
      return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), indexPath, bytes: here.bytes, sha256: here.hash, identical: true, totalCompacts: here.records.length, recentCompacts: recent.length, priorOlderRetained: here.records.length - recent.length, sources: [local, remote].map(s => ({ machine: s.machine, files: s.files, allCompactsScanned: s.compactions, recentCompacts: s.indexed, fallback: s.fallback, failed: s.failed })), failed: [] };
    }
    console.error(`[compact-sync] RETRY index changed during merge or local notes differ; local=${here.hash} peer=${there.hash}`);
    records = here.records;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("sync-not-converged; preserved both indexes, see per-index logs");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    if (command === "show" && args.length === 2) {
      const { compact } = await readCompaction(path.resolve(args[0]), args[1]); process.stdout.write(compact.summary);
    } else if (command === "backfill" || command === "sync") {
      const days = Number(option("--days") || 7), until = Date.now();
      if (!Number.isFinite(days) || days <= 0) throw new Error("invalid-days");
      const options = { days, until, since: until - days * 86400000, sessionsDir: option("--sessions") || defaultSessionsDir(), indexPath: option("--index") };
      const result = command === "sync" ? await syncRecent(options) : await backfill(options);
      console.log(JSON.stringify({ phase: "complete", ...result }));
    } else throw new Error("usage: backfill --sessions <dir> [--days 7] [--index <md>] | sync --days 7 | show <session.jsonl> <compact-id>");
  } catch (e) { console.error(`[pi-compact-index] FAILED ${e.stack || e}`); process.exitCode = 1; }
}
