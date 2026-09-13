// Hard gates: verbatim unlimited Goal; one record/machine/session/compact; exact 7-day coverage; backups;
// cross-process writes; failed I/O cannot affect Pi; only session_compact is subscribed.
// No model requests, provider credentials, session rewrites or live-process restarts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultIndexPath, extractGoal, makeRecord, mergeIndex, parseIndex, renderRecord, createIndexWriter, registerCompactExport } from "../src/extensions/lop-compact.ts";
import { readCompaction, backfill, collectCompactions, indexSnapshot, validateReview, applyReview, importIndexRecords } from "../tools/pi-compact-index.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupTool = path.join(root, "tools/backup.mjs");
const record = (sessionId, id = "c1", time = 1000, summary = `## Goal\n${sessionId} 的完整目标。\n\n## Progress\n后续信息。\n`) => makeRecord({ id, timestamp: time, summary }, sessionId, path.join(os.tmpdir(), `${sessionId}.jsonl`), "test-host");
if (process.argv[2] === "--worker") {
  await createIndexWriter({ indexPath: process.argv[3], backupTool }).update([record(process.argv[4])]);
  process.exit(0);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compact-contract-"));
const passed = [];
async function check(name, fn) { await fn(); passed.push(name); }

await check("index-path-from-rules-not-portable-home", () => {
  const names = ["PI_COMPACT_INDEX_FILE", "PI_CODING_AGENT_DIR", "USERPROFILE", "HOME"];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const agent = path.join(temp, "agent-rules"); fs.mkdirSync(agent);
  const target = path.join(temp, "actual-memory/pi-compact.md");
  fs.writeFileSync(path.join(agent, "AGENTS.md"), `默认读取一次 \`${target}\`。`);
  try {
    delete process.env.PI_COMPACT_INDEX_FILE;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.USERPROFILE = path.join(temp, "wrong-portable-data");
    process.env.HOME = process.env.USERPROFILE;
    assert.equal(defaultIndexPath(), target);
  } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } }
});
await check("unlimited-exact-goal", () => {
  const body = "\n- 原文路径 `C:/完整 路径/a.ts`，不得改写。\r\n" + "超长目标原封不动😀。".repeat(900) + "\n\n";
  const result = extractGoal(`## Goal\n${body}## Progress\nNot part of goal`);
  assert.equal(result.text, body);
  assert.ok(result.text.length > 9000);
  assert.equal(result.fallback, "");
});
await check("fenced-headings-and-subsections", () => {
  const body = "\n中文。\r\n```md\r\n## Progress\r\n伪标题也属于原文\r\n```\r\n### 子目标\r\n保留。\r\n\r\n";
  assert.equal(extractGoal(`## **Goal**\r\n${body}## Key Decisions\r\nstop`).text, body);
  assert.equal(extractGoal("## 目标\n甲\n## 进展\n乙").text, "甲\n");
});
await check("explicit-missing-goal-fallback", () => {
  const result = extractGoal("No prior history.\n\n## Original Request\n当前请求全部原文。\n\n## Early Progress\n执行中。");
  assert.equal(result.text, "当前请求全部原文。\n\n");
  assert.match(result.fallback, /using-original-request/);
  const missing = extractGoal("其他格式，不能伪造Goal。");
  assert.equal(missing.text, "");
  assert.match(missing.fallback, /source-reference-only/);
  assert.throws(() => extractGoal(""), /empty/);
});
await check("every-compact-per-session-preserve-others-and-notes", () => {
  const a = record("A"), b = record("B");
  const original = mergeIndex("用户既有说明，不得丢失。\n\n", [a, b]) + "用户尾注。\n";
  const next = mergeIndex(original, [record("A", "c2", 2000, "## Goal\n新目标全文\n## Progress\n其他")]);
  assert.equal((next.match(/^## test-host \/ A$/gm) || []).length, 2);
  assert.ok(next.includes(a.text), "earlier Goal must not be overwritten by the latest compact");
  assert.equal((next.match(/^## test-host \/ B$/gm) || []).length, 1);
  assert.ok(next.startsWith("用户既有说明"));
  assert.ok(next.endsWith("用户尾注。\n"));
  assert.ok(next.includes(b.text));
  assert.equal(mergeIndex(next, [a]), next, "older completion cannot roll back latest");
  assert.equal(mergeIndex(next, [record("A", "c2", 2000, "## Goal\n新目标全文\n## Progress\n其他")]), next);
});
await check("v1-migration-unlimited-goal-and-machine-dedup", () => {
  const a = record("legacy", "original", 1000, "## Goal\n原文不带末尾换行");
  const oldKey = crypto.createHash("sha256").update("test-host\0legacy").digest("hex");
  const v1 = renderRecord(a).replaceAll(a.key, oldKey).replace(` ${a.text.length} -->`, " -->");
  const next = mergeIndex(v1, [a, record("legacy", "second", 2000)]);
  assert.equal(parseIndex(next).records.length, 2);
  assert.equal(parseIndex(next).records.find(r => r.compactId === "original").text, a.text);
  const other = makeRecord({ id: a.compactId, timestamp: a.time, summary: "## Goal\n另一台机器" }, a.sessionId, a.sessionFile, "other-host");
  assert.equal(parseIndex(mergeIndex(next, [other])).records.length, 3);
  assert.throws(() => mergeIndex(next, [{ ...a, text: "同一个 Compact ID 却有冲突原文" }]), /conflicting-compact-record/);
  const b = record("B");
  assert.equal(mergeIndex(mergeIndex("", [a]), [b]), mergeIndex(mergeIndex("", [b]), [a]), "union order must not affect canonical bytes");
});
await check("backup-readback-idempotence-and-failure", async () => {
  const file = path.join(temp, "io/pi-compact.md");
  fs.mkdirSync(path.join(path.dirname(file), "_历史版本"), { recursive: true });
  const logs = [];
  const writer = createIndexWriter({ indexPath: file, backupTool, log: line => logs.push(line) });
  await writer.update([record("A")]);
  const before = fs.readFileSync(file);
  await writer.update([record("A", "c2", 2000)]);
  const history = path.join(path.dirname(file), "_历史版本");
  assert.ok(fs.readdirSync(history).some(f => fs.readFileSync(path.join(history, f)).equals(before)));
  const stamp = fs.statSync(file).mtimeMs;
  assert.equal((await writer.update([record("A", "c2", 2000)])).status, "unchanged");
  assert.equal(fs.statSync(file).mtimeMs, stamp);
  const good = fs.readFileSync(file);
  const bad = createIndexWriter({ indexPath: file, backupTool: path.join(temp, "missing-backup.mjs") });
  await assert.rejects(bad.update([record("B")]), /Command failed/);
  assert.ok(fs.readFileSync(file).equals(good), "failed backup leaves old index byte-identical");
  assert.ok(!fs.existsSync(`${file}.lock`));
  await writer.update([record("C", "c3", 3000, "Unknown summary format")]);
  assert.ok(logs.some(l => /FALLBACK.*source-reference-only/.test(l)));
});
await check("cross-process-concurrent-writes", async () => {
  const file = path.join(temp, "parallel/pi-compact.md");
  await Promise.all(Array.from({ length: 6 }, (_, i) => execute(process.execPath, [fileURLToPath(import.meta.url), "--worker", file, `worker-${i}`], { windowsHide: true, timeout: 20000 })));
  const contents = fs.readFileSync(file, "utf8");
  assert.equal((contents.match(/^<!-- pi-compact /gm) || []).length, 6);
  for (let i = 0; i < 6; i++) assert.ok(contents.includes(`worker-${i} 的完整目标。`));
});
await check("live-lock-times-out-without-overwrite", async () => {
  const file = path.join(temp, "locked.md");
  fs.writeFileSync(file, "保留原始资产");
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, nonce: "other-writer" }));
  await assert.rejects(createIndexWriter({ indexPath: file, backupTool, lockTimeoutMs: 50 }).update([record("locked")]), /lock-timeout/);
  assert.equal(fs.readFileSync(file, "utf8"), "保留原始资产");
});
await check("only-success-hook-nonblocking-no-input-mutation", async () => {
  const calls = [], logs = [];
  let handler, resolve;
  const delayed = new Promise(r => { resolve = r; });
  const writer = { update: async records => { calls.push(records); await delayed; throw new Error("expected-disk-failure"); }, log: l => logs.push(l) };
  const api = new Proxy({}, { get: (_, prop) => {
    assert.equal(prop, "on", "extension must not access any other Pi API");
    return (event, fn) => { assert.equal(event, "session_compact"); assert.equal(handler, undefined); handler = fn; };
  } });
  registerCompactExport(api, writer);
  const summary = "## Goal\n原文\n## Progress\n末尾";
  const old = Object.freeze({ type: "compaction", id: "old", timestamp: 1, summary });
  const latest = Object.freeze({ type: "compaction", id: "new", timestamp: 2, summary });
  const event = Object.freeze({ type: "session_compact", compactionEntry: old, reason: "threshold", willRetry: false });
  const ctx = Object.freeze({ sessionManager: Object.freeze({ getBranch: () => [old, latest], getSessionId: () => "native", getSessionFile: () => path.join(temp, "native.jsonl") }) });
  const start = performance.now();
  assert.equal(handler(event, ctx), undefined, "must not return a Promise to Pi");
  assert.ok(performance.now() - start < 100, "does not wait for file write completion");
  assert.equal(calls[0][0].compactId, "new", "correct Pi event's old-ID equality lookup");
  resolve(); await new Promise(r => setImmediate(r));
  assert.ok(logs.some(l => /EXPORT_FAILED.*expected-disk-failure/.test(l)));
  assert.equal(event.compactionEntry, old);
  const source = fs.readFileSync(path.join(root, "src/extensions/lop-compact.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.(?:sendMessage|sendUserMessage|registerTool|registerCommand|setActiveTools|exec)|pi\.on\("(?:context|before_agent_start|before_provider_request|tool_call|session_before_compact|agent_end|input)"/);
});
await check("jsonl-exact-source-backfill-every-compact", async () => {
  const dir = path.join(temp, "sessions/--real-cwd--"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "one.jsonl");
  const entries = [{ type: "session", id: "source-1" }, { type: "compaction", id: "c1", timestamp: 1, summary: "## Goal\nfirst\n## Progress\nold" }, { type: "compaction", id: "c2", timestamp: 2, summary: "## Goal\n完整最新目标。\n## Progress\n最后" }];
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  const before = fs.readFileSync(file);
  assert.equal((await readCompaction(file, "c1")).compact.summary, entries[1].summary);
  await assert.rejects(readCompaction(file, "missing"), /matches=0/);
  const index = path.join(temp, "backfill.md");
  const result = await backfill({ sessionsDir: path.dirname(dir), indexPath: index });
  assert.equal(result.indexed, 2); assert.equal(result.compactions, 2); assert.deepEqual(result.failed, []);
  assert.equal(indexSnapshot(index).records.length, 2);
  assert.match(fs.readFileSync(index, "utf8"), /Compact ID：c2/);
  assert.ok(fs.readFileSync(file).equals(before), "original session file remains read-only");
});

await check("seven-day-inclusive-boundaries-all-compacts-and-two-way-union", async () => {
  const dir = path.join(temp, "seven-day/--session--"); fs.mkdirSync(dir, { recursive: true });
  const until = Date.parse("2026-09-13T12:00:00Z"), since = until - 7 * 86400000;
  const times = [since - 1, since, since + 1, until, until + 1];
  const source = path.join(dir, "window.jsonl");
  fs.writeFileSync(source, [{ type: "session", id: "window-session" }, ...times.map((t, i) => ({ type: "compaction", id: `window-${i}`, timestamp: new Date(t).toISOString(), summary: `## Goal\n逐字原文 ${i}\n\n## Progress\n后续` }))].map(e => JSON.stringify(e)).join("\n") + "\n");
  const before = fs.readFileSync(source);
  const scan = await collectCompactions({ sessionsDir: path.dirname(dir), since, until });
  assert.deepEqual(scan.failed, []); assert.equal(scan.compactions, 5); assert.equal(scan.indexed, 3);
  assert.deepEqual(scan.records.map(r => r.compactId), ["window-1", "window-2", "window-3"]);
  for (const r of scan.records) assert.equal(r.text, extractGoal((await readCompaction(source, r.compactId)).compact.summary).text);
  assert.ok(fs.readFileSync(source).equals(before));
  const one = path.join(temp, "union-one.md"), two = path.join(temp, "union-two.md");
  const a = createIndexWriter({ indexPath: one, backupTool }), b = createIndexWriter({ indexPath: two, backupTool });
  const older = record("retained-older", "c1", since - 86400000);
  await a.update([older, ...scan.records.slice(0, 2)]); await b.update(scan.records.slice(2));
  await a.update(indexSnapshot(two).records); await b.update(indexSnapshot(one).records);
  assert.equal(indexSnapshot(one).hash, indexSnapshot(two).hash);
  assert.equal(indexSnapshot(one).records.length, 4, "old records retained, all three recent checkpoints present");
  const hash = indexSnapshot(one).hash;
  await a.update(scan.records); await b.update(scan.records);
  assert.equal(indexSnapshot(one).hash, hash); assert.equal(indexSnapshot(two).hash, hash);
});

await check("semantic-review-complete-classification-and-50-ceiling", () => {
  const candidates = Array.from({ length: 51 }, (_, i) => record(`candidate-${i}`));
  const review = { keep: candidates.slice(0, 50).map(r => r.key), remove: [{ key: candidates[50].key, reason: "superseded by an independently retained topic" }] };
  assert.equal(validateReview(review, candidates).length, 1);
  assert.throws(() => validateReview({ keep: candidates.map(r => r.key), remove: [] }, candidates), /over-50/);
  assert.throws(() => validateReview({ keep: [], remove: [] }, candidates), /incomplete/);
  assert.throws(() => validateReview({ ...review, keep: [...review.keep, review.keep[0]] }, candidates), /duplicate/);
  assert.throws(() => validateReview({ keep: ['a'.repeat(64)], remove: [] }, candidates), /unknown/);
  assert.throws(() => validateReview({ ...review, remove: [{ key: candidates[50].key, reason: '' }] }, candidates), /invalid-pruned/);
});
await check("reviewed-exclusions-win-two-way-union-backfill-and-concurrent-additions", async () => {
  const one = path.join(temp, 'pruned-one.md'), two = path.join(temp, 'pruned-two.md');
  const old = record('low-value'), good = record('useful'), concurrent = record('unreviewed-concurrent');
  await importIndexRecords([old, good], one); await importIndexRecords([old, good], two);
  const candidates = indexSnapshot(one).records;
  await importIndexRecords([concurrent], one);
  const review = { keep: [good.key], remove: [{ key: old.key, reason: 'duplicate progress already covered' }] };
  await applyReview(review, candidates, one);
  assert.deepEqual(new Set(indexSnapshot(one).records.map(r => r.key)), new Set([good.key, concurrent.key]));
  let a = indexSnapshot(one); await importIndexRecords(a.records, two, a.pruned);
  let b = indexSnapshot(two); await importIndexRecords(b.records, one, b.pruned);
  await importIndexRecords([old, good], one); // stale event or recent native backfill
  a = indexSnapshot(one); b = indexSnapshot(two);
  assert.equal(a.hash, b.hash); assert.equal(a.stateHash, b.stateHash);
  assert.equal(a.records.find(r => r.key === good.key).text, good.text);
  assert.ok(!a.records.some(r => r.key === old.key));
  const hash = a.hash; await applyReview(review, candidates, one); assert.equal(indexSnapshot(one).hash, hash);
  // Failure before any write must preserve both files.
  const beforeIndex = fs.readFileSync(one), beforePruned = fs.readFileSync(one+'.pruned.json');
  await assert.rejects(createIndexWriter({ indexPath: one, backupTool: path.join(temp, 'missing-backup.mjs') }).update([], [{ key: good.key, reason: 'test' }]), /Command failed/);
  assert.ok(fs.readFileSync(one).equals(beforeIndex)); assert.ok(fs.readFileSync(one+'.pruned.json').equals(beforePruned));
  fs.writeFileSync(one+'.pruned.json', '{invalid');
  await assert.rejects(createIndexWriter({ indexPath: one, backupTool }).update([old]));
  assert.ok(fs.readFileSync(one).equals(beforeIndex));
});

// Optional installed-SDK mode is explicit; no network, provider calls or fake production sessions.
if (process.env.PI_TEST_SDK) await check("real-pi-loader-and-extension-runner", async () => {
  const sdk = process.env.PI_TEST_SDK;
  const imp = rel => import(pathToFileURL(path.join(sdk, rel)).href);
  const { loadExtensions } = await imp("dist/core/extensions/loader.js");
  const { ExtensionRunner } = await imp("dist/core/extensions/runner.js");
  const { SessionManager } = await imp("dist/core/session-manager.js");
  const index = path.join(temp, "sdk/pi-compact.md");
  const previous = process.env.PI_COMPACT_INDEX_FILE;
  process.env.PI_COMPACT_INDEX_FILE = index;
  try {
    const extensionFile = process.env.PI_COMPACT_EXTENSION || path.join(root, "src/extensions/lop-compact.ts");
    const loaded = await loadExtensions([extensionFile], temp);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.deepEqual([...extension.handlers.keys()], ["session_compact"]);
    assert.equal(extension.tools.size, 0); assert.equal(extension.commands.size, 0);
    const sm = SessionManager.create(temp, path.join(temp, "sdk-sessions"));
    sm.appendMessage({ role: "user", content: "offline native record", timestamp: Date.now() });
    sm.appendCompaction("## Goal\nSDK事件完整原文。\n\n## Progress\n完成", sm.getLeafId(), 1000);
    const entry = sm.getBranch().findLast(e => e.type === "compaction");
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, temp, sm, {});
    const before = JSON.stringify(sm.getEntries());
    for (const reason of ["manual", "threshold", "overflow"]) await runner.emit({ type: "session_compact", compactionEntry: entry, fromExtension: false, reason, willRetry: reason === "overflow" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (!fs.existsSync(index) || fs.existsSync(`${index}.lock`))) await new Promise(r => setTimeout(r, 25));
    assert.ok(fs.readFileSync(index, "utf8").includes("SDK事件完整原文。"));
    assert.equal((fs.readFileSync(index, "utf8").match(/^<!-- pi-compact /gm) || []).length, 1);
    assert.equal(JSON.stringify(sm.getEntries()), before, "success hook cannot add any session message or alter checkpoint");
  } finally { if (previous === undefined) delete process.env.PI_COMPACT_INDEX_FILE; else process.env.PI_COMPACT_INDEX_FILE = previous; }
});
console.log(JSON.stringify({ ok: true, gates: passed.length, passed, temp, modelCalls: 0, nativeChainMutations: 0 }));
