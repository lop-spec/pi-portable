import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { listSessionsIncremental, resetSessionScanIndexForTests, flushSessionScanIndexPersist, traceSessionScanReadsForTests } = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a });
  const c = write("c");
  const trace = traceSessionScanReadsForTests();
  t.after(() => trace.stop());
  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    trace.reads.length = 0;
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    assert.deepEqual(trace.reads.map(([path]) => path).sort(), [...expectedReads].sort(), `${label}: scanned files`);
  }

  await check("cold", [a, b, c]);
  await check("warm", []);
  await flushSessionScanIndexPersist();
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  await flushSessionScanIndexPersist();
  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  await flushSessionScanIndexPersist();
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  await flushSessionScanIndexPersist();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("defers changed-file details to a later scan", async (t) => {
  const { write } = fixture(t);
  const sessionPath = write("deferred", [
    message("d1", "user", "deferred request"),
    message("d2", "assistant", "deferred answer"),
  ]);

  // A summary listing reads only the header and stat, so the transcript-derived
  // fields stay empty and the row is marked as pending.
  const summary = await listSessionsIncremental({ deferDetails: true });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].path, sessionPath);
  assert.equal(summary[0].detailsPending, true);
  assert.equal(summary[0].messageCount, 0);
  assert.equal(summary[0].firstMessage, "");
  assert.equal(summary[0].id, "deferred");
  assert.equal(summary[0].cwd, process.env.PI_CODING_AGENT_DIR);

  // The normal listing still hydrates the exact details.
  const detailed = await listSessionsIncremental();
  assert.equal(detailed[0].detailsPending, undefined);
  assert.equal(detailed[0].messageCount, 2);
  assert.equal(detailed[0].firstMessage, "deferred request");
});

test("a summary listing does not downgrade an already-scanned file", async (t) => {
  const { write } = fixture(t);
  write("cached", [message("c1", "user", "cached request")]);

  const detailed = await listSessionsIncremental();
  assert.equal(detailed[0].messageCount, 1);

  // The cached entry is complete, so the summary listing serves it as-is. The
  // scan index is persisted across restarts, so this is the common path: a
  // first paint should not blank details it is already holding.
  const summary = await listSessionsIncremental({ deferDetails: true });
  assert.equal(summary[0].detailsPending, undefined);
  assert.equal(summary[0].messageCount, 1);
  assert.equal(summary[0].firstMessage, "cached request");
  assert.equal((await listSessionsIncremental())[0].messageCount, 1);
});

