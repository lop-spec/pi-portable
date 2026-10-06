import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PiWebUiProxy, PIWEB_ARCHIVE_UI_PATH, SessionArchiveStore } from "../src/piweb-ui-proxy.mjs";
import "./piweb-session-bootstrap-cache-contract.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-ui-proxy-test-"));
fs.mkdirSync(path.join(temp, ".pi", "agent"), { recursive: true });
fs.writeFileSync(path.join(temp, ".pi", "agent", "settings.json"), JSON.stringify({
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.6-sol",
  defaultThinkingLevel: "medium",
  modelThinkingLevels: { "openai-codex/gpt-5.6-sol": "max" },
}));
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

  const page = await fetch(`http://127.0.0.1:${publicPort}/`, { headers: { accept: "text/html" } });
  const html = await page.text();
  // The injected script keeps its synchronous <head> position (its fetch wrappers must precede Next),
  // but under a content-hashed, immutable URL; the HTML itself revalidates instead of no-store.
  const scriptPath = /src="(\/__pi_archive_ui\.[0-9a-f]{12}\.js)"/u.exec(html)?.[1];
  assert.ok(scriptPath, "page must reference the hashed injected script");
  assert.doesNotMatch(html, /<script[^>]+__pi_archive_ui[^>]+\b(defer|async)\b/u, "the injected script must stay synchronous");
  assert.equal(page.headers.get("cache-control"), "private, no-cache");
  const pageEtag = page.headers.get("etag");
  assert.ok(pageEtag);
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}/`, { headers: { accept: "text/html", "if-none-match": pageEtag } })).status, 304);
  const script = await fetch(`http://127.0.0.1:${publicPort}${scriptPath}`);
  assert.equal(script.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await script.text(), "window.__archiveTest=true;");
  const legacy = await fetch(`http://127.0.0.1:${publicPort}${PIWEB_ARCHIVE_UI_PATH}`);
  assert.equal(legacy.headers.get("cache-control"), "no-cache", "the unversioned URL still works, revalidated");
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}${PIWEB_ARCHIVE_UI_PATH}`, { headers: { "if-none-match": legacy.headers.get("etag") } })).status, 304);
  await legacy.arrayBuffer();
  assert.ok(html.includes('localStorage.getItem("pi-last-model")'));
  assert.ok(html.includes('openai-codex'));
  assert.ok(html.includes('pi-last-thinking-level'));
  assert.ok(html.includes('"max"'));

  const sessions = path.join(temp, "sessions", "project");
  fs.mkdirSync(sessions, { recursive: true });
  const id = "01a00000-0000-7000-8000-000000000001";
  const sessionFile = path.join(sessions, `2026-09-05T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id, cwd: temp }) + "\n");
  const archive = new SessionArchiveStore(path.join(temp, "session-archive.json"), { sessionRoot: path.join(temp, "sessions") });
  const archived = archive.archiveMany([{ id, path: sessionFile, cwd: temp, name: "demo" }], id);
  assert.equal(archived.created, true);
  // The partition index is cached in memory (write-through on save): same object until the file changes.
  const index = archive.cached();
  assert.equal(archive.cached(), index, "the hot path must not re-read session-archive.json per request");
  assert.equal(index.keys.has(id), true);
  assert.equal(archive.partition([{ id, path: sessionFile }]).archived.length, 1);
  assert.equal(archive.restore(id).restored, true);
  assert.equal(archive.partition([{ id, path: sessionFile }]).active.length, 1);

  console.log(JSON.stringify({ ok: true, passThrough: true, promptPersisted: false, accountSelect: true, archive: true }));
} finally {
  await proxy.close().catch(() => {});
  await close(upstream).catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}
