// 端到端:真实起一个桥实例(临时端口/临时数据根/账号池关闭),主出口指向本测试的假 CONNECT 代理 A,
// 备用出口指向假代理 B(CODEX_EGRESS_FALLBACK_PORTS),回退等待 100ms。tls.connect 打桩成
// "隧道 socket 直接当安全连接"(桥只用 secureConnect/error 两个事件)。三个阶段:
//  1 flaky:A 第 1 次悬挂、第 2 次 503、第 3 次放行,B 一直悬挂 → 200 完整流,日志/metrics 各两条连接层重试;
//  2 dead:A、B 全悬挂 → 3 次尝试后 502「上游连接失败」,日志带次数与备用结果,metrics 用错误码记账;
//  3 fallback:A 悬挂、B 放行 → 主出口未建立 100ms 后备用先成功,200 且日志/metrics 留下出口回退痕迹,
//    落败的主出口 CONNECT 被立即取消(A 侧收到断开,不等到 300ms 超时)。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const PORT = process.env.BRIDGE_E2E_PORT ? Number(process.env.BRIDGE_E2E_PORT) : await reservePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-connect-e2e-"));

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const SSE_OK = frame("response.created", { type: "response.created", response: { status: "in_progress" } })
  + frame("response.output_item.added", { type: "response.output_item.added", item: { type: "message" } })
  + frame("response.completed", { type: "response.completed", response: { status: "completed" } });

// 假上游(明文 HTTP,充当隧道另一端)。Connection: close 让桥不复用连接,每个请求都必须重新 CONNECT。
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  res.end(SSE_OK);
});
const upstreamPort = await listen(upstream);

