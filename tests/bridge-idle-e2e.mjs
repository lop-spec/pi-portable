import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const listen = async server => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-idle-e2e-"));
const sockets = new Set();
let finishStream;
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  res.write('event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n');
  finishStream = () => res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
});
const upstreamPort = await listen(upstream);
const proxy = http.createServer();
proxy.on("connect", (_req, client, head) => {
  sockets.add(client); client.on("error", () => {});
  const target = net.connect(upstreamPort, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) target.write(head);
    client.pipe(target); target.pipe(client);
  });
  target.on("error", () => client.destroy());
  client.on("close", () => { target.destroy(); sockets.delete(client); });
});
const proxyPort = await listen(proxy);
const reservation = http.createServer(); const port = await listen(reservation); await new Promise(r => reservation.close(r));
const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/bridge-idle-child.mjs", import.meta.url))], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_PORTABLE_DATA: temp, CODEX_PROXY_PORT: String(port), CODEX_ACCOUNT_HOMES: path.join(temp, "absent"), CODEX_UPSTREAM_GZIP: "0", CODEX_UPSTREAM_PROXY_HOST: "127.0.0.1", CODEX_UPSTREAM_PROXY_PORT: String(proxyPort), CODEX_EGRESS_FALLBACK_PORTS: "" },
});
let log = ""; child.stdout.on("data", c => log += c); child.stderr.on("data", c => log += c);
const exit = once(child, "exit");
const base = `http://127.0.0.1:${port}`;
try {
  let health;
  for (let i = 0; i < 50; i++) {
    try { health = await (await fetch(base + "/health", { signal: AbortSignal.timeout(500) })).json(); if (health.ok) break; } catch { /* child startup only */ }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(health?.transportErrorVersion, "http-status-v1");
  assert.equal(health.lifecycle.activeRequests, 0);
  const pending = fetch(base + "/v1/codex/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }) });
  for (let i = 0; i < 50 && !finishStream; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(typeof finishStream, "function");
  const shutdown = () => fetch(base + "/admin/shutdown-if-idle", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const busy = await shutdown();
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).activeRequests, 1);
  assert.equal(child.exitCode, null, "active SSE must never be terminated by deployment");
  finishStream();
  const completed = await pending;
  assert.match(await completed.text(), /response\.completed/);
  const idle = await shutdown();
  assert.equal(idle.status, 200);
  assert.equal((await idle.json()).activeRequests, 0);
  const timer = setTimeout(() => child.kill(), 5000);
  const [code] = await exit; clearTimeout(timer);
  assert.equal(code, 0, log);
  assert.match(log, /shutdown refused reason=active-requests/);
  assert.match(log, /shutdown accepted reason=idle/);
  console.log("bridge-idle-e2e: PASS real active SSE preserved, busy=409, idle=200, clean exit=0; model calls=0");
} finally {
  if (child.exitCode === null) { child.kill(); await exit; }
  for (const s of sockets) s.destroy();
  proxy.close(); upstream.closeAllConnections(); upstream.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
