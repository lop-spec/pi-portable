// "一键归档超过 N 天的对话": POST /__pi_archive_older on the UI proxy archives every conversation
// (a root plus its subagent children) whose newest activity is older than N days, except running
// ones and the one the page has open, and counts what it skipped.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiWebUiProxy, PIWEB_ARCHIVE_OLDER_PATH, SessionArchiveStore } from "../src/piweb-ui-proxy.mjs";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-archive-older-"));
const sessionRoot = path.join(temp, "sessions");
fs.mkdirSync(path.join(sessionRoot, "project"), { recursive: true });
const sessions = [];
const add = (id, ageDays, extra = {}) => {
  const file = path.join(sessionRoot, "project", `2026-09-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session", id, cwd: temp }) + "\n");
  sessions.push({ id, path: file, cwd: temp, name: id, modified: ageDays === null ? "not a date" : daysAgo(ageDays), ...extra });
};
const child = (parentId) => ({ relation: { kind: "subagent", parentSessionId: parentId, profile: "explore", description: "", status: "completed" } });
add("old-10d", 10);
add("old-8d", 8);
add("recent-3d", 3);
add("old-running", 20);
add("old-open", 30);
add("old-bad-date", null);
add("parent-active-child", 15);
add("child-recent", 2, child("parent-active-child"));
add("parent-all-old", 15);
add("child-old", 14, child("parent-all-old"));
const running = ["old-running"];

let requests = [];
const upstream = http.createServer((req, res) => {
  requests.push(req.url);
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.startsWith("/api/sessions")) res.end(JSON.stringify({ sessions }));
  else if (req.url === "/api/agent/running") res.end(JSON.stringify({ runningSessionIds: running }));
  else res.end("{}");
});
const upstreamPort = await listen(upstream);
const probe = http.createServer();
const publicPort = await listen(probe); await close(probe);
const healthProbe = http.createServer();
const healthPort = await listen(healthProbe); await close(healthProbe);
const logFile = path.join(temp, "proxy.log");
const proxy = new PiWebUiProxy({ dataRoot: temp, sessionRoot, webPort: upstreamPort, publicWebPort: publicPort, healthPort, bridgePort: upstreamPort, logFile, archiveUiSource: "", now: () => NOW });
await proxy.start();
const post = (body, headers = {}) => fetch(`http://127.0.0.1:${publicPort}${PIWEB_ARCHIVE_OLDER_PATH}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const archivedIds = () => new SessionArchiveStore(path.join(temp, "session-archive.json"), { sessionRoot }).partition(sessions).archived.map((session) => session.id).sort();

test.after(async () => {
  await proxy.close().catch(() => {});
  await close(upstream).catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
});

test("bad requests are rejected and archive nothing", async () => {
  assert.equal((await post({ days: 0 })).status, 400);
  assert.equal((await post({ days: 7.5 })).status, 400);
  assert.equal((await post({ days: 100000 })).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ days: 7 }, { origin: "http://evil.example" })).status, 403);
  assert.deepEqual(archivedIds(), []);
});

test("archives the conversations older than 7 days and leaves running, open, recent and undated ones", async () => {
  const response = await post({ days: 7, keep: ["old-open"] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(archivedIds(), ["child-old", "old-10d", "old-8d", "parent-all-old"]);
  assert.equal(result.groupCount, 3, "old-10d, old-8d and the parent-all-old family");
  assert.equal(result.sessionCount, 4, "the family archives its subagent child with it");
  assert.deepEqual({ running: result.skippedRunning, kept: result.skippedKept, unknownAge: result.skippedUnknownAge, failed: result.failed }, { running: 1, kept: 1, unknownAge: 1, failed: 0 });
  // The family with a recently active child stays whole.
  assert.ok(!archivedIds().includes("parent-active-child") && !archivedIds().includes("child-recent"));
  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, /"event":"session-archive-older"/u, "every run is logged with its skip counts");
});

test("a second run has nothing left to archive, and a longer window archives less", async () => {
  const again = await (await post({ days: 7, keep: ["old-open"] })).json();
  assert.deepEqual({ groups: again.groupCount, sessions: again.sessionCount }, { groups: 0, sessions: 0 });
  assert.equal(archivedIds().length, 4);
  const longer = await (await post({ days: 25 })).json();
  assert.equal(longer.groupCount, 1, "only old-open (30 days) is older than 25 days once it is no longer kept");
  assert.ok(archivedIds().includes("old-open"));
});

test("a session that cannot be archived is reported and does not stop the rest", async () => {
  add("old-broken", 40);
  fs.writeFileSync(sessions.at(-1).path, JSON.stringify({ type: "session", id: "someone-else", cwd: temp }) + "\n");
  add("old-fine", 40);
  const result = await (await post({ days: 7 })).json();
  assert.equal(result.failed, 1);
  assert.equal(result.groupCount, 1);
  assert.equal(result.failures[0].sessionId, "old-broken");
  assert.ok(archivedIds().includes("old-fine") && !archivedIds().includes("old-broken"));
  assert.match(fs.readFileSync(logFile, "utf8"), /"event":"session-archive-older-item-failed"/u);
});
