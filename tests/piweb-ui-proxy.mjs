import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PiWebUiProxy, PIWEB_ARCHIVE_UI_PATH, SessionArchiveStore } from "../src/piweb-ui-proxy.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-ui-proxy-test-"));
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

let received = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    received = { method: req.method, url: req.url, body: Buffer.concat(chunks), host: req.headers.host };
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head></head><body>ok</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/account/select" ? { ok: true, id: "acct3" } : { accepted: true }));
  });
});
const upstreamPort = await listen(upstream);
const reserve = async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
};
const publicPort = await reserve();
const healthPort = await reserve();
const logFile = path.join(temp, "proxy.log");
const proxy = new PiWebUiProxy({
  dataRoot: temp,
  sessionRoot: path.join(temp, "sessions"),
  webPort: upstreamPort,
  publicWebPort: publicPort,
  healthPort,
  bridgePort: upstreamPort,
  logFile,
  archiveUiSource: "window.__archiveTest=true;",
});

try {
  await proxy.start();
  const secretPrompt = "PROMPT_MUST_NOT_BE_PERSISTED_41f75e";
  const raw = JSON.stringify({ type: "prompt", message: secretPrompt });
  const response = await fetch(`http://127.0.0.1:${publicPort}/api/agent/test-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  assert.equal(response.status, 200);
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/api/agent/test-session");
  assert.equal(received.body.toString("utf8"), raw);
  assert.equal(received.host, `127.0.0.1:${publicPort}`);
  assert.equal(fs.readFileSync(logFile, "utf8").includes(secretPrompt), false);
  assert.equal(fs.existsSync(path.join(temp, "run-supervisor", "intents")), false);

  const selected = await (await fetch(`http://127.0.0.1:${publicPort}/__pi_account_select`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${publicPort}` },
    body: JSON.stringify({ id: "acct3" }),
  })).json();
  assert.deepEqual(selected, { ok: true, id: "acct3" });
  assert.equal(received.url, "/account/select");
  assert.equal(received.body.toString("utf8"), JSON.stringify({ id: "acct3" }));

  const health = await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json();
  assert.deepEqual({
    promptCapture: health.promptCapture,
    recoveryDispatch: health.recoveryDispatch,
    goalStateConsumer: health.goalStateConsumer,
    agentRequests: health.agentRequests,
  }, {
    promptCapture: false,
    recoveryDispatch: false,
    goalStateConsumer: false,
    agentRequests: "byte-stream-pass-through",
  });

  const html = await (await fetch(`http://127.0.0.1:${publicPort}/`, { headers: { accept: "text/html" } })).text();
  assert.ok(html.includes(PIWEB_ARCHIVE_UI_PATH));

  const sessions = path.join(temp, "sessions", "project");
  fs.mkdirSync(sessions, { recursive: true });
  const id = "01a00000-0000-7000-8000-000000000001";
  const sessionFile = path.join(sessions, `2026-09-05T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id, cwd: temp }) + "\n");
  const archive = new SessionArchiveStore(path.join(temp, "session-archive.json"), { sessionRoot: path.join(temp, "sessions") });
  const archived = archive.archiveMany([{ id, path: sessionFile, cwd: temp, name: "demo" }], id);
  assert.equal(archived.created, true);
  assert.equal(archive.partition([{ id, path: sessionFile }]).archived.length, 1);
  assert.equal(archive.restore(id).restored, true);
  assert.equal(archive.partition([{ id, path: sessionFile }]).active.length, 1);

  console.log(JSON.stringify({ ok: true, passThrough: true, promptPersisted: false, accountSelect: true, archive: true }));
} finally {
  await proxy.close().catch(() => {});
  await close(upstream).catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}
