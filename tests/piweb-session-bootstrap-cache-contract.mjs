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

    await sleep(750);
    const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.deepEqual(persisted.body.sessions.map((session) => session.id), ["cached-1", "fresh-2"]);
    assert.match(fs.readFileSync(path.join(temp, "proxy.log"), "utf8"), /session-list-bootstrap-refreshed/u);
  } finally {
    await proxy.close().catch(() => {});
    await close(upstream).catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
