// Explicit administration / source lookup only. Never called from a model, prompt or turn hook.
// node tools/pi-compact-index.mjs backfill --sessions <dir> [--index <md>]
// node tools/pi-compact-index.mjs show <session.jsonl> <compact-id>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createIndexWriter, makeRecord } from "../src/extensions/lop-compact.ts";

export async function readCompaction(file, wantedId) {
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
      }
    }
  } finally { lines.close(); input.destroy(); }
  if (wantedId !== undefined && matches !== 1) throw new Error(`compact-id-matches=${matches}: ${wantedId}`);
  return { sessionId, compact, count };
}

export async function backfill({ sessionsDir, indexPath, concurrency = 4 }) {
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
      const file = files[cursor++];
      try {
        const { sessionId, compact, count } = await readCompaction(file);
        compactions += count;
        if (compact) records.push(makeRecord(compact, sessionId, path.resolve(file)));
      } catch (e) { failed.push({ file, reason: String(e.message || e) }); }
      done++;
      if (done % 50 === 0 || done === files.length) console.log(JSON.stringify({ phase: "scan", done, total: files.length, compactSessions: records.length, failed: failed.length }));
    }
  }));
  // One merge / backup, not one full-file rewrite for each historical session.
  records.sort((a, b) => b.time - a.time);
  const writer = createIndexWriter({ indexPath });
  const result = await writer.update(records);
  return { ...result, machine: os.hostname(), files: files.length, compactions, indexed: records.length, fallback: records.filter(r => r.fallback).length, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "show" && args.length === 2) {
      const { compact } = await readCompaction(path.resolve(args[0]), args[1]);
      process.stdout.write(compact.summary);
    } else if (command === "backfill") {
      const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
      const sessionsDir = option("--sessions") || path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || os.homedir(), ".pi", "agent"), "sessions");
      const result = await backfill({ sessionsDir: path.resolve(sessionsDir), indexPath: option("--index") });
      console.log(JSON.stringify({ phase: "complete", ...result }));
      if (result.failed.length) process.exitCode = 1;
    } else throw new Error("usage: backfill --sessions <dir> [--index <md>] | show <session.jsonl> <compact-id>");
  } catch (e) { console.error(`[pi-compact-index] FAILED ${e.stack || e}`); process.exitCode = 1; }
}
