#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PIWEB_ARCHIVE_UI_PATH,
  PIWEB_ARCHIVE_VERSION,
  RunSupervisor,
  SessionArchiveStore,
} from "../src/run-supervisor.mjs";
import { resolveHistory, scanHistory } from "../src/chain/lop-memory.mjs";

const SESSION_ID = "11111111-1111-7111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-7222-8222-222222222222";
const CHILD_SESSION_ID = "44444444-4444-7444-8444-444444444444";
const fixedNow = () => Date.parse("2026-09-01T11:00:00.000Z");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function writeSession(file, id = SESSION_ID, marker = "ARCHIVE-A9Z7") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { type: "session", version: 3, id, timestamp: "2026-09-01T10:00:00.000Z", cwd: "C:/work" },
    { type: "message", id: `user-${id[0]}`, parentId: null, timestamp: "2026-09-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "归档识别校验：海棠项目最终使用哪个方案？" }] } },
    { type: "message", id: `answer-${id[0]}`, parentId: `user-${id[0]}`, timestamp: "2026-09-01T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: `海棠项目最终使用蓝色方案，版本标记 ${marker}。` }], stopReason: "stop" } },
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-archive-test-"));
  const sessionRoot = path.join(root, ".pi", "agent", "sessions");
  const project = path.join(sessionRoot, "--C--work--");
  const first = path.join(project, `2026-09-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  const second = path.join(project, `2026-09-01T10-01-00-000Z_${SECOND_SESSION_ID}.jsonl`);
  const child = path.join(project, `2026-09-01T10-02-00-000Z_${CHILD_SESSION_ID}.jsonl`);
  writeSession(first, SESSION_ID, "ARCHIVE-A9Z7");
  writeSession(second, SECOND_SESSION_ID, "ARCHIVE-B8Y6");
  writeSession(child, CHILD_SESSION_ID, "ARCHIVE-CHILD-C7X5");
  const archiveFile = path.join(root, ".pi", "agent", "session-archive.json");
  return { root, sessionRoot, first, second, child, archiveFile };
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function expectJsonStatus(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test("sidecar archive and restore are reversible and never alter the native Pi JSONL", (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const before = fs.readFileSync(fx.first);
  const beforeStat = fs.statSync(fx.first);
  const store = new SessionArchiveStore(fx.archiveFile, { sessionRoot: fx.sessionRoot, now: fixedNow });

  const archived = store.archive({ id: SESSION_ID, path: fx.first, cwd: "C:/work", name: "海棠项目" });
  assert.equal(archived.created, true);
  assert.equal(archived.record.id, SESSION_ID);
  assert.equal(archived.record.archivedAt, "2026-09-01T11:00:00.000Z");
  assert.equal(path.isAbsolute(archived.record.relativePath), false);
  assert.equal(store.isArchived(SESSION_ID, fx.first), true);
  assert.equal(store.archive({ id: SESSION_ID, path: fx.first }).created, false, "archive is idempotent");

  const after = fs.readFileSync(fx.first);
  const afterStat = fs.statSync(fx.first);
  assert.equal(sha256(after), sha256(before));
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(JSON.parse(after.toString("utf8").split("\n")[0]), JSON.parse(before.toString("utf8").split("\n")[0]));
  assert.equal(fs.readdirSync(path.dirname(fx.archiveFile)).filter((name) => name.includes(".tmp-")).length, 0);

  const outside = path.join(fx.root, "outside.jsonl");
  writeSession(outside, "33333333-3333-7333-8333-333333333333", "OUTSIDE");
  assert.throws(
    () => store.archive({ id: "33333333-3333-7333-8333-333333333333", path: outside }),
    /outside the configured Pi sessions root/u,
  );

  const restored = store.restore(SESSION_ID);
  assert.equal(restored.restored, true);
  assert.equal(store.isArchived(SESSION_ID, fx.first), false);
  assert.equal(store.restore(SESSION_ID).restored, false, "restore is idempotent");
  assert.equal(sha256(fs.readFileSync(fx.first)), sha256(before));

  fs.writeFileSync(fx.archiveFile, "{broken", "utf8");
  assert.throws(() => store.archive({ id: SESSION_ID, path: fx.first }), /archive index is unreadable/u);
  assert.equal(fs.readFileSync(fx.archiveFile, "utf8"), "{broken", "corrupt user metadata is not overwritten");
  assert.equal(sha256(fs.readFileSync(fx.first)), sha256(before));
});

test("public Pi Web proxy replaces deletion with archive, filters views, restores, and never forwards hard delete", async (t) => {
  const fx = makeFixture();
  const upstreamRequests = [];
  const running = new Set();
  let hardDeleteRequests = 0;
  const sessions = [
    { id: SESSION_ID, path: fx.first, cwd: "C:/work", name: "海棠项目", modified: "2026-09-01T10:00:02.000Z", messageCount: 2 },
    { id: SECOND_SESSION_ID, path: fx.second, cwd: "C:/work", name: "梧桐项目", modified: "2026-09-01T10:01:02.000Z", messageCount: 2 },
    { id: CHILD_SESSION_ID, path: fx.child, cwd: "C:/work", name: "海棠子智能体", modified: "2026-09-01T10:02:02.000Z", messageCount: 2, relation: { kind: "subagent", parentSessionId: SESSION_ID } },
  ];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push({ method: request.method, url: request.url });
    if (request.method === "GET" && request.url?.startsWith("/api/agent/running")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ runningSessionIds: [...running] }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/sessions")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessions, homeDir: fx.root }));
      return;
    }
    if (request.method === "DELETE" && request.url?.startsWith("/api/sessions/")) {
      hardDeleteRequests += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "hard delete must never be reached" }));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/agent/")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true, data: null }));
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Pi Web</title></head><body><main>ok</main></body></html>");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const webPort = upstream.address().port;
  const publicWebPort = await reservePort();
  let healthPort = await reservePort();
  while (healthPort === publicWebPort) healthPort = await reservePort();
  const supervisor = new RunSupervisor({
    dataRoot: fx.root,
    sessionRoot: fx.sessionRoot,
    webPort,
    publicWebPort,
    healthPort,
    pollMs: 60_000,
    now: fixedNow,
  });
  t.after(async () => {
    await supervisor.close();
    await closeServer(upstream);
    fs.rmSync(fx.root, { recursive: true, force: true });
  });
  await supervisor.start();
  const base = `http://127.0.0.1:${publicWebPort}`;
  const firstHash = sha256(fs.readFileSync(fx.first));

  let response = await fetch(`${base}/api/sessions/${SESSION_ID}/archive`, { method: "POST" });
  let body = await expectJsonStatus(response, 200);
  assert.equal(body.archived, true);
  assert.equal(body.preserved, true);
  assert.equal(hardDeleteRequests, 0);
  assert.equal(sha256(fs.readFileSync(fx.first)), firstHash);

  body = await (await fetch(`${base}/api/sessions`)).json();
  assert.deepEqual(body.sessions.map((item) => item.id), [SECOND_SESSION_ID]);
  assert.deepEqual(body.archive, { view: "active", activeCount: 1, archivedCount: 1, archivedSessionCount: 2, version: PIWEB_ARCHIVE_VERSION });
  body = await (await fetch(`${base}/api/sessions?force=1&archiveView=archived`)).json();
  assert.deepEqual(body.sessions.map((item) => item.id), [SESSION_ID, CHILD_SESSION_ID]);
  assert.equal(body.sessions[0].archived, true);
  assert.equal(body.sessions[0].archivedAt, "2026-09-01T11:00:00.000Z");

  response = await fetch(`${base}/api/sessions/${SESSION_ID}/restore`, { method: "POST" });
  assert.equal((await expectJsonStatus(response, 200)).restored, true);
  body = await (await fetch(`${base}/api/sessions`)).json();
  assert.deepEqual(body.sessions.map((item) => item.id), [SESSION_ID, SECOND_SESSION_ID, CHILD_SESSION_ID]);

  response = await fetch(`${base}/api/sessions/${SESSION_ID}`, { method: "DELETE" });
  assert.equal((await expectJsonStatus(response, 200)).archived, true, "legacy DELETE is a non-destructive archive alias");
  assert.equal(hardDeleteRequests, 0);
  assert.equal(sha256(fs.readFileSync(fx.first)), firstHash);

  response = await fetch(`${base}/api/agent/${SESSION_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "继续该会话" }),
  });
  await expectJsonStatus(response, 200);
  assert.equal(supervisor.archiveStore.isArchived(SESSION_ID, fx.first), false, "continuing an archived chat auto-restores it before forwarding");

  response = await fetch(`${base}/api/sessions/${SECOND_SESSION_ID}/archive`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(response.status, 403);
  assert.equal(supervisor.archiveStore.isArchived(SECOND_SESSION_ID, fx.second), false);

  running.add(SECOND_SESSION_ID);
  response = await fetch(`${base}/api/sessions/${SECOND_SESSION_ID}/archive`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /running/u);
  assert.equal(supervisor.archiveStore.isArchived(SECOND_SESSION_ID, fx.second), false);

  const html = await (await fetch(`${base}/`)).text();
  assert.equal((html.match(new RegExp(PIWEB_ARCHIVE_UI_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  const uiResponse = await fetch(`${base}${PIWEB_ARCHIVE_UI_PATH}`);
  assert.equal(uiResponse.status, 200);
  assert.match(uiResponse.headers.get("content-type") || "", /javascript/u);
  const uiSource = await uiResponse.text();
  assert.match(uiSource, /data-pi-session-archive/u);
  assert.match(uiSource, /archiveView/u);
  assert.match(uiSource, /\/archive/u);
  assert.match(uiSource, /\/restore/u);
  assert.match(uiSource, /归档/u);
  assert.match(uiSource, /恢复/u);
  assert.match(uiSource, /未找到会话/u, "the current zh-CN empty state must be mapped to the archive empty state");
  assert.match(uiSource, /requestListRefresh/u, "archive view must actively request its own list even while native refresh is busy");
  assert.match(uiSource, /window\.location\.reload\(\)/u, "archive view keeps a deterministic reload fallback when native refresh stays unavailable");
  assert.equal(hardDeleteRequests, 0);
  assert.equal(upstreamRequests.some((item) => item.method === "DELETE" && item.url?.startsWith("/api/sessions/")), false);
});

test("an archived native Pi session remains discoverable by the shared Pi/GPT history layer", async (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const store = new SessionArchiveStore(fx.archiveFile, { sessionRoot: fx.sessionRoot, now: fixedNow });
  const beforeHash = sha256(fs.readFileSync(fx.first));
  store.archive({ id: SESSION_ID, path: fx.first, cwd: "C:/work", name: "海棠项目" });

  const memoryRoot = path.join(fx.root, "memory");
  const config = {
    enabled: true,
    scanOnPrompt: false,
    recordOnStop: true,
    weeklyEnabled: false,
    historyRoots: [{ kind: "pi", path: fx.sessionRoot }],
  };
  const scanned = await scanHistory({ dataRoot: memoryRoot, config });
  assert.equal(scanned.physicalSources, 3);
  const resolved = await resolveHistory("请根据归档记录回答：海棠项目最终使用哪个方案？并给出其中的版本标记。", {
    dataRoot: memoryRoot,
    config,
    refresh: false,
    sessionId: "new-pi-or-gpt-session",
    maxFullChars: 800,
    archiveIndexPath: fx.archiveFile,
  });
  assert.equal(resolved.hit, true, JSON.stringify(resolved));
  assert.equal(resolved.mode, "archive");
  assert.match(resolved.full, /蓝色方案/u);
  assert.match(resolved.full, /ARCHIVE-A9Z7/u);
  assert.equal(sha256(fs.readFileSync(fx.first)), beforeHash);
});