test("a summary listing defers only the files the index has not scanned", async (t) => {
  const { write } = fixture(t);
  write("cached", [message("c1", "user", "cached request")]);
  assert.equal((await listSessionsIncremental())[0].messageCount, 1);

  // A file the index has never seen has no details to reuse, so it is the one
  // row that comes back pending — the point of the summary mode.
  write("fresh", [message("f1", "user", "fresh request")]);
  const summary = await listSessionsIncremental({ deferDetails: true });
  const byId = Object.fromEntries(summary.map((row) => [row.id, row]));
  assert.equal(byId.cached.detailsPending, undefined);
  assert.equal(byId.cached.messageCount, 1);
  assert.equal(byId.fresh.detailsPending, true);
  assert.equal(byId.fresh.messageCount, 0);
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

// --- Resumable scans (byte offset + header/anchor hashes) -------------------

// [path, start offset] of each transcript read by the scanner.
function trackReads(t) {
  const trace = traceSessionScanReadsForTests();
  t.after(() => trace.stop());
  return trace.reads;
}

test("an appended session resumes from the last complete line", async (t) => {
  const { write } = fixture(t);
  const a = write("a", [message("a1", "user", "first request"), message("a2", "assistant", "answer")]);
  await listSessionsIncremental();
  const reads = trackReads(t);
  const before = fs.statSync(a).size;
  fs.appendFileSync(a, line({ type: "session_info", name: "Renamed" }));
  fs.appendFileSync(a, line(message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-05T00:00:00.000Z")));
  fs.appendFileSync(a, line(message("a4", "user", "later", "2026-01-04T00:00:00.000Z")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  assert.deepEqual(reads, [[a, before]]);
});

test("a rewritten header line forces a full rescan (in place or grown)", async (t) => {
  const { root, write } = fixture(t);
  const a = write("a", [message("a1", "user", "request")], { cwd: join(root, "a-long-original-working-directory") });
  await listSessionsIncremental();
  const reads = trackReads(t);
  const [header, ...rest] = fs.readFileSync(a, "utf8").split("\n");
  // Same length, padded with spaces — what relocateSessionHeaders does in place.
  const shorter = JSON.stringify({ ...JSON.parse(header), cwd: join(root, "moved") });
  fs.writeFileSync(a, [shorter.padEnd(header.length, " "), ...rest].join("\n"));
  fs.appendFileSync(a, line(message("a2", "assistant", "after move")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  assert.equal((await listSessionsIncremental())[0].cwd, join(root, "moved"));
  assert.deepEqual(reads, [[a, 0]]);

  // Longer header (the temp-file path): the size grows, the offset is stale.
  reads.length = 0;
  const [header2, ...rest2] = fs.readFileSync(a, "utf8").split("\n");
  const longer = JSON.stringify({ ...JSON.parse(header2), cwd: join(root, "moved-to-a-much-longer-directory-name") }) + " ".repeat(512);
  fs.writeFileSync(a, [longer, ...rest2].join("\n"));
  fs.appendFileSync(a, line(message("a3", "user", "after second move")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  assert.deepEqual(reads, [[a, 0]]);
});

test("changed bytes just before the resume point force a full rescan", async (t) => {
  const { write } = fixture(t);
  const a = write("a", [message("a1", "user", "request"), message("a2", "assistant", "aaaa")]);
  await listSessionsIncremental();
  const reads = trackReads(t);
  fs.writeFileSync(a, fs.readFileSync(a, "utf8").replace('"aaaa"', '"bbbb"'));
  fs.appendFileSync(a, line(message("a3", "user", "more")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  assert.deepEqual(reads, [[a, 0]]);
});

test("a torn trailing write is ignored until it completes, then counted once", async (t) => {
  const { write } = fixture(t);
  const a = write("a", [message("a1", "user", "request")]);
  const full = line(message("a2", "assistant", "streamed answer", "2026-01-02T00:00:00.000Z"));
  fs.appendFileSync(a, full.slice(0, 20));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  fs.appendFileSync(a, full.slice(20));
  const rows = await listSessionsIncremental();
  assert.deepEqual(rows, await sdkMetadata());
  assert.equal(rows[0].messageCount, 2);
});

test("legacy index entries without scan state rescan fully once, then resume", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "request")]);
  await listSessionsIncremental();
  await flushSessionScanIndexPersist();
  const legacy = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  for (const entry of Object.values(legacy.entries)) delete entry.scan;
  fs.writeFileSync(indexPath, JSON.stringify(legacy));
  resetSessionScanIndexForTests();
  const reads = trackReads(t);
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata(), "unchanged legacy entries are served as-is");
  assert.deepEqual(reads, []);
  fs.appendFileSync(a, line(message("a2", "assistant", "answer")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  const size = fs.statSync(a).size;
  fs.appendFileSync(a, line(message("a3", "user", "again")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
  assert.deepEqual(reads, [[a, 0], [a, size]]);
});

test("first messages are capped at 320 characters, including legacy index entries", async (t) => {
  const { write, indexPath } = fixture(t);
  const long = "长".repeat(400);
  const a = write("a", [message("a1", "user", long)]);
  const [row] = await listSessionsIncremental();
  assert.equal(row.firstMessage, long.slice(0, 320));
  await flushSessionScanIndexPersist();
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(persisted.entries[a].info.firstMessage, long.slice(0, 320));
  persisted.entries[a].info.firstMessage = long;
  fs.writeFileSync(indexPath, JSON.stringify(persisted));
  resetSessionScanIndexForTests();
  assert.equal((await listSessionsIncremental())[0].firstMessage, long.slice(0, 320));
});

test("index persistence is debounced and asynchronous", async (t) => {
  const { write, indexPath } = fixture(t);
  write("a", [message("a1", "user", "request")]);
  await listSessionsIncremental();
  assert.equal(fs.existsSync(indexPath), false, "no synchronous write on the listing path");
  await flushSessionScanIndexPersist();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(indexPath, "utf8")).entries).length, 1);
});

test("lines with U+2028/U+2029 are split like the SDK's readline listing", async (t) => {
  const { write } = fixture(t);
  write("a", [
    message("a1", "user", "first\u2028request"),
    message("a2", "toolResult", [{ type: "text", text: "out\u2029put" }]),
    message("a3", "user", "plain request"),
    message("a4", "assistant", "done"),
  ]);
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});
