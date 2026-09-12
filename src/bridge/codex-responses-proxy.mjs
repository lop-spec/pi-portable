// Codex（VS Code / VSCodium 扩展、codex CLI）的透明请求策略代理。
//
// 链路：Codex 扩展 --(codex 原生 responses)--> 本进程 :8794
//       --(保留/轮转登录身份 + 剥不兼容字段 + 稳定 cache key)-->
//       chatgpt.com/backend-api/codex/responses
//
// 身份默认由客户端的官方登录态负责（透传 Authorization 头）；检测到账号池 homes
// 布局时启用桥内多账号 sticky 轮转（account-pool.mjs），429/401 在应答下游之前完成
// 「冷却 → 切号 → 重发」。不落盘、不打印任何凭证。
// 默认直连上游；设 CODEX_UPSTREAM_PROXY_PORT 则走本机 CONNECT 代理。

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";

// [portable] 数据根:launcher 注入 PI_PORTABLE_DATA;回退 %LOCALAPPDATA%\\pi-portable
import os from "node:os";
import path from "node:path";
const PORTABLE_DATA = process.env.PI_PORTABLE_DATA
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "pi-portable");
fs.mkdirSync(PORTABLE_DATA, { recursive: true });

import { compressUpstreamBody, rewriteCodexRequestBody } from "./codex-cache-policy.mjs";
import { SUMMARIZATION_BODY_SIGNATURE, applySummarizationEffort, resolveSummaryEffort } from "./summarization-effort.mjs";
import { computeThroughput, createTailRing, extractUsage } from "./codex-stream-metrics.mjs";
import { createModelFallbackPlan, requestWithOverloadRetry, RETRYABLE_UPSTREAM_STATUS } from "./codex-overload-retry.mjs";
import { createAccountPool, sendWithAccountFailover } from "./account-pool.mjs";
import { createAccountUsageMonitor, readAccountUsageIdentity } from "./account-usage.mjs";
import { codexModelsUpstreamPath, DEFAULT_CODEX_MODELS_CLIENT_VERSION, modelCatalogResponseHeaders } from "./codex-model-catalog.mjs";
import { appendLineRotating } from "../log-rotate.mjs";
import { TRANSPORT_ERROR_VERSION, upstreamConnectionError } from "./transport-errors.mjs";
import { createRequestLifecycle } from "./request-lifecycle.mjs";
import { createSystemProxyFollower } from "../system-proxy.mjs";

const PORT = Number(process.env.CODEX_PROXY_PORT || 8794);
const HOST = "127.0.0.1";
const LOG_FILE = path.join(PORTABLE_DATA, "codex-responses-proxy.log");
const UPSTREAM_HOST = "chatgpt.com";
const UPSTREAM_PATH = "/backend-api/codex/responses";
const UPSTREAM_PROXY_HOST = process.env.CODEX_UPSTREAM_PROXY_HOST || "127.0.0.1";
const UPSTREAM_PROXY_PORT = Number(process.env.CODEX_UPSTREAM_PROXY_PORT || 0); // [portable] 0=直连
const EXPLICIT_BREAKPOINT = process.env.CODEX_CACHE_EXPLICIT_BREAKPOINT === "1";
// v8.0.0 slim(2026-09-02 lop 裁决):桥只保留 ①协议兼容(剥 max_output_tokens) ②账号池
// ③出口跟随/连接层/过载保护 ④观测(proxy-metrics) ⑤prompt_cache_key。撤掉 persistence 注入
// (协议文本移入 pi AGENTS.md 管理块,桥部署不再作废会话前缀)、response memo 精确重放、
// history 快路 reasoning 改写、tier 兜底——三样从未在真实流量里起作用,却是本周两起静默
// 缺陷(强制 max、注入失效)的温床。
const POLICY_VERSION = "gpt56-egress-fallback-v8.5.0";
// pi 压缩摘要请求单独的推理档位（默认 low；CODEX_SUMMARY_EFFORT=off 关闭）。判定只看 input[0]，无状态。
const SUMMARY_EFFORT = resolveSummaryEffort(process.env.CODEX_SUMMARY_EFFORT);
const UPSTREAM_GZIP = process.env.CODEX_UPSTREAM_GZIP !== "0";
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const OVERLOAD_MAX_RETRIES = Math.trunc(numberEnv("CODEX_OVERLOAD_MAX_RETRIES", 3));
const OVERLOAD_BASE_DELAY_MS = numberEnv("CODEX_OVERLOAD_BASE_DELAY_MS", 1200);
const OVERLOAD_MAX_DELAY_MS = numberEnv("CODEX_OVERLOAD_MAX_DELAY_MS", 8000);
const OVERLOAD_PREFIX_MAX_BYTES = Math.max(1024, numberEnv("CODEX_OVERLOAD_PREFIX_MAX_BYTES", 256 * 1024));
// 上游 5xx(500/502/503/504/529)在首字节被采信前退避重试;=0 关闭,退回原样透传。
const STATUS_RETRY_ENABLED = String(process.env.CODEX_STATUS_RETRY ?? "1") !== "0";
const OVERLOAD_PRIMARY_MODEL = process.env.CODEX_OVERLOAD_PRIMARY_MODEL || "gpt-5.6-sol";
const OVERLOAD_FALLBACK_MODELS = (process.env.CODEX_OVERLOAD_FALLBACK_MODELS ?? "gpt-5.6-terra,gpt-5.6-luna,gpt-reserve")
  .split(",").map((model) => model.trim()).filter(Boolean);
// 出口跟随：可选的出口选择状态文件（外部工具写入）。缺失/损坏时保持上次值，
// 最终回退环境默认（未设 CODEX_UPSTREAM_PROXY_PORT 即直连），fail-open 不断流。
const EGRESS_STATE_FILE = process.env.CODEX_EGRESS_STATE_FILE || path.join(PORTABLE_DATA, "active-egress.json");
const METRICS_FILE = path.join(PORTABLE_DATA, "proxy-metrics.jsonl");

