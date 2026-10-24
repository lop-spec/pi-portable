// 会话详情读取分流契约：真实 pi-web 编译路由 + 合成会话文件 + 假上游。
// 覆盖：缓存命中与文件变更失效、末行未写完时不写会话文件、运行中会话走上游、读取进程故障回退上游。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiWebUiProxy } from "../src/piweb-ui-proxy.mjs";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = path.join(HOME, "app", "node_modules", "@agegr", "pi-web");
const hasPackage = fs.existsSync(path.join(PACKAGE, ".next", "server", "app", "api", "sessions", "[id]", "route.js"));

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const reserve = async () => { const server = http.createServer(); const port = await listen(server); await close(server); return port; };

function line(value) { return `${JSON.stringify(value)}\n`; }

function makeSession(sessionRoot, id, { userText = "hello", terminated = true } = {}) {
  const dir = path.join(sessionRoot, "--C--work--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-22T00-00-00-000Z_${id}.jsonl`);
  const at = "2026-10-22T00:00:00.000Z";
  let text = line({ type: "session", version: 3, id, timestamp: at, cwd: "C:\\work" })
    + line({ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: userText }], timestamp: 1 } })
    + line({ type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2, stopReason: "stop" } });
  if (!terminated) text += JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: at, message: { role: "user", content: "partial" } }).slice(0, 40);
  fs.writeFileSync(file, text);
  return file;
}

async function harness(t, { running = [], readerScript } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-session-read-"));
  const sessionRoot = path.join(temp, ".pi", "agent", "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const upstreamHits = [];
  const catalogue = [];
  const upstream = http.createServer((request, response) => {
    upstreamHits.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent/running") return response.end(JSON.stringify({ runningSessionIds: running }));
    if (request.url.startsWith("/api/sessions?") || request.url === "/api/sessions") return response.end(JSON.stringify({ sessions: catalogue, runningSessionIds: running }));
    if (request.url.startsWith("/api/sessions/")) return response.end(JSON.stringify({ upstream: true }));
    response.statusCode = 404;
    response.end("{}");
  });
  const webPort = await listen(upstream);
  const publicWebPort = await reserve();
  const proxy = new PiWebUiProxy({
    dataRoot: temp, sessionRoot, webPort, publicWebPort, healthPort: await reserve(),
    sessionReaderPackageRoot: PACKAGE, sessionReaderScript: readerScript,
    sessionListCacheFile: path.join(temp, "list.json"), logFile: path.join(temp, "proxy.log"),
  });
  await proxy.start();
  t.after(async () => { await proxy.close(); await close(upstream); fs.rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${publicWebPort}`;
  const add = (id, options) => {
    const file = makeSession(sessionRoot, id, options);
    catalogue.push({ id, path: file, cwd: "C:\\work", modified: new Date().toISOString() });
    return file;
  };
  const list = async () => { await (await fetch(`${base}/api/sessions?force=1`)).arrayBuffer(); };
  const detail = async (id, query = "?deferThinking=1&deferMedia=1&tree=summary&force=1") => {
    const response = await fetch(`${base}/api/sessions/${id}${query}`);
    return { status: response.status, source: response.headers.get("x-pi-session-read"), body: await response.json() };
  };
  return { temp, proxy, add, list, detail, upstreamHits, logFile: path.join(temp, "proxy.log") };
}

test("idle session detail is computed off pi-web, cached by fingerprint and invalidated on change", { skip: !hasPackage && "pi-web package missing" }, async (t) => {
  const h = await harness(t);
  const id = "01a00000-0000-7000-8000-000000000001";
  const file = h.add(id);
  await h.list();
  const first = await h.detail(id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.source, "reader");
  assert.equal(first.body.sessionId, id);
  assert.equal(first.body.stats.userMessages, 1);
  assert.ok(!h.upstreamHits.some((url) => url.startsWith(`/api/sessions/${id}`)), "pi-web must not parse the idle session");

  const second = await h.detail(id);
  assert.equal(second.source, "memory");
  assert.deepEqual(second.body, first.body);

  fs.appendFileSync(file, line({ type: "message", id: "u2", parentId: "a1", timestamp: "2026-10-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 3 } }));
  const changed = await h.detail(id);
  assert.equal(changed.source, "reader");
  assert.equal(changed.body.stats.userMessages, 2);
  assert.notEqual(changed.body.snapshotRevision, first.body.snapshotRevision);

  const context = await fetch(`http://127.0.0.1:${h.proxy.publicWebPort}/api/sessions/${id}/context?deferThinking=1&leafId=u2`);
  assert.equal(context.status, 200);
  assert.equal(context.headers.get("x-pi-session-read"), "reader");
});

test("a session whose last line is still being written is read without touching the file", { skip: !hasPackage && "pi-web package missing" }, async (t) => {
  const h = await harness(t);
  const id = "01a00000-0000-7000-8000-000000000002";
  const file = h.add(id, { terminated: false });
  await h.list();
  const before = fs.readFileSync(file);
  const result = await h.detail(id);
  assert.equal(result.status, 200);
  assert.equal(result.source, "reader-uncached");
  assert.equal(result.body.stats.userMessages, 1);
  assert.ok(fs.readFileSync(file).equals(before), "reader must never repair or rewrite pi-web's session file");
});

test("running sessions and unknown sessions stay on pi-web", { skip: !hasPackage && "pi-web package missing" }, async (t) => {
  const runningId = "01a00000-0000-7000-8000-000000000003";
  const h = await harness(t, { running: [runningId] });
  h.add(runningId);
  await h.list();
  const running = await h.detail(runningId);
  assert.deepEqual(running.body, { upstream: true });
  const unknown = await h.detail("01a00000-0000-7000-8000-00000000ffff");
  assert.deepEqual(unknown.body, { upstream: true });
});

test("a failing reader falls back to pi-web", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-session-read-stub-"));
  const stub = path.join(temp, "stub-reader.cjs");
  fs.writeFileSync(stub, "process.exit(3);\n");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const h = await harness(t, { readerScript: stub });
  const id = "01a00000-0000-7000-8000-000000000004";
  h.add(id);
  await h.list();
  const result = await h.detail(id);
  assert.deepEqual(result.body, { upstream: true });
});
