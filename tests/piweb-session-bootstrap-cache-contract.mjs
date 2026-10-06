import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiWebUiProxy } from "../src/piweb-ui-proxy.mjs";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const reserve = async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the first session list after process start is served from a persistent bootstrap snapshot", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-session-bootstrap-"));
  const cacheFile = path.join(temp, "session-list.json");
  const cachedBody = {
    sessions: [{ id: "cached-1", cwd: "C:/work", firstMessage: "cached conversation" }],
    runningSessionIds: [],
  };
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, savedAtMs: Date.now() - 1000, body: cachedBody }));

  const upstream = http.createServer(async (request, response) => {
    if (request.url?.startsWith("/api/sessions?summary=1")) {
      // Summary rows are placeholders (detailsPending): forwarded, never persisted.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessions: [{ id: "summary-only", detailsPending: true }], runningSessionIds: [] }));
      return;
    }
    if (request.url?.startsWith("/api/sessions")) {
      await sleep(600);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessions: [...cachedBody.sessions, { id: "fresh-2", cwd: "C:/work" }], runningSessionIds: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  const webPort = await listen(upstream);
  const publicWebPort = await reserve();
  const healthPort = await reserve();
  const proxy = new PiWebUiProxy({
    dataRoot: temp,
    sessionRoot: path.join(temp, "sessions"),
    sessionListCacheFile: cacheFile,
    webPort,
    publicWebPort,
    healthPort,
    bridgePort: webPort,
    logFile: path.join(temp, "proxy.log"),
    archiveUiSource: "",
    // Persisting is debounced off the request path (5 s in production); short here.
    sessionListPersistDelayMs: 50,
  });

  try {
    await proxy.start();
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${publicWebPort}/api/sessions`);
    const elapsedMs = performance.now() - started;
    const body = await response.json();
    assert.equal(response.headers.get("x-pi-session-list"), "bootstrap-cache");
    assert.deepEqual(body.sessions.map((session) => session.id), ["cached-1"]);
    assert.ok(elapsedMs < 250, `bootstrap response took ${elapsedMs.toFixed(1)}ms`);

    // Background refresh (600 ms upstream) + debounce, then an async write: poll briefly.
    for (let waited = 0; waited < 2000 && !fs.readFileSync(cacheFile, "utf8").includes("fresh-2"); waited += 50) await sleep(50);
    const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.deepEqual(persisted.body.sessions.map((session) => session.id), ["cached-1", "fresh-2"]);
    assert.match(fs.readFileSync(path.join(temp, "proxy.log"), "utf8"), /session-list-bootstrap-refreshed/u);

    // Identical upstream bytes are answered from the memo and never rewrite the snapshot;
    // summary=1 placeholders are forwarded but never become the snapshot either.
    const writtenAt = fs.statSync(cacheFile).mtimeMs;
    const again = await fetch(`http://127.0.0.1:${publicWebPort}/api/sessions`);
    assert.equal(again.headers.get("x-pi-session-list"), "fresh-reused");
    assert.equal(again.headers.get("x-pi-archived-count"), "0", "the page reads the archived count from this header, not by re-parsing the list");
    assert.deepEqual((await again.json()).sessions.map((session) => session.id), ["cached-1", "fresh-2"]);
    const summary = await fetch(`http://127.0.0.1:${publicWebPort}/api/sessions?summary=1`);
    assert.deepEqual((await summary.json()).sessions.map((session) => session.id), ["summary-only"]);
    await sleep(200);
    assert.equal(fs.statSync(cacheFile).mtimeMs, writtenAt, "unchanged lists and summary=1 responses must not rewrite the startup snapshot");
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")).body.sessions.map((session) => session.id), ["cached-1", "fresh-2"]);
  } finally {
    await proxy.close().catch(() => {});
    await close(upstream).catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