function log(...args) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${args.join(" ")}`;
  console.log(line);
  const written = appendLineRotating(LOG_FILE, line);
  if (!written.ok) console.error(`[bridge-log] ${written.error}`);
}

function recordMetric(value) {
  const written = appendLineRotating(METRICS_FILE, JSON.stringify(value));
  if (!written.ok) log(`metrics 写入失败：${written.error}`);
}

// 进程级兜底：单条流的意外异常不许击穿整个桥（无状态转发器，活着永远比死了强；
// 2026-08-29 异机实测：客户端中断触发未监听 error → 进程静默退出 → pi 全线 Connection error）。
process.on("uncaughtException", (e) => log(`未捕获异常(进程保留)：${String(e?.stack || e).slice(0, 300)}`));
process.on("unhandledRejection", (e) => log(`未处理 rejection(进程保留)：${String(e?.stack || e).slice(0, 300)}`));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 单次上游请求：经本机代理建立 CONNECT + TLS，身份头由 Codex 原样提供。
// 头必须以客户端原样为基础再覆盖，不能自己拼一份白名单：codex 会 gzip 压缩请求体，
// 自拼白名单会漏掉 Content-Encoding，上游收到压缩字节却当明文解析，回 {"detail":"Bad Request"}
// （2026-08-19 实测，body 24062 字节 JSON.parse 失败即此因）。客户端比我更清楚
// chatgpt backend-api 要哪些头，所以只剔除逐跳头和身份头，其余照搬。
const HOP_BY_HOP = new Set(["host", "connection", "proxy-connection", "keep-alive",
  "transfer-encoding", "upgrade", "te", "trailer"]);

const followSystemProxy = process.platform === "win32" && process.env.CODEX_FOLLOW_SYSTEM_PROXY !== "0";
const systemProxyFollower = followSystemProxy ? createSystemProxyFollower({ log }) : null;
if (systemProxyFollower) await systemProxyFollower.start();
else log("system-proxy following disabled: non-Windows or CODEX_FOLLOW_SYSTEM_PROXY=0; explicit egress retained");
let egressCache = { at: 0, key: "env-default", host: UPSTREAM_PROXY_HOST, port: UPSTREAM_PROXY_PORT };
function currentEgress() {
  const system = systemProxyFollower?.snapshot();
  if (system) return system;
  if (Date.now() - egressCache.at < 5000) return egressCache;
  egressCache.at = Date.now();
  try {
    const state = JSON.parse(fs.readFileSync(EGRESS_STATE_FILE, "utf8"));
    if (Number(state.port) > 0) {
      if (Number(state.port) !== egressCache.port) {
        log(`出口切换：${egressCache.key}:${egressCache.port} → ${state.key}:${state.port}`);
      }
      egressCache.key = String(state.key || "");
      egressCache.port = Number(state.port);
      egressCache.host = String(state.host || UPSTREAM_PROXY_HOST);
    }
  } catch (error) { log(`legacy egress state unavailable: ${error?.code || error?.name || "read-failed"}; previous endpoint retained`); }
  return egressCache;
}

// 连接层重试（v8.4.0，2026-09-07）：CONNECT 超时/被拒、直连 TLS 超时都发生在任何请求字节
// 发出之前，重试语义安全。此前这类错误没有 code，进不了 upstreamOnce 的 RETRYABLE 集合，
// 一次 10s 超时就直接 502「上游连接失败」打断整轮任务（9/6 23:39 起 57905 出口抖动 8 次全部如此）。
// CODEX_CONNECT_RETRIES=0 即回到旧行为；每次尝试各自计时，退避 delay×第几次。
const CONNECT_TIMEOUT_MS = Math.max(100, numberEnv("CODEX_CONNECT_TIMEOUT_MS", 10000));
const CONNECT_RETRIES = Math.trunc(numberEnv("CODEX_CONNECT_RETRIES", 2));
const CONNECT_RETRY_DELAY_MS = numberEnv("CODEX_CONNECT_RETRY_DELAY_MS", 300);
const CONNECT_TIMEOUT_LABEL = CONNECT_TIMEOUT_MS >= 1000 ? `${Math.round(CONNECT_TIMEOUT_MS / 1000)}s` : `${CONNECT_TIMEOUT_MS}ms`;
const connectError = (code, message) => Object.assign(new Error(message), { code });
// 出口回退（v8.5.0，2026-09-07）：主出口 CONNECT 在 EGRESS_FALLBACK_AFTER_MS 内未建立就并行起备用出口，
// 先建立者胜出，每个连接独立决策、无状态。实录：57905 整段黑 30-60s（网关同毫秒批量 upstream timeout），
// 3×10s 串行重试扛不过；真直连 chatgpt.com 在本机不通，所以 "0"(直连) 只在显式列出时才作候选。
// 默认备用 18799(Smart Proxy)/57905(店铺网关)，与主出口去重；CODEX_EGRESS_FALLBACK_PORTS= 空串关闭。
const EGRESS_FALLBACK_PORTS = String(process.env.CODEX_EGRESS_FALLBACK_PORTS ?? "18799,57905")
  .split(",").map((v) => v.trim()).filter(Boolean).map(Number).filter((v) => Number.isInteger(v) && v >= 0);
const EGRESS_FALLBACK_AFTER_MS = Math.max(50, numberEnv("CODEX_EGRESS_FALLBACK_AFTER_MS", 3000));
const egressLabelOf = (port, proxyHost = currentEgress().host || UPSTREAM_PROXY_HOST) => (port ? `${proxyHost}:${port}` : "direct");

// ctl.cancel 由调用方在竞速结束后触发，销毁未胜出的在途连接（否则悬挂的 CONNECT 会占到超时）。
function connectUpstreamOnce(proxyPort, host, ctl = {}, proxyHost = currentEgress().host || UPSTREAM_PROXY_HOST) {
  // [portable] 直连模式:无本机 CONNECT 代理时直接 TLS 到上游(换机默认路径)
  if (!proxyPort) {
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] });
      ctl.cancel = () => secure.destroy(connectError("ECONNECT_CANCELLED", "竞速落败已取消"));
      secure.setTimeout(CONNECT_TIMEOUT_MS, () => secure.destroy(connectError("ETLS_TIMEOUT", `直连 TLS 超时 ${CONNECT_TIMEOUT_LABEL}`)));
      secure.once("secureConnect", () => { secure.setTimeout(0); resolve(secure); });
      secure.once("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${host}:443`,
      headers: { Host: `${host}:443` },
    });
    ctl.cancel = () => connect.destroy(connectError("ECONNECT_CANCELLED", "竞速落败已取消"));
    connect.setTimeout(CONNECT_TIMEOUT_MS, () => connect.destroy(connectError("ECONNECT_TIMEOUT", `CONNECT 超时 ${CONNECT_TIMEOUT_LABEL}`)));
    connect.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(connectError("ECONNECT_REJECTED", `CONNECT 返回 ${res.statusCode}`));
      }
      if (head?.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
      ctl.cancel = () => secure.destroy(connectError("ECONNECT_CANCELLED", "竞速落败已取消"));
      secure.once("secureConnect", () => resolve(secure));
      secure.once("error", reject);
    });
    connect.once("error", reject);
    connect.end();
  });
}

