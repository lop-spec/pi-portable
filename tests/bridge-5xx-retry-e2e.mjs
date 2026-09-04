// 端到端:真实起一个桥实例(临时端口/临时数据根/账号池关闭),把上游 https.request 打桩成
// "前两次 503,第三次正常 SSE",断言下游拿到 200 且完整流,桥日志与 metrics 留下 5xx 重试痕迹。
// 覆盖单测够不到的接线面:STATUS_RETRY_ENABLED 是否真的传进重试层、onRetry 是否记账、
// 首个有效事件之后不得再重试。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const PORT = Number(process.env.BRIDGE_E2E_PORT || 18894);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-5xx-e2e-"));
const emptyHomes = path.join(root, "homes-absent");

process.env.CODEX_PROXY_PORT = String(PORT);
process.env.PI_PORTABLE_DATA = root;
process.env.CODEX_ACCOUNT_HOMES = emptyHomes; // 不存在 → 账号池禁用,身份透明传递
process.env.CODEX_OVERLOAD_BASE_DELAY_MS = "20";
process.env.CODEX_OVERLOAD_MAX_DELAY_MS = "40";
process.env.CODEX_UPSTREAM_GZIP = "0";
delete process.env.CODEX_UPSTREAM_PROXY_PORT; // 直连路径,不触发 CONNECT

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const SSE_OK = frame("response.created", { type: "response.created", response: { status: "in_progress" } })
  + frame("response.output_item.added", { type: "response.output_item.added", item: { type: "message" } })
  + frame("response.completed", { type: "response.completed", response: { status: "completed" } });

let upstreamCalls = 0;
const seenModels = [];
https.request = (options, callback) => {
  const attempt = upstreamCalls;
  upstreamCalls += 1;
  const chunks = [];
  const fake = {
    reusedSocket: false,
    setTimeout() {},
    on() { return fake; },
    once() { return fake; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end() {
      try { seenModels.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).model); }
      catch { seenModels.push("<unparsed>"); }
      const response = attempt < 2
        ? Object.assign(Readable.from([Buffer.from(JSON.stringify({ error: { message: "overloaded" } }))]), {
          statusCode: 503, headers: { "content-type": "application/json" },
        })
        : Object.assign(Readable.from([Buffer.from(SSE_OK)]), {
          statusCode: 200, headers: { "content-type": "text/event-stream" },
        });
      setImmediate(() => callback(response));
    },
    destroy() {},
  };
  return fake;
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

const health = await waitForHealth();
assert.equal(health.overloadRetry.statusRetry, true);
assert.deepEqual(health.overloadRetry.statusRetryCodes, [500, 502, 503, 504, 529]);

const body = JSON.stringify({
  model: "gpt-5.6-sol",
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
});
const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test", originator: "bridge-5xx-e2e" },
  body,
});
const text = await response.text();

assert.equal(response.status, 200, "两次 503 之后下游必须拿到成功流,而不是 503");
assert.equal(upstreamCalls, 3, "两次退避重试 + 一次成功");
assert.match(text, /response\.completed/u, "成功流必须完整转发");
// 5xx 重试复用模型 fallback 阶梯:Sol → Terra → Luna。
assert.deepEqual(seenModels, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

const metricsFile = path.join(root, "proxy-metrics.jsonl");
const rows = fs.readFileSync(metricsFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const retries = rows.filter((row) => row.retryKind === "http-status");
assert.equal(retries.length, 2, "每次 5xx 重试都要记账,失败路径不得静默");
assert.equal(retries[0].statusRetry, true);
assert.equal(retries[0].upstreamStatus, 503);
assert.equal(retries[0].errorKind, "http_503");
assert.ok(retries[0].overloadDelayMs > 0, "必须真的退避而不是立刻重打");

const logFile = path.join(root, "codex-responses-proxy.log");
const logText = fs.readFileSync(logFile, "utf8");
assert.match(logText, /上游 5xx：status=503/u, "重试必须留一行含原因的日志");

console.log(`bridge-5xx-retry-e2e: ALL PASS (upstreamCalls=${upstreamCalls}, retries=${retries.length}, delays=${retries.map((r) => r.overloadDelayMs).join("/")}ms)`);
// 桥在本进程内持有监听 socket 与在途的 fs.appendFile:立刻 exit 会踩 Windows libuv 的
// UV_HANDLE_CLOSING 断言(实测 exit=127)。给异步写一个排空窗口,再收临时目录并退出。
setTimeout(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录交给系统回收 */ }
  process.exit(0);
}, 200);