const hung = new Set();
let hungClosed = 0;
function hang(clientSocket) {
  hung.add(clientSocket);
  // http.Server 交出的 socket 是 allowHalfOpen:对端 destroy 只送来 FIN → 'end',不会自动 'close'。
  let counted = false;
  const gone = () => { if (counted) return; counted = true; hungClosed += 1; hung.delete(clientSocket); clientSocket.destroy(); };
  clientSocket.once("end", gone);
  clientSocket.once("close", gone);
}
function tunnel(clientSocket, head) {
  const target = net.connect(upstreamPort, "127.0.0.1", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) target.write(head);
    clientSocket.pipe(target);
    target.pipe(clientSocket);
  });
  target.on("error", () => clientSocket.destroy());
  clientSocket.on("close", () => target.destroy());
}
// 假代理 A(主出口):flaky 第 1 次悬挂、第 2 次 503、其后放行;dead 全悬挂。
let modeA = "flaky";
let callsA = 0;
const proxyA = http.createServer((req, res) => { res.writeHead(405); res.end(); });
proxyA.on("connect", (req, clientSocket, head) => {
  callsA += 1;
  clientSocket.on("error", () => {});
  if (modeA === "dead" || callsA === 1) { hang(clientSocket); return; }
  if (callsA === 2) { clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
  tunnel(clientSocket, head);
});
const portA = await listen(proxyA);
// 假代理 B(备用出口):hang 悬挂;pass 放行。
let modeB = "hang";
let callsB = 0;
const proxyB = http.createServer((req, res) => { res.writeHead(405); res.end(); });
proxyB.on("connect", (req, clientSocket, head) => {
  callsB += 1;
  clientSocket.on("error", () => {});
  if (modeB === "hang") { hang(clientSocket); return; }
  tunnel(clientSocket, head);
});
const portB = await listen(proxyB);

process.env.CODEX_FOLLOW_SYSTEM_PROXY = "0"; // Fixture proxy; never consult the user's registry.
process.env.CODEX_PROXY_PORT = String(PORT);
process.env.PI_PORTABLE_DATA = root;
process.env.CODEX_ACCOUNT_HOMES = path.join(root, "homes-absent"); // 不存在 → 账号池禁用(显式路径不回落)
process.env.CODEX_UPSTREAM_GZIP = "0";
process.env.CODEX_UPSTREAM_PROXY_HOST = "127.0.0.1";
process.env.CODEX_UPSTREAM_PROXY_PORT = String(portA);
process.env.CODEX_CONNECT_TIMEOUT_MS = "300";
process.env.CODEX_CONNECT_RETRIES = "2";
process.env.CODEX_CONNECT_RETRY_DELAY_MS = "20";
process.env.CODEX_EGRESS_FALLBACK_PORTS = String(portB);
process.env.CODEX_EGRESS_FALLBACK_AFTER_MS = "100";

// 隧道 socket 直接当作安全连接。
tls.connect = (options) => {
  const socket = options.socket;
  process.nextTick(() => socket.emit("secureConnect"));
  return socket;
};

await import("../src/bridge/codex-responses-proxy.mjs");

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return res.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge did not become healthy");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await waitForHealth();
assert.deepEqual(health.connectRetry, { timeoutMs: 300, retries: 2, delayMs: 20 }, "/health 必须暴露连接层重试配置");
assert.deepEqual(health.egressFallback, { ports: [portB], afterMs: 100 }, "/health 必须暴露出口回退配置");

const body = JSON.stringify({
  model: "gpt-5.6-sol",
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
});
const send = () => fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test", originator: "bridge-connect-e2e" },
  body,
});
const metricsFile = path.join(root, "proxy-metrics.jsonl");
const readRows = () => fs.readFileSync(metricsFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const logFile = path.join(root, "codex-responses-proxy.log");
const readLog = () => fs.readFileSync(logFile, "utf8");

// 阶段 1:flaky
const first = await send();
const firstText = await first.text();
assert.equal(first.status, 200, "CONNECT 超时+503 之后第三次成功,下游必须拿到 200");
assert.match(firstText, /response\.completed/u, "成功流必须完整转发");
assert.equal(callsA, 3, "主出口:悬挂、503、成功 = 三次 CONNECT");
assert.equal(callsB, 2, "备用出口:前两次尝试主出口未建立/失败后各起一次,第三次主出口直接成功不再起");
const connectRows = readRows().filter((row) => row.retryKind === "connect");
assert.equal(connectRows.length, 2, "每次连接层重试都要记账");
assert.deepEqual(connectRows.map((row) => row.errorKind), ["ECONNECT_TIMEOUT", "ECONNECT_REJECTED"]);
assert.deepEqual(connectRows.map((row) => row.delayMs), [20, 40], "退避随次数递增");
assert.equal(connectRows[0].egressPort, portA);
let logText = readLog();
assert.equal((logText.match(/连接层失败（ECONNECT_TIMEOUT：CONNECT 超时 300ms；备用 127\.0\.0\.1:\d+=ECONNECT_TIMEOUT）/gu) || []).length, 1, "重试日志要带主出口错误与备用结果");
assert.equal((logText.match(/连接层失败（ECONNECT_REJECTED：CONNECT 返回 503；备用/gu) || []).length, 1);
assert.doesNotMatch(logText, /上游连接失败/u, "重试成功时不得出现 502 日志");
assert.doesNotMatch(logText, /出口回退：主出口 127\.0\.0\.1/u, "备用一直悬挂时不得记成回退成功(启动配置行也以「出口回退」开头,只认成功行形态)");

// 阶段 2:dead(主、备全悬挂),预算耗尽才 502
modeA = "dead";
callsA = 0; callsB = 0;
const second = await send();
const secondJson = await second.json();
assert.equal(second.status, 502);
assert.match(secondJson.error.message, /HTTP 502 upstream connect failed \(ECONNECT_TIMEOUT\)/);
assert.equal(secondJson.error.code, "ECONNECT_TIMEOUT");
assert.equal(secondJson.error.attempts, 3);
assert.equal(callsA, 3, "主出口 1 次 + 2 次重试 = 3 次 CONNECT,不得多也不得少");
assert.equal(callsB, 3, "每次尝试主出口 100ms 未建立都要起一次备用");
logText = readLog();
assert.match(logText, /上游连接失败：CONNECT 超时 300ms；备用 127\.0\.0\.1:\d+=ECONNECT_TIMEOUT（连接尝试 3 次）/u, "502 日志必须带尝试次数与备用结果");
const failRows = readRows().filter((row) => row.status === 502 && !row.retryKind);
assert.equal(failRows.length, 1);
assert.equal(failRows[0].errorKind, "ECONNECT_TIMEOUT", "失败记账用错误码,guard 才能按种类归类");

// 阶段 3:主出口黑掉、备用放行 → 回退成功,落败的主出口 CONNECT 立即被取消
modeB = "pass";
callsA = 0; callsB = 0;
await sleep(350); // 让阶段 2 残留的悬挂连接全部超时关闭,下面只数本阶段的
hungClosed = 0;
const startedAt = Date.now();
const third = await send();
const thirdText = await third.text();
const elapsed = Date.now() - startedAt;
assert.equal(third.status, 200, "主出口悬挂时备用出口必须把请求送达");
assert.match(thirdText, /response\.completed/u);
assert.equal(callsA, 1, "主出口只起一次(备用成功后不再重试)");
assert.equal(callsB, 1, "备用出口一次成功");
assert.ok(elapsed < 300, `备用应在主出口超时(300ms)之前接管,实际 ${elapsed}ms`);
await sleep(50);
assert.equal(hungClosed, 1, "落败的主出口 CONNECT 必须在胜出后立即销毁,而不是等 300ms 超时");
logText = readLog();
assert.match(logText, /出口回退：主出口 127\.0\.0\.1:\d+ \d+ms 未建立，备用 127\.0\.0\.1:\d+ 先成功（仅本连接）host=chatgpt\.com/u, "回退成功必须留一行日志");
assert.match(logText, new RegExp(`-> POST 200 .* egress=${portB}\\(回退\\)`, "u"), "响应日志要标出实际走的出口");
const fallbackRows = readRows().filter((row) => row.retryKind === "egress-fallback");
assert.equal(fallbackRows.length, 1, "回退成功要记账");
assert.equal(fallbackRows[0].primaryPort, portA);
assert.equal(fallbackRows[0].egressPort, portB);
const okRows = readRows().filter((row) => row.status === 200 && !row.retryKind);
assert.equal(okRows.at(-1)?.egressKey, `fallback:${portB}`, "流吞吐记账里的出口要写实际回退出口");

console.log(`bridge-connect-retry-e2e: ALL PASS (A=${portA} B=${portB}, fallbackElapsed=${elapsed}ms)`);
for (const socket of hung) socket.destroy();
proxyA.close();
proxyB.close();
upstream.close();
setTimeout(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录交给系统回收 */ }
  process.exit(0);
}, 200);