function egressCandidates(primaryPort) {
  if (systemProxyFollower?.snapshot()) return []; // Following system means no hidden alternate proxy.
  const seen = new Set([primaryPort || 0]);
  const out = [];
  for (const port of EGRESS_FALLBACK_PORTS) {
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  return out;
}

// 主出口先行；每过 EGRESS_FALLBACK_AFTER_MS 未成功（或某候选已失败）就再起下一个候选，
// 先建立的 socket 胜出并打上 lopEgress 标记，其余候选到达后即销毁。全部失败抛主出口的错误并附备用结果。
function connectWithFallback(primaryPort, host, proxyHost) {
  const fallbacks = egressCandidates(primaryPort);
  if (!fallbacks.length) return connectUpstreamOnce(primaryPort, host, {}, proxyHost);
  const primary = primaryPort || 0;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const queue = [primary, ...fallbacks];
    const failures = [];
    const controls = new Map();
    let inFlight = 0;
    let settled = false;
    let timer = null;
    const cancelOthers = (winner) => {
      for (const [port, ctl] of controls) if (port !== winner) { try { ctl.cancel?.(); } catch { /* 已结束 */ } }
    };
    const launch = () => {
      if (settled || !queue.length) return;
      const port = queue.shift();
      const ctl = {};
      controls.set(port, ctl);
      inFlight += 1;
      connectUpstreamOnce(port, host, ctl, proxyHost).then((socket) => {
        inFlight -= 1;
        if (settled) { socket.destroy(); return; }
        settled = true;
        clearTimeout(timer);
        cancelOthers(port);
        socket.lopEgress = { port, fallback: port !== primary };
        if (port !== primary) {
          const elapsed = Math.round(performance.now() - started);
          const primaryFail = failures.find((f) => f.port === primary);
          const why = primaryFail ? `失败（${primaryFail.error.code || primaryFail.error.message}）` : `${elapsed}ms 未建立`;
          log(`出口回退：主出口 ${egressLabelOf(primary)} ${why}，备用 ${egressLabelOf(port)} 先成功（仅本连接）host=${host}`);
          recordMetric({ ts: new Date().toISOString(), retryKind: "egress-fallback", primaryPort: primary, egressPort: port, elapsedMs: elapsed, host });
        }
        resolve(socket);
      }, (error) => {
        inFlight -= 1;
        failures.push({ port, error });
        if (settled) return;
        if (queue.length) { clearTimeout(timer); launch(); return; }
        if (inFlight > 0) return;
        settled = true;
        const main = failures.find((f) => f.port === primary)?.error || error;
        const others = failures.filter((f) => f.port !== primary)
          .map((f) => `${egressLabelOf(f.port)}=${f.error.code || String(f.error.message).slice(0, 40)}`).join("，");
        if (others) main.message = `${main.message}；备用 ${others}`;
        reject(main);
      });
      if (queue.length) timer = setTimeout(launch, EGRESS_FALLBACK_AFTER_MS);
    };
    launch();
  });
}

async function freshUpstreamSocket(proxyPort, host = UPSTREAM_HOST, proxyHost = currentEgress().host || UPSTREAM_PROXY_HOST) {
  const attempts = 1 + Math.max(0, CONNECT_RETRIES);
  const egressLabel = egressLabelOf(proxyPort, proxyHost);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectWithFallback(proxyPort, host, proxyHost);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delayMs = CONNECT_RETRY_DELAY_MS * attempt;
      const kind = String(error?.code || error?.message || "unknown").slice(0, 60);
      log(`连接层失败（${kind}：${String(error?.message || error).slice(0, 80)}）egress=${egressLabel} host=${host}，${delayMs}ms 后重试 ${attempt}/${attempts - 1}`);
      const egress = currentEgress();
      recordMetric({
        ts: new Date().toISOString(),
        egressKey: egress.port === (proxyPort || 0) ? egress.key : "",
        egressPort: proxyPort || 0,
        retryKind: "connect",
        attempt,
        maxRetries: attempts - 1,
        delayMs,
        errorKind: kind,
        host,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const error = lastError || connectError("ECONNECT_FAILED", "连接层失败");
  error.message = `${error.message}（连接尝试 ${attempts} 次）`;
  error.connectAttempts = attempts;
  throw error;
}

// 单会话内 Responses 是串行流，但现在多会话并发是常态（mobile-bridge 并发会话）。
// maxSockets=2 时第 3 个及以后的请求在本地排队：2026-08-27 实测 21 次 >30s TTFB
// 全部发生在并发窗口（含一次 GET /v1/models 44.6s），fresh socket 均值 17.9s vs
// 复用 1.9s。放宽到 16 并发 + 8 条保温空闲连接；上游主动关闭时 Agent 透明重建。
// 三类出口各持独立 Agent：切换出口不打断旧出口上的在途流，各自保温。
const upstreamAgents = new Map();
function agentFor(proxyPort, proxyHost = currentEgress().host || UPSTREAM_PROXY_HOST) {
  const agentKey = `${proxyHost}:${proxyPort}`;
  let agent = upstreamAgents.get(agentKey);
  if (agent) return agent;
  agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 16,
    maxFreeSockets: 8,
    scheduling: "lifo",
  });
  agent.createConnection = (_options, callback) => {
    freshUpstreamSocket(proxyPort, UPSTREAM_HOST, proxyHost).then(
      (socket) => callback(null, socket),
      (error) => callback(error),
    );
  };
  upstreamAgents.set(agentKey, agent);
  return agent;
}

function upstreamOnce(body, headers, allowRetry = true, onAttempt = () => {}) {
  onAttempt();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const egress = currentEgress();
    let responded = false;
    const fwd = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) fwd[k] = v;
    }
    const req = https.request({
      host: UPSTREAM_HOST, path: UPSTREAM_PATH, method: "POST",
      agent: agentFor(egress.port),
      headers: {
        ...fwd,
        "Content-Length": body.length,
      },
    }, (upRes) => {
      responded = true;
      const ttfbMs = performance.now() - started;
      const via = req.socket?.lopEgress;
      const actual = via?.fallback ? { key: `fallback:${via.port}`, port: via.port } : egress;
      upRes.lopMeta = { startedAt: started, ttfbMs, egress: { ...actual } };
      log(`-> POST ${upRes.statusCode} ttfbMs=${ttfbMs.toFixed(1)} reusedSocket=${req.reusedSocket ? "yes" : "no"} egress=${actual.port}${via?.fallback ? "(回退)" : ""}`);
      resolve(upRes);
    });
    // 首包前的连接层错误（保温竞态、节点瞬时 reset、CONNECT 失败）一律换新连接
    // 重发一次——未收到任何响应字节意味着请求未被上游处理，重发语义安全；
    // 已开始响应的失败绝不重发。持续性风暴由 proxy-guard 按失败记账切换出口。
    const RETRYABLE = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ECONNABORTED"]);
    req.on("error", (error) => {
      if (allowRetry && !responded && RETRYABLE.has(String(error?.code || ""))) {
        log(`首包前连接错误（${error.code}，reused=${req.reusedSocket ? "yes" : "no"}），换新连接重试一次`);
        setTimeout(() => resolve(upstreamOnce(body, headers, false, onAttempt)), 500);
        return;
      }
      reject(error);
    });
    req.setTimeout(300000, () => req.destroy(new Error("上游超时 300s")));
    req.write(body);
    req.end();
  });
}

// GET 转发（models 等只读探测端点用），同样只覆盖身份两头。
function upstreamGet(path, headers) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const fwd = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-length") fwd[k] = v;
    }
    const egress = currentEgress();
    const req = https.request({
      host: UPSTREAM_HOST, path, method: "GET",
      agent: agentFor(egress.port),
      headers: fwd,
    }, (upRes) => {
      const via = req.socket?.lopEgress;
      log(`-> GET ${upRes.statusCode} ttfbMs=${(performance.now() - started).toFixed(1)} reusedSocket=${req.reusedSocket ? "yes" : "no"} egress=${via?.fallback ? `${via.port}(回退)` : egress.port}`);
      resolve(upRes);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("models 请求超时 30s")));
    req.end();
  });
}

// 账号池：homes 槽位目录按存在性解析（env 显式 > pi 数据根 > 本机 code-lite 布局），
// 都不存在则禁用，身份保持「下游登录态透明传递」，行为与无池版本完全一致。
// 池状态独立落在 pi 数据根（冷却表不与 code-lite 桥共享），auth.json 槽位共用。
const ACCOUNT_HOMES = (() => {
  // 显式 CODEX_ACCOUNT_HOMES 不是目录时禁池并留痕，不回落本机布局：否则测试/异机的
  // "指向不存在目录=禁池"会静默变成"借用本机 code-lite 账号池"（2026-09-07 两个 e2e 因此误判）。
  const explicit = process.env.CODEX_ACCOUNT_HOMES;
  if (explicit) {
    try { if (fs.statSync(explicit).isDirectory()) return explicit; } catch { /* 不存在 */ }
    log(`账号池：CODEX_ACCOUNT_HOMES=${explicit} 不是目录，账号池禁用（显式配置不回落本机布局）`);
    return "";
  }
  const candidates = [
    path.join(PORTABLE_DATA, "homes"),
    path.join(os.homedir(), "Documents", "claude", "vscodium", "data", "code-lite", "homes"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch { /* 下一候选 */ }
  }
  return "";
})();
const accountPool = ACCOUNT_HOMES ? createAccountPool({
  homesRoot: ACCOUNT_HOMES,
  poolStateFile: path.join(PORTABLE_DATA, "account-pool.json"),
  pinStateFile: path.join(PORTABLE_DATA, "account-pool-pin.json"),
  connect: (host) => freshUpstreamSocket(currentEgress().port, host),
  log,
}) : null;

// primary 的 auth 文件由客户端负责刷新，池不会写它。保留最近一次真实下游身份仅供
// 只读额度查询，避免 primary 的磁盘 access token 过期后面板误报；凭据不落盘不打印。
let latestPrimaryIdentity = null;
function rememberDownstreamIdentity(headers) {
  const token = String(headers?.authorization || "").replace(/^Bearer\s+/iu, "").trim();
  if (!token || token.split(".").length !== 3) return;
  latestPrimaryIdentity = {
    token,
    accountId: String(headers?.["chatgpt-account-id"] || ""),
  };
}

function primaryUsageIdentity() {
  // 兼容当前双布局：轮转备用号在 data/code-lite/homes，而官方启动入口维护的
  // primary 在同一 vscodium 根的 homes/primary。只读且校验存在，不复制凭据。
  const candidates = [
    process.env.CODEX_PRIMARY_AUTH_FILE,
    ACCOUNT_HOMES ? path.resolve(ACCOUNT_HOMES, "..", "..", "..", "homes", "primary", "auth.json") : "",
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const identity = readAccountUsageIdentity(candidate);
      if (identity.token) return identity;
    } catch (error) {
      log(`primary 额度身份读取失败：${String(error?.message || error).slice(0, 80)}`);
    }
  }
  return latestPrimaryIdentity;
}

// 池身份注入：primary（useDownstream）沿用下游自带头；其余槽位替换两枚身份头。
// 槽位缺 account_id 时删除该头（残留下游 primary 的 id 会与新 token 串号）。
function withIdentity(headers, account) {
  if (!account || account.useDownstream) return headers;
  const swapped = { ...headers, authorization: `Bearer ${account.token}` };
  if (account.accountId) swapped["chatgpt-account-id"] = account.accountId;
  else delete swapped["chatgpt-account-id"];
  return swapped;
}

function drainBody(response, limit = 256 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      if (size < limit) { chunks.push(chunk); size += chunk.length; }
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

function decodeBodyText(raw, headers) {
  try {
    if (/gzip/i.test(String(headers?.["content-encoding"] || ""))) return zlib.gunzipSync(raw).toString("utf8");
  } catch { /* 解压失败按原文处理。 */ }
  return raw.toString("utf8");
}

function requestAccountUsage(identity) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: UPSTREAM_HOST,
      path: "/backend-api/wham/usage",
      method: "GET",
      agent: agentFor(currentEgress().port),
      headers: {
        Authorization: `Bearer ${identity.token}`,
        "chatgpt-account-id": identity.accountId || "",
        originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.147.0 (Windows 10.0.19045; x86_64)",
        Accept: "application/json",
      },
    }, async (response) => {
      const raw = await drainBody(response, 512 * 1024);
      if (response.statusCode !== 200) {
        const error = new Error(`usage HTTP ${response.statusCode || 0}`);
        error.statusCode = response.statusCode || 0;
        reject(error);
        return;
      }
      try { resolve(JSON.parse(decodeBodyText(raw, response.headers))); }
      catch { reject(new Error("usage response is not JSON")); }
    });
    request.once("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("usage request timed out")));
    request.end();
  });
}

const accountUsageMonitor = accountPool ? createAccountUsageMonitor({
  members: () => accountPool.members(),
  accountState: () => accountPool.snapshot(),
  requestUsage: requestAccountUsage,
  refreshMember: (member) => accountPool.refresh(member),
  identityOverride: (id) => id === "primary" ? primaryUsageIdentity() : null,
  cacheFile: path.join(PORTABLE_DATA, "account-usage-cache.json"),
  log,
}) : null;

// failover 环 drain 过的终态响应（全池 429/给不出可切账号）重建为可流式转发的
// 响应对象：统一给明文（下游转发层会删 content-encoding，不能再送压缩字节）。
function bufferedResponse(response, drained) {
  const gzipped = /gzip/i.test(String(response.headers?.["content-encoding"] || ""));
  const payload = gzipped ? Buffer.from(drained.text, "utf8") : drained.raw;
  const replay = Readable.from([payload]);
  replay.statusCode = response.statusCode;
  replay.headers = { ...response.headers, "content-length": String(payload.length) };
  delete replay.headers["content-encoding"];
  delete replay.headers["transfer-encoding"];
  replay.lopMeta = response.lopMeta;
  return replay;
}

function syntheticResponse(statusCode, payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const replay = Readable.from([payload]);
  replay.statusCode = statusCode;
  replay.headers = { "content-type": "application/json", "content-length": String(payload.length) };
  // 桥自造的终态,不是上游故障:状态码重试层据此跳过,避免对本地判定空转重试。
  replay.lopSynthetic = true;
  return replay;
}

function recordSseOverload(req, response, { attempt, maxRetries, delayMs = 0, error, exhausted, nextModel = "", kind = "sse-overload" }) {
  const meta = response?.lopMeta || {};
  const egress = meta.egress || currentEgress();
  const sse = kind === "sse-overload";
  recordMetric({
    ts: new Date().toISOString(),
    egressKey: egress.key || "",
    egressPort: egress.port || 0,
    originator: String(req.headers.originator || ""),
    status: response?.statusCode || 200,
    // sseStatus 保持"200 流内过载"的老语义;HTTP 状态码类另立 statusRetry,不改既有消费口径。
    ...(sse ? { sseStatus: 529 } : { statusRetry: true, upstreamStatus: Number(response?.statusCode || 0) }),
    retryKind: kind,
    errorKind: String(error?.code || (sse ? "server_is_overloaded" : "http_error")).slice(0, 60),
    overloadAttempt: attempt,
    overloadMaxRetries: maxRetries,
    overloadDelayMs: delayMs,
    overloadExhausted: Boolean(exhausted),
    requestedModel: String(meta.requestedModel || ""),
    attemptedModel: String(meta.upstreamModel || ""),
    nextModel: String(nextModel || ""),
    ttfbMs: Math.round(meta.ttfbMs || 0),
  });
}

// 请求策略:一次解压/解析,只做 GPT-5.6 的稳定 prompt_cache_key(+可选显式断点)。
// 无安全边界或解析失败时 fail-open 原样透传,绝不为了缓存命中率改变模型可见内容。

async function handleResponses(req, res) {
  rememberDownstreamIdentity(req.headers);
  let body = await readBody(req);
  let fwdHeaders = req.headers;
  const originalBytes = body.length;
  const rewritten = rewriteCodexRequestBody(body, req.headers, { explicitBreakpoint: EXPLICIT_BREAKPOINT });
  ({ body, headers: fwdHeaders } = rewritten);
  // 兼容剥离：ChatGPT codex 上游不认 max_output_tokens（"Unsupported parameter"，2026-08-28 实测），
  // pi/pi-web 等 responses 方言客户端会带上。桥统一剥掉，客户端保持原生不打补丁。
  // 摘要档位隔离：pi 的压缩摘要请求把固定系统提示放在 input[0]，只对它改 reasoning.effort；
  // 不记会话/账号/上一请求，普通轮次原样。判定与剥离共用同一次解析，避免第二次 JSON.parse。
  const wantsCompat = body.includes('"max_output_tokens"');
  const maybeSummary = SUMMARY_EFFORT !== "off" && body.includes(SUMMARIZATION_BODY_SIGNATURE);
  let summaryOverride = null;
  if (!rewritten.meta.parseFailed && (wantsCompat || maybeSummary)) {
    try {
      const compat = JSON.parse(body.toString("utf8"));
      let changed = false;
      if (compat.max_output_tokens !== undefined) {
        delete compat.max_output_tokens;
        changed = true;
        log(`兼容剥离：max_output_tokens originator=${req.headers.originator || "-"}`);
      }
      if (maybeSummary) {
        const outcome = applySummarizationEffort(compat, { effort: SUMMARY_EFFORT });
        if (outcome.applied) {
          changed = true;
          summaryOverride = outcome;
          log(`摘要请求 reasoning：${outcome.from}→${outcome.to} originator=${req.headers.originator || "-"}`);
        } else if (outcome.reason !== "not-summarization") {
          log(`摘要请求 reasoning 未改：${outcome.reason} originator=${req.headers.originator || "-"}`);
        }
      }
      if (changed) body = Buffer.from(JSON.stringify(compat));
    } catch (error) {
      log(`兼容/摘要解析失败，fail-open 原样透传：${String(error?.message || error).slice(0, 80)} originator=${req.headers.originator || "-"}`);
    }
  }
  if (rewritten.meta.cacheApplied) {
    const c = rewritten.meta.cache;
    const boundary = c.source === "instructions" ? "instructions"
      : `input[${c.itemIndex}].content[${c.blockIndex < 0 ? "string" : c.blockIndex}]`;
    log(`cache 注入：key=${c.key} breakpoint=${c.breakpointApplied ? "explicit" : "off"} boundary=${boundary} body=${originalBytes}B→${body.length}B originator=${req.headers.originator || "-"}`);
  } else if (rewritten.meta.parseFailed) {
    log(`cache/tier 解析失败，fail-open 原样透传 body=${originalBytes}B`);
  } else {
    // 不再用 CODEX_PROXY_DUMP 门控:key 注入静默失效曾隐藏两天(2026-08-31→09-01,
    // pi 的 input[0].content 是字符串形态,findStableBreakpoint 找不到 input_text 块)。
    log(`cache 未注入：${rewritten.meta.cache?.reason || "未命中策略"} originator=${req.headers.originator || "-"}`);
  }
  if (rewritten.meta.routingHeadersAdded?.length) {
    log(`cache 会话路由：headers=${rewritten.meta.routingHeadersAdded.join(",")} originator=${req.headers.originator || "-"}`);
  }
  if (process.env.CODEX_PROXY_DUMP === "1") {
    try {
      const j = JSON.parse(body.toString("utf8"));
      log(`body keys: ${Object.keys(j).join(",")}`);
      const shallow = {};
      for (const [k, v] of Object.entries(j)) {
        if (k === "input" || k === "instructions" || k === "tools") shallow[k] = `<${Array.isArray(v) ? v.length + " items" : typeof v}>`;
        else shallow[k] = v;
      }
      log("body: " + JSON.stringify(shallow).slice(0, 900));
    } catch { log("body 不是 JSON，长度 " + body.length); }
  }
  // 上行重压缩：每个候选模型只生成一次 body；fallback 只改顶层 model。
  const modelPlan = createModelFallbackPlan(body, {
    primaryModel: OVERLOAD_PRIMARY_MODEL,
    fallbackModels: OVERLOAD_FALLBACK_MODELS,
  });
  const preparedPayloads = new Map();
  const upstreamPayloadForAttempt = (attempt) => {
    const candidate = modelPlan.payloadForAttempt(attempt);
    const key = candidate.model || "__raw__";
    const cached = preparedPayloads.get(key);
    if (cached) return cached;
    let candidateBody = candidate.body;
    let candidateHeaders = fwdHeaders;
    let compressed = false;
    if (UPSTREAM_GZIP) {
      const encoded = compressUpstreamBody(candidateBody, candidateHeaders);
      compressed = encoded.compressed;
      ({ body: candidateBody, headers: candidateHeaders } = encoded);
    }
    const prepared = { ...candidate, body: candidateBody, headers: candidateHeaders, compressed };
    preparedPayloads.set(key, prepared);
    return prepared;
  };
  const initialPayload = upstreamPayloadForAttempt(0);
  if (initialPayload.compressed) log(`上行 gzip：${body.length}B→${initialPayload.body.length}B`);
  let activeUpRes = null;
  let clientClosed = false;
  // gate 等待中客户端也可能中止；立即停掉当前上游流，且不得继续退避重发。
  res.once("close", () => {
    clientClosed = true;
    if (activeUpRes && !activeUpRes.readableEnded) activeUpRes.destroy();
  });
  let selected;
  let totalIdentityAttempts = 0;
  let totalNetworkAttempts = 0;
  const accountsTried = [];
  try {
    selected = await requestWithOverloadRetry(async (attempt) => {
      const candidate = upstreamPayloadForAttempt(attempt);
      // 账号池 failover 与容量过载重试正交：本层管 HTTP 429/401 的身份切换，
      // overload 层管 200 SSE 内的过载事件；200 开始流式转发后不再切号。
      const outcome = await sendWithAccountFailover({
        pool: accountPool,
        headers: candidate.headers,
        send: (headers) => upstreamOnce(candidate.body, headers, true, () => { totalNetworkAttempts += 1; }),
        applyIdentity: withIdentity,
        drain: drainBody,
        decode: decodeBodyText,
        log,
      });
      totalIdentityAttempts += Number(outcome.attempts || 0);
      for (const id of outcome.accountsTried || []) accountsTried.push(String(id));
      activeUpRes = outcome.pinnedUnavailable
        ? syntheticResponse(429, { error: { type: "rate_limit_error", message: `已锁定账号 ${outcome.pinnedUnavailable.id} 且其当前不可用（${outcome.pinnedUnavailable.reason || "冷却中"}）。等待冷却结束、手动切号或恢复自动轮转。` } })
        : outcome.drained ? bufferedResponse(outcome.response, outcome.drained) : outcome.response;
      activeUpRes.lopMeta = activeUpRes.lopMeta || { startedAt: performance.now(), ttfbMs: 0, egress: { ...currentEgress() } };
      activeUpRes.lopMeta.requestedModel = modelPlan.primaryModel;
      activeUpRes.lopMeta.upstreamModel = candidate.model;
      activeUpRes.lopMeta.modelFallback = candidate.fallback;
      activeUpRes.lopMeta.upstreamAccount = String(outcome.account?.id || (accountPool ? "unavailable" : "downstream"));
      activeUpRes.lopMeta.upstreamAttempts = totalNetworkAttempts;
      activeUpRes.lopMeta.identityAttempts = totalIdentityAttempts;
      activeUpRes.lopMeta.accountsTried = [...accountsTried];
      activeUpRes.lopMeta.requestedTier = String(rewritten.meta.effectiveTier || "");
      return activeUpRes;
    }, {
      maxRetries: OVERLOAD_MAX_RETRIES,
      baseDelayMs: OVERLOAD_BASE_DELAY_MS,
      maxDelayMs: OVERLOAD_MAX_DELAY_MS,
      maxPrefixBytes: OVERLOAD_PREFIX_MAX_BYTES,
      statusRetry: STATUS_RETRY_ENABLED,
      shouldAbort: () => clientClosed,
      onRetry: ({ retryNumber, maxRetries, delayMs, error, response, kind }) => {
        const nextModel = modelPlan.payloadForAttempt(retryNumber).model;
        const what = kind === "http-status"
          ? `上游 5xx：status=${response.statusCode}`
          : `上游容量过载：code=${error.code}`;
        log(`${what} model=${response.lopMeta?.upstreamModel || "?"} next=${nextModel || "same"} bridgeRetry=${retryNumber}/${maxRetries} delay=${delayMs}ms`);
        recordSseOverload(req, response, {
          attempt: retryNumber,
          maxRetries,
          delayMs,
          error,
          exhausted: false,
          nextModel,
          kind,
        });
      },
      onExhausted: ({ attempts, overloadRetries, error, response, statusRetry: viaStatus }) => {
        const what = viaStatus ? `上游 5xx 重试耗尽：status=${response.statusCode}` : "上游容量过载重试耗尽：";
        log(`${what} model=${response.lopMeta?.upstreamModel || "?"} attempts=${attempts} retries=${overloadRetries}，原样透传最终响应`);
        recordSseOverload(req, response, {
          attempt: attempts,
          maxRetries: overloadRetries,
          error,
          exhausted: true,
          kind: viaStatus ? "http-status" : "sse-overload",
        });
      },
    });
  } catch (e) {
    if (clientClosed || e?.code === "CLIENT_CLOSED") {
      log("客户端在上游首个有效事件前关闭，取消容量重试");
      return;
    }
    log(`上游连接失败：${String(e.message).slice(0, 120)}`);
    // 失败也记账：guard 靠它识别「连接风暴型劣化」（成功流的 tok/s 看不见这种故障）。
    const egress = currentEgress();
    recordMetric({
      ts: new Date().toISOString(),
      egressKey: egress.key,
      egressPort: egress.port,
      originator: String(req.headers.originator || ""),
      status: 502,
      errorKind: String(e?.code || e?.message || "unknown").slice(0, 60),
    });
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(upstreamConnectionError(e)));
  }
  const upRes = selected.response;
  activeUpRes = upRes;
  const finalMeta = upRes.lopMeta || {};
  finalMeta.modelAttempts = Number(selected.attempts || 0);
  finalMeta.overloadRetries = Number(selected.overloadRetries || 0);
  const usedModelFallback = Boolean(finalMeta.requestedModel && finalMeta.upstreamModel && finalMeta.requestedModel !== finalMeta.upstreamModel);
  const out = { ...upRes.headers };
  delete out["content-encoding"];
  delete out["content-length"];
  delete out["transfer-encoding"];
  if (finalMeta.requestedModel) out["x-lop-requested-model"] = finalMeta.requestedModel;
  if (finalMeta.upstreamModel) out["x-lop-upstream-model"] = finalMeta.upstreamModel;
  if (finalMeta.upstreamAccount) out["x-lop-upstream-account"] = finalMeta.upstreamAccount;
  if (finalMeta.egress?.key) out["x-lop-egress-key"] = String(finalMeta.egress.key);
  if (finalMeta.egress?.port) out["x-lop-egress-port"] = String(finalMeta.egress.port);
  out["x-lop-upstream-attempts"] = String(finalMeta.upstreamAttempts || finalMeta.modelAttempts || 1);
  if (usedModelFallback) out["x-lop-model-fallback"] = "overload";
  res.writeHead(upRes.statusCode, out);
  // 客户端半途断开（pi 中止/页面刷新）：吞掉 error 防击穿，并停止继续拉上游流。
  res.on("error", (error) => log(`客户端响应流失败：${String(error?.message || error).slice(0, 120)}`));
  const chunks = [];
  const tail = createTailRing();
  let finished = false;
  const writeChunk = (chunk) => {
    const data = Buffer.from(chunk);
    chunks.push(data);
    tail.push(data);
    res.write(data);
  };
  const finishResponse = () => {
    if (finished) return;
    finished = true;
    res.end();
    // 流吞吐观测：真实 usage 来自 SSE 尾部的 response.completed，观测失败不影响转发。
    try {
      const meta = finalMeta;
      const usage = extractUsage(tail.text());
      const { streamMs, tokPerSec } = computeThroughput({
        firstByteAt: meta.startedAt + meta.ttfbMs,
        endAt: performance.now(),
        outputTokens: usage.outputTokens,
      });
      const record = {
        ts: new Date().toISOString(),
        egressKey: meta.egress?.key || "",
        egressPort: meta.egress?.port || 0,
        originator: String(req.headers.originator || ""),
        status: upRes.statusCode,
        ttfbMs: Math.round(meta.ttfbMs || 0),
        streamMs,
        bytes: tail.totalBytes,
        outTok: usage.outputTokens,
        reasTok: usage.reasoningTokens,
        inTok: usage.inputTokens,
        cachedTok: usage.cachedInputTokens,
        tokPerSec,
        requestedModel: meta.requestedModel || "",
        upstreamModel: meta.upstreamModel || "",
        upstreamAccount: meta.upstreamAccount || "",
        upstreamAttempts: Number(meta.upstreamAttempts || meta.modelAttempts || 1),
        identityAttempts: Number(meta.identityAttempts || 1),
        modelAttempts: Number(meta.modelAttempts || 1),
        overloadRetries: Number(meta.overloadRetries || 0),
        modelFallback: Boolean(meta.modelFallback),
        requestedTier: meta.requestedTier || "",
        upstreamTier: usage.serviceTier || "",
        reasoningOverride: summaryOverride ? `summary:${summaryOverride.from}->${summaryOverride.to}` : "",
      };
      log(`流吞吐：model=${record.requestedModel || "?"}${record.modelFallback ? `→${record.upstreamModel}` : ""} account=${record.upstreamAccount || "?"} attempts=${record.upstreamAttempts} egress=${record.egressKey || "?"}:${record.egressPort} tier=${record.requestedTier || "-"}→${record.upstreamTier || "?"} ttfb=${record.ttfbMs}ms stream=${streamMs}ms outTok=${usage.outputTokens ?? "-"} reas=${usage.reasoningTokens ?? "-"} tok/s=${tokPerSec ?? "-"}`);
      // priority 额度是否被授予只能从吞吐判(2026-09-02 实测:同分钟 A/B priority 47-57 vs default 27
      // tok/s;但 46-49 tok/s 的快请求回显也是 "default",回显不可作降级证据)。回显不一致仍
      // 无条件留痕,措辞只陈述事实,不断言降级。
      if (record.requestedTier && record.upstreamTier && record.requestedTier !== record.upstreamTier) {
        log(`tier 回显不一致：请求 ${record.requestedTier} → 上游回显 ${record.upstreamTier}（是否实际降级以 tok/s 为准）originator=${record.originator || "-"}`);
      }
      recordMetric(record);
    } catch { /* 观测永不阻断转发 */ }
  };
  for (const chunk of selected.prefixChunks) writeChunk(chunk);
  if (upRes.readableEnded) {
    finishResponse();
    return;
  }
  upRes.on("data", writeChunk);
  upRes.once("end", finishResponse);
  upRes.once("error", (error) => {
    log(`上游响应流失败：${String(error?.message || error).slice(0, 120)}`);
    res.destroy(error);
  });
  upRes.resume();
}

const lifecycle = createRequestLifecycle({
  log,
  stop: () => {
    accountUsageMonitor?.stop();
    server.close(() => process.exit(0));
  },
});
const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  // 进来的每一条都记：客户端打哪个路径、带什么 originator，是排障的第一手事实。
  if (url !== "/health") log(`<- ${req.method} ${req.url} originator=${req.headers.originator || "-"}`);

  if (url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, port: PORT, pid: process.pid, policyVersion: POLICY_VERSION,
      transportErrorVersion: TRANSPORT_ERROR_VERSION,
      lifecycle: lifecycle.snapshot(),
      explicitBreakpoint: EXPLICIT_BREAKPOINT,
      forceReasoningEffort: "off",
      summaryEffort: SUMMARY_EFFORT,
      modelsClientVersion: process.env.CODEX_MODELS_CLIENT_VERSION || DEFAULT_CODEX_MODELS_CLIENT_VERSION,
      authMode: accountPool ? "account-pool" : "codex-login-pass-through",
      accountHomes: ACCOUNT_HOMES || null,
      accounts: accountPool ? accountPool.snapshot() : [],
      upstreamProxy: egressLabelOf(currentEgress().port),
      followSystemProxy,
      upstreamAgent: { maxSockets: 16, maxFreeSockets: 8 },
      upstreamGzip: UPSTREAM_GZIP,
      retryOwner: "bridge",
      connectRetry: { timeoutMs: CONNECT_TIMEOUT_MS, retries: CONNECT_RETRIES, delayMs: CONNECT_RETRY_DELAY_MS },
      egressFallback: { ports: egressCandidates(currentEgress().port), afterMs: EGRESS_FALLBACK_AFTER_MS },
      overloadRetry: {
        maxRetries: OVERLOAD_MAX_RETRIES,
        baseDelayMs: OVERLOAD_BASE_DELAY_MS,
        maxDelayMs: OVERLOAD_MAX_DELAY_MS,
        maxPrefixBytes: OVERLOAD_PREFIX_MAX_BYTES,
        primaryModel: OVERLOAD_PRIMARY_MODEL,
        fallbackModels: OVERLOAD_FALLBACK_MODELS,
        statusRetry: STATUS_RETRY_ENABLED,
        statusRetryCodes: [...RETRYABLE_UPSTREAM_STATUS],
      },
      egress: currentEgress(),
      metricsFile: METRICS_FILE,
    }));
  }

  if (url === "/admin/shutdown-if-idle" && req.method === "POST") {
    return lifecycle.shutdownIfIdle(req, res);
  }

  // 账号池控制面（仅本机回环，即时切号/看池状态，无需下游登录头）。
  if (url === "/accounts" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, enabled: Boolean(accountPool), accounts: accountPool ? accountPool.snapshot() : [] }));
  }
  if (url === "/account-usage" && req.method === "GET") {
    try {
      const force = new URL(req.url || "/account-usage", `http://${HOST}:${PORT}`).searchParams.get("refresh") === "1";
      if (accountUsageMonitor) void accountUsageMonitor.refreshIfDue(force);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(accountUsageMonitor?.snapshot() || {
        ok: true, enabled: false, refreshing: false, modelTokensConsumed: 0, accounts: [],
      }));
    } catch (error) {
      log(`账号额度接口失败：${String(error?.message || error).slice(0, 120)}`);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "账号额度服务暂不可用", accounts: [] }));
    }
  }
  if (url === "/account/select" && req.method === "POST") {
    if (!accountPool) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "账号池未启用" }));
    }
    // 要求 JSON content-type：浏览器跨域发不出这种「非简单请求」（会先被预检拦下），
    // 网页无法盲打本回环端点切号。
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
      res.writeHead(415, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "需要 Content-Type: application/json" }));
    }
    let id;
    try { id = String(JSON.parse((await drainBody(req, 4096)).toString("utf8"))?.id || ""); }
    catch { id = ""; }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "账号 id 无效" }));
    }
    const result = accountPool.select(id);
    const responseBody = result.ok && accountUsageMonitor
      ? { ...result, accounts: accountUsageMonitor.snapshot().accounts }
      : result;
    res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(responseBody));
  }

  if (!lifecycle.admit(res)) return;
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!bearer) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "缺少 Codex 登录 token" } }));
  }

  // codex 启动时探 /v1/models 刷新可用模型列表。它要的是 {"models":[...]}，不是 OpenAI 的
  // {"object":"list","data":[...]}——静态拼一份会报 missing field `models`（2026-08-19 实测）。
  // 通用 OpenAI 客户端不会传必填 client_version，桥补前向能力版本；响应若是 gzip，
  // 必须连同 content-encoding 原样转发，不能把压缩字节伪装成 JSON 明文。
  if (url === "/v1/models" && req.method === "GET") {
    rememberDownstreamIdentity(req.headers);
    try {
      const upRes = await upstreamGet(codexModelsUpstreamPath(req.url), req.headers);
      res.writeHead(upRes.statusCode, modelCatalogResponseHeaders(upRes.headers));
      res.on("error", (error) => log(`models 响应流失败：${String(error?.message || error).slice(0, 120)}`));
      return upRes.pipe(res);
    } catch (e) {
      log("models 转发失败：" + String(e.message).slice(0, 80));
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(upstreamConnectionError(e)));
    }
  }

  // Pi 的原生 openai-codex adapter 使用 /v1/codex/responses；保留旧
  // /v1/responses 别名让历史 codex-bridge 会话继续运行。
  if ((url === "/v1/responses" || url === "/v1/codex/responses") && req.method === "POST") {
    try { return await handleResponses(req, res); }
    catch (e) {
      log("处理失败：" + String(e.message).slice(0, 120));
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: String(e.message).slice(0, 200) } }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "只支持 POST /v1/responses" } }));
});

server.listen(PORT, HOST, () => {
  log(`listening http://${HOST}:${PORT}`);
  log(`策略：${POLICY_VERSION}，explicit breakpoint=${EXPLICIT_BREAKPOINT ? "on" : "off（当前 ChatGPT 后端不支持）"}`);
  log(`推理强度：透传会话请求值（桥不改写）`);
  log(`上游连接：keep-alive maxSockets=16 maxFreeSockets=8；上行 gzip=${UPSTREAM_GZIP ? "on" : "off"}`);
  log(`连接层重试：CONNECT/TLS 单次超时 ${CONNECT_TIMEOUT_MS}ms，失败最多重试 ${CONNECT_RETRIES} 次（退避 ${CONNECT_RETRY_DELAY_MS}ms×n），CODEX_CONNECT_RETRIES=0 关闭`);
  log(systemProxyFollower?.snapshot()
    ? "出口跟随：Windows 系统代理，每 5 秒刷新；不使用历史端口或备用代理"
    : EGRESS_FALLBACK_PORTS.length
      ? `出口回退：主出口 ${EGRESS_FALLBACK_AFTER_MS}ms 未建立即并行尝试备用 ${EGRESS_FALLBACK_PORTS.map(port => egressLabelOf(port)).join("→")}（与主出口去重，先通者用，逐连接决策）`
      : "出口回退：已由 CODEX_EGRESS_FALLBACK_PORTS 空值关闭");
  log(`摘要推理档位：${SUMMARY_EFFORT}（只对 input[0] 为 pi 压缩摘要提示的请求生效，普通轮次原样透传）`);
  log(`容量过载保护：首个有效 SSE 前 ${OVERLOAD_PRIMARY_MODEL}→${OVERLOAD_FALLBACK_MODELS.join("→") || "same-model"}，最多重试 ${OVERLOAD_MAX_RETRIES} 次，退避 ${OVERLOAD_BASE_DELAY_MS}-${OVERLOAD_MAX_DELAY_MS}ms，prefix 上限 ${OVERLOAD_PREFIX_MAX_BYTES}B`);
  log(STATUS_RETRY_ENABLED
    ? `上游 5xx 退避重试：状态码 ${[...RETRYABLE_UPSTREAM_STATUS].join("/")} 与过载共用同一重试预算(429/401 归账号池层)`
    : "上游 5xx 退避重试：已由 CODEX_STATUS_RETRY=0 关闭，5xx 原样透传");
  const bootEgress = currentEgress();
  const poolLabel = accountPool
    ? `账号池 ${ACCOUNT_HOMES}（${accountPool.members().map((m) => m.id).join(",") || "空"}；429/401 冷却→切号→重发）`
    : "Codex 官方登录透明传递";
  log(`身份：${poolLabel}；出口跟随 ${EGRESS_STATE_FILE}（当前 ${bootEgress.key}:${bootEgress.port}，缺省 ${UPSTREAM_PROXY_HOST}:${UPSTREAM_PROXY_PORT}）`);
  if (accountPool) {
    // 凭据保鲜：长期闲置的备用账号在轮转需要它时一定可用（primary 归客户端自己管）。
    const keepFresh = () => accountPool.refreshExpiring().catch((e) => log(`凭据保鲜失败：${String(e?.message || e).slice(0, 80)}`));
    setTimeout(keepFresh, 30_000).unref();
    setInterval(keepFresh, 4 * 60 * 60_000).unref();
    accountUsageMonitor.start();
  }
  log(`流吞吐观测：SSE 尾部真实 usage → ${METRICS_FILE}`);
});

server.on("close", () => { accountUsageMonitor?.stop(); systemProxyFollower?.stop(); });
