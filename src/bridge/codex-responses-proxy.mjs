// Codex（VS Code / VSCodium 扩展、codex CLI）的透明请求策略代理。
//
// 链路：Codex 扩展 --(codex 原生 responses)--> 本进程 :8794
//       --(保留 Codex 官方登录身份 + 注入请求策略)-->
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
import { ExactResponseMemo } from "./codex-response-memo.mjs";
import { computeThroughput, createTailRing, extractUsage } from "./codex-stream-metrics.mjs";
import { createModelFallbackPlan, requestWithOverloadRetry } from "./codex-overload-retry.mjs";
import { createAccountPool, sendWithAccountFailover } from "./account-pool.mjs";

const PORT = Number(process.env.CODEX_PROXY_PORT || 8794);
const HOST = "127.0.0.1";
const LOG_FILE = path.join(PORTABLE_DATA, "codex-responses-proxy.log");
const UPSTREAM_HOST = "chatgpt.com";
const UPSTREAM_PATH = "/backend-api/codex/responses";
const UPSTREAM_PROXY_HOST = process.env.CODEX_UPSTREAM_PROXY_HOST || "127.0.0.1";
const UPSTREAM_PROXY_PORT = Number(process.env.CODEX_UPSTREAM_PROXY_PORT || 0); // [portable] 0=直连
const EXPLICIT_BREAKPOINT = process.env.CODEX_CACHE_EXPLICIT_BREAKPOINT === "1";
const HISTORY_REPLAY_EFFORT = process.env.CODEX_HISTORY_REPLAY_EFFORT || "max";
// v7.15.0:撤销全请求强制 reasoning=max(08-30 引入)。强度完全由会话控制——pi 会话对
// gpt-5.6-sol 默认已是 max(settings.modelThinkingLevels),桥强制只会掩盖会话真实设置。
// v7.16.0:cache 注入修复——边界兼容 pi 字符串形态系统提示(key-only,blockIndex=-1),
// key 掺首条 user 项摘要实现并发会话分键(单会话恒定、并发互异)。
const RESPONSE_MEMO_TTL_MS = Number(process.env.CODEX_RESPONSE_MEMO_TTL_MS || 600000);
// v7.17.0:流指标记录 requestedTier→upstreamTier,priority 静默降级无条件落日志。
// v7.18.0:persistence 证据规则改"重定向落盘 + 只手写结论",配合 launcher BASH_ENV 预加载 helper。
const POLICY_VERSION = "gpt56-chain-replay-v7.18.0";
const UPSTREAM_GZIP = process.env.CODEX_UPSTREAM_GZIP !== "0";
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const OVERLOAD_MAX_RETRIES = Math.trunc(numberEnv("CODEX_OVERLOAD_MAX_RETRIES", 3));
const OVERLOAD_BASE_DELAY_MS = numberEnv("CODEX_OVERLOAD_BASE_DELAY_MS", 1200);
const OVERLOAD_MAX_DELAY_MS = numberEnv("CODEX_OVERLOAD_MAX_DELAY_MS", 8000);
const OVERLOAD_PREFIX_MAX_BYTES = Math.max(1024, numberEnv("CODEX_OVERLOAD_PREFIX_MAX_BYTES", 256 * 1024));
const OVERLOAD_PRIMARY_MODEL = process.env.CODEX_OVERLOAD_PRIMARY_MODEL || "gpt-5.6-sol";
const OVERLOAD_FALLBACK_MODELS = (process.env.CODEX_OVERLOAD_FALLBACK_MODELS ?? "gpt-5.6-terra,gpt-5.6-luna,gpt-reserve")
  .split(",").map((model) => model.trim()).filter(Boolean);
// persistence 注入:Codex 官方 prompt(codex-rs/core/gpt_5_2_prompt.md)的 Autonomy and
// Persistence 段原文。gpt-5.x 按这份提示训练对齐"不提前收尾";pi 等 responses 方言
// 客户端的 instructions 缺该段,同模型在 pi 壳里就会出现"承诺后 stop/如实汇报未达标
// 后停轮"。幂等判定用官方原文特征串,codex CLI 自带官方提示的流量自动跳过。
// 可用 CODEX_PROXY_PERSISTENCE=0 关闭。
const PERSISTENCE_INJECT = process.env.CODEX_PROXY_PERSISTENCE !== "0";
const PERSISTENCE_MARK = "keep going until the query or task is completely resolved";
const PERSISTENCE_APPENDIX = [
  "",
  "## Autonomy and Persistence",
  "You must keep going until the query or task is completely resolved, before ending your turn and yielding back to the user. Persist until the task is fully handled end-to-end within the current turn whenever feasible and persevere even when function calls fail. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer.",
  "Do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.",
  "If the user states an explicit acceptance target (for example a numeric threshold, all tests passing, or a delivery gate), treat the task as unresolved until that target is verifiably met, or until you have concrete evidence it is unreachable under the stated constraints; in that case report the quantified gap instead of silently stopping.",
  // 最高优先级输出规则(2026-09-01,lop 裁决):证据落盘,正文只留结论。放在清单纪律
  // 之前,优先级最高。
  // v7.18.0:证据文件由执行时重定向生成(pi 预加载 helper ev),禁止 write/edit 复述工具输出——
  // 2026-09-02 实录:单会话把 5K 字符工具输出重打进证据文件,default 档 27 tok/s 下纯浪费。
  "Highest-priority output rule: evidence goes to files, reply bodies carry conclusions only. The evidence file (default acceptance-evidence.md in the task workspace, one timestamped section per task) is produced at execution time by redirection: run verification commands through the preloaded shell helper `ev <cmd...>` (or append with `>> acceptance-evidence.md`), which stores the full output in the file and echoes only the tail. Never re-type command outputs, logs, tables or hash lists into the evidence file via write/edit; hand-write only per-item conclusion lines there. Keep only per-item one-line conclusions, key numbers, and the evidence file path in the reply body. Never fake brevity by dropping evidence: evidence must exist on disk and be auditable.",
  // 清单纪律 v13(增量协议):与 lop-chain 门构成闭环——host 持久记账 done 状态,
  // 模型只声明变化;首份完整清单仅出现一次并落盘。codex CLI 流量 MARK 命中跳过注入。
  "For any request that requires actions or changes (not a pure question), begin your first reply with an acceptance checklist: the line 【验收清单】 followed by '- [ ] <item>' lines covering each verifiable acceptance criterion of the task. This first checklist is a frozen acceptance contract; also record it into the evidence file. Do not restate the full checklist in later replies: the host tracks item states persistently. Only declare state changes, using a small 【验收清单】 block listing just the changed items — '- [x] <exact item wording>' when an item newly completes with verifiable evidence, '- [ ] <exact item wording>' to reopen one; unchanged items must not be repeated. Only two item states are valid: '- [ ]' means incomplete and '- [x]' means completed with verifiable evidence. Never use '[~]' or any third state. Do not add, rename, merge, or shrink contract items. If blocked, leave the item incomplete and report concrete blocker evidence. Never end your turn while any item remains incomplete. If the user says to continue, or sets an until/not-until acceptance target, a checked item saying the target was not met, delivery was prohibited, or the task remains open is not completion; keep the terminal-outcome item unchecked until there is positive attainment evidence.",
  // 完成态折叠:与 lop-chain collapsedAcceptanceChecklist 严格对齐(N/N 必须等于
  // 冻结合同项数)。
  "Once every item in the frozen contract is complete with verifiable evidence, finish with the single line 【验收清单】N/N 全部完成 where N is the exact number of frozen contract items, instead of any itemized checklist.",
  "Host-verified deterministic exception: when the request context contains both <deterministic-current-evidence> and <deterministic-final-draft verified=\"true\">, the host has already completed and verified the bounded action. Do not call any tool, do not emit an acceptance checklist, and output the supplied deterministic final draft exactly. This exception never applies without both tags.",
].join("\n");

function appendPersistence(body) {
  if (!PERSISTENCE_INJECT) return { body, applied: false };
  try {
    const j = JSON.parse(body.toString("utf8"));
    // 形态1:codex CLI——顶层 instructions 字符串(自带官方提示,MARK 命中即跳过)。
    if (typeof j.instructions === "string") {
      if (j.instructions.includes(PERSISTENCE_MARK)) return { body, applied: false };
      j.instructions += "\n" + PERSISTENCE_APPENDIX;
      return { body: Buffer.from(JSON.stringify(j)), applied: true, target: "instructions" };
    }
    // 形态2:pi 等 responses 方言——系统提示在 input[0] 的 developer/system message,
    // content 为字符串(pi-ai 序列化实测,2026-08-29)。
    const first = Array.isArray(j.input) ? j.input[0] : null;
    if (first && (first.role === "developer" || first.role === "system") && typeof first.content === "string") {
      if (first.content.includes(PERSISTENCE_MARK)) return { body, applied: false };
      first.content += "\n" + PERSISTENCE_APPENDIX;
      return { body: Buffer.from(JSON.stringify(j)), applied: true, target: `input[0].${first.role}` };
    }
    return { body, applied: false };
  } catch {
    return { body, applied: false }; // 非明文 JSON:保持原样,fail-open
  }
}
// 出口跟随：可选的出口选择状态文件（外部工具写入）。缺失/损坏时保持上次值，
// 最终回退环境默认（未设 CODEX_UPSTREAM_PROXY_PORT 即直连），fail-open 不断流。
const EGRESS_STATE_FILE = process.env.CODEX_EGRESS_STATE_FILE || path.join(PORTABLE_DATA, "active-egress.json");
const METRICS_FILE = path.join(PORTABLE_DATA, "proxy-metrics.jsonl");
const responseMemo = new ExactResponseMemo({ ttlMs: RESPONSE_MEMO_TTL_MS });
const replayDiagnostics = new Map();

function log(...args) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${args.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch {}
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

let egressCache = { at: 0, key: "env-default", port: UPSTREAM_PROXY_PORT };
function currentEgress() {
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
    }
  } catch { /* 状态文件缺失或损坏：保持上次值 */ }
  return egressCache;
}

function freshUpstreamSocket(proxyPort, host = UPSTREAM_HOST) {
  // [portable] 直连模式:无本机 CONNECT 代理时直接 TLS 到上游(换机默认路径)
  if (!proxyPort) {
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] });
      secure.setTimeout(10000, () => secure.destroy(new Error("直连 TLS 超时 10s")));
      secure.once("secureConnect", () => { secure.setTimeout(0); resolve(secure); });
      secure.once("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: UPSTREAM_PROXY_HOST,
      port: proxyPort,
      method: "CONNECT",
      path: `${host}:443`,
      headers: { Host: `${host}:443` },
    });
    connect.setTimeout(10000, () => connect.destroy(new Error("CONNECT 超时 10s")));
    connect.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`CONNECT 返回 ${res.statusCode}`));
      }
      if (head?.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
      secure.once("secureConnect", () => resolve(secure));
      secure.once("error", reject);
    });
    connect.once("error", reject);
    connect.end();
  });
}

// 单会话内 Responses 是串行流，但现在多会话并发是常态（mobile-bridge 并发会话）。
// maxSockets=2 时第 3 个及以后的请求在本地排队：2026-08-27 实测 21 次 >30s TTFB
// 全部发生在并发窗口（含一次 GET /v1/models 44.6s），fresh socket 均值 17.9s vs
// 复用 1.9s。放宽到 16 并发 + 8 条保温空闲连接；上游主动关闭时 Agent 透明重建。
// 三类出口各持独立 Agent：切换出口不打断旧出口上的在途流，各自保温。
const upstreamAgents = new Map();
function agentFor(proxyPort) {
  let agent = upstreamAgents.get(proxyPort);
  if (agent) return agent;
  agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 16,
    maxFreeSockets: 8,
    scheduling: "lifo",
  });
  agent.createConnection = (_options, callback) => {
    freshUpstreamSocket(proxyPort).then(
      (socket) => callback(null, socket),
      (error) => callback(error),
    );
  };
  upstreamAgents.set(proxyPort, agent);
  return agent;
}

function upstreamOnce(body, headers, allowRetry = true) {
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
      upRes.lopMeta = { startedAt: started, ttfbMs, egress: { ...egress } };
      log(`-> POST ${upRes.statusCode} ttfbMs=${ttfbMs.toFixed(1)} reusedSocket=${req.reusedSocket ? "yes" : "no"} egress=${egress.port}`);
      resolve(upRes);
    });
    // 首包前的连接层错误（保温竞态、节点瞬时 reset、CONNECT 失败）一律换新连接
    // 重发一次——未收到任何响应字节意味着请求未被上游处理，重发语义安全；
    // 已开始响应的失败绝不重发。持续性风暴由 proxy-guard 按失败记账切换出口。
    const RETRYABLE = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ECONNABORTED"]);
    req.on("error", (error) => {
      if (allowRetry && !responded && RETRYABLE.has(String(error?.code || ""))) {
        log(`首包前连接错误（${error.code}，reused=${req.reusedSocket ? "yes" : "no"}），换新连接重试一次`);
        setTimeout(() => resolve(upstreamOnce(body, headers, false)), 500);
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
      log(`-> GET ${upRes.statusCode} ttfbMs=${(performance.now() - started).toFixed(1)} reusedSocket=${req.reusedSocket ? "yes" : "no"} egress=${egress.port}`);
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
  const candidates = [
    process.env.CODEX_ACCOUNT_HOMES,
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
  return replay;
}

function recordSseOverload(req, response, { attempt, maxRetries, delayMs = 0, error, exhausted, nextModel = "" }) {
  const meta = response?.lopMeta || {};
  const egress = meta.egress || currentEgress();
  fs.appendFile(METRICS_FILE, JSON.stringify({
    ts: new Date().toISOString(),
    egressKey: egress.key || "",
    egressPort: egress.port || 0,
    originator: String(req.headers.originator || ""),
    status: response?.statusCode || 200,
    sseStatus: 529,
    errorKind: String(error?.code || "server_is_overloaded").slice(0, 60),
    overloadAttempt: attempt,
    overloadMaxRetries: maxRetries,
    overloadDelayMs: delayMs,
    overloadExhausted: Boolean(exhausted),
    requestedModel: String(meta.requestedModel || ""),
    attemptedModel: String(meta.upstreamModel || ""),
    nextModel: String(nextModel || ""),
    ttfbMs: Math.round(meta.ttfbMs || 0),
  }) + "\n", () => {});
}

// 请求策略注入：一次解压/解析应用可选 Tier 兜底，以及 GPT-5.6 的稳定 key + 显式断点。
// Tier 缺省为 off：请求未选择时不注入，交给上游；请求已带 service_tier 时永不覆盖。
// 断点只放在动态 environment/history/user 之前的 developer 块；无安全边界或解析失败时
// fail-open 原样透传，绝不为了缓存命中率改变模型可见内容。
const TIER = process.env.CODEX_PROXY_TIER || "off";

async function handleResponses(req, res) {
  let body = await readBody(req);
  let fwdHeaders = req.headers;
  // persistence 先于 rewrite:缓存/重放 key 必须基于注入后的真实 body 计算。
  const persistence = appendPersistence(body);
  if (persistence.applied) {
    log(`persistence 注入：${persistence.target} +${persistence.body.length - body.length}B originator=${req.headers.originator || "-"}`);
    body = persistence.body;
  }
  const originalBytes = body.length;
  const rewritten = rewriteCodexRequestBody(body, req.headers, {
    tier: TIER,
    explicitBreakpoint: EXPLICIT_BREAKPOINT,
    historyReplayEffort: HISTORY_REPLAY_EFFORT,
  });
  ({ body, headers: fwdHeaders } = rewritten);
  // 兼容剥离：ChatGPT codex 上游不认 max_output_tokens（"Unsupported parameter"，2026-08-28 实测），
  // pi/pi-web 等 responses 方言客户端会带上。桥统一剥掉，客户端保持原生不打补丁。
  if (!rewritten.meta.parseFailed && body.includes('"max_output_tokens"')) {
    try {
      const compat = JSON.parse(body.toString("utf8"));
      if (compat.max_output_tokens !== undefined) {
        delete compat.max_output_tokens;
        body = Buffer.from(JSON.stringify(compat));
        log(`兼容剥离：max_output_tokens originator=${req.headers.originator || "-"}`);
      }
    } catch { /* 非明文 JSON：保持原样 */ }
  }
  if (rewritten.meta.cacheApplied) {
    const c = rewritten.meta.cache;
    log(`cache 注入：key=${c.key} breakpoint=${c.breakpointApplied ? "explicit" : "off"} boundary=input[${c.itemIndex}].content[${c.blockIndex < 0 ? "string" : c.blockIndex}] body=${originalBytes}B→${body.length}B originator=${req.headers.originator || "-"}`);
  } else if (rewritten.meta.parseFailed) {
    log(`cache/tier 解析失败，fail-open 原样透传 body=${originalBytes}B`);
  } else {
    // 不再用 CODEX_PROXY_DUMP 门控:key 注入静默失效曾隐藏两天(2026-08-31→09-01,
    // pi 的 input[0].content 是字符串形态,findStableBreakpoint 找不到 input_text 块)。
    log(`cache 未注入：${rewritten.meta.cache?.reason || "未命中策略"} originator=${req.headers.originator || "-"}`);
  }
  if (rewritten.meta.tierApplied) {
    log(`tier 兜底：service_tier=${rewritten.meta.effectiveTier} originator=${req.headers.originator || "-"}`);
  } else if (rewritten.meta.tierSource === "request") {
    log(`tier 透传：service_tier=${rewritten.meta.effectiveTier} originator=${req.headers.originator || "-"}`);
  }
  if (rewritten.meta.reasoningApplied) {
    log(`history 快路：reasoning ${rewritten.meta.reasoning.from || "default"}→${rewritten.meta.reasoning.to}`);
  } else if (rewritten.meta.reasoning?.reason === "tool-failure-escalation") {
    log(`history 快路升级：检测到工具失败，保持 reasoning=${rewritten.meta.reasoning.from || "default"}`);
  } else if (rewritten.meta.reasoning?.reason === "history-first-request-complete") {
    log(`history 快路结束：仅首个模型请求使用 ${HISTORY_REPLAY_EFFORT}，后续保持 reasoning=${rewritten.meta.reasoning.from || "default"}`);
  }
  const replay = rewritten.meta.replay;
  if (replay?.enabled) {
    const hit = responseMemo.get(replay.key, replay.usageToken);
    if (hit) {
      log(`response memo HIT key=${replay.key.slice(0, 16)} bytes=${hit.body.length} entries=${responseMemo.size}`);
      res.writeHead(hit.statusCode, hit.headers);
      return res.end(hit.body);
    }
    log(`response memo MISS key=${replay.key.slice(0, 16)} entries=${responseMemo.size}`);
    if (replay.groupKey) {
      const previous = replayDiagnostics.get(replay.groupKey);
      if (previous) {
        const components = Object.keys({ ...previous.componentHashes, ...replay.componentHashes })
          .filter((name) => previous.componentHashes?.[name] !== replay.componentHashes?.[name]);
        const input = Array.from({ length: Math.max(previous.inputHashes.length, replay.inputHashes.length) }, (_, index) => index)
          .filter((index) => previous.inputHashes[index] !== replay.inputHashes[index]);
        log(`response memo DRIFT components=${components.join(",") || "-"} input=${input.join(",") || "-"}`);
      }
      replayDiagnostics.set(replay.groupKey, replay);
    }
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
  try {
    selected = await requestWithOverloadRetry(async (attempt) => {
      const candidate = upstreamPayloadForAttempt(attempt);
      // 账号池 failover 与容量过载重试正交：本层管 HTTP 429/401 的身份切换，
      // overload 层管 200 SSE 内的过载事件；200 开始流式转发后不再切号。
      const outcome = await sendWithAccountFailover({
        pool: accountPool,
        headers: candidate.headers,
        send: (headers) => upstreamOnce(candidate.body, headers),
        applyIdentity: withIdentity,
        drain: drainBody,
        decode: decodeBodyText,
        log,
      });
      activeUpRes = outcome.pinnedUnavailable
        ? syntheticResponse(429, { error: { type: "rate_limit_error", message: `已锁定账号 ${outcome.pinnedUnavailable.id} 且其当前不可用（${outcome.pinnedUnavailable.reason || "冷却中"}）。等待冷却结束、手动切号或恢复自动轮转。` } })
        : outcome.drained ? bufferedResponse(outcome.response, outcome.drained) : outcome.response;
      activeUpRes.lopMeta = activeUpRes.lopMeta || { startedAt: performance.now(), ttfbMs: 0, egress: { ...currentEgress() } };
      activeUpRes.lopMeta.requestedModel = modelPlan.primaryModel;
      activeUpRes.lopMeta.upstreamModel = candidate.model;
      activeUpRes.lopMeta.modelFallback = candidate.fallback;
      activeUpRes.lopMeta.requestedTier = String(rewritten.meta.effectiveTier || "");
      return activeUpRes;
    }, {
      maxRetries: OVERLOAD_MAX_RETRIES,
      baseDelayMs: OVERLOAD_BASE_DELAY_MS,
      maxDelayMs: OVERLOAD_MAX_DELAY_MS,
      maxPrefixBytes: OVERLOAD_PREFIX_MAX_BYTES,
      shouldAbort: () => clientClosed,
      onRetry: ({ retryNumber, maxRetries, delayMs, error, response }) => {
        const nextModel = modelPlan.payloadForAttempt(retryNumber).model;
        log(`上游容量过载：code=${error.code} model=${response.lopMeta?.upstreamModel || "?"} next=${nextModel || "same"} bridgeRetry=${retryNumber}/${maxRetries} delay=${delayMs}ms`);
        recordSseOverload(req, response, {
          attempt: retryNumber,
          maxRetries,
          delayMs,
          error,
          exhausted: false,
          nextModel,
        });
      },
      onExhausted: ({ attempts, overloadRetries, error, response }) => {
        log(`上游容量过载重试耗尽：model=${response.lopMeta?.upstreamModel || "?"} attempts=${attempts} retries=${overloadRetries}，原样透传最终 SSE`);
        recordSseOverload(req, response, {
          attempt: attempts,
          maxRetries: overloadRetries,
          error,
          exhausted: true,
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
    fs.appendFile(METRICS_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      egressKey: egress.key,
      egressPort: egress.port,
      originator: String(req.headers.originator || ""),
      status: 502,
      errorKind: String(e?.code || e?.message || "unknown").slice(0, 60),
    }) + "\n", () => {});
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "上游连接失败" } }));
  }
  const upRes = selected.response;
  activeUpRes = upRes;
  const finalMeta = upRes.lopMeta || {};
  const usedModelFallback = Boolean(finalMeta.requestedModel && finalMeta.upstreamModel && finalMeta.requestedModel !== finalMeta.upstreamModel);
  const out = { ...upRes.headers };
  delete out["content-encoding"];
  delete out["content-length"];
  delete out["transfer-encoding"];
  if (finalMeta.requestedModel) out["x-lop-requested-model"] = finalMeta.requestedModel;
  if (finalMeta.upstreamModel) out["x-lop-upstream-model"] = finalMeta.upstreamModel;
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
        modelFallback: Boolean(meta.modelFallback),
        requestedTier: meta.requestedTier || "",
        upstreamTier: usage.serviceTier || "",
      };
      log(`流吞吐：model=${record.requestedModel || "?"}${record.modelFallback ? `→${record.upstreamModel}` : ""} egress=${record.egressKey || "?"}:${record.egressPort} tier=${record.requestedTier || "-"}→${record.upstreamTier || "?"} ttfb=${record.ttfbMs}ms stream=${streamMs}ms outTok=${usage.outputTokens ?? "-"} reas=${usage.reasoningTokens ?? "-"} tok/s=${tokPerSec ?? "-"}`);
      // priority 额度是否被授予只能从吞吐判(2026-09-02 实测:同分钟 A/B priority 47-57 vs default 27
      // tok/s;但 46-49 tok/s 的快请求回显也是 "default",回显不可作降级证据)。回显不一致仍
      // 无条件留痕,措辞只陈述事实,不断言降级。
      if (record.requestedTier && record.upstreamTier && record.requestedTier !== record.upstreamTier) {
        log(`tier 回显不一致：请求 ${record.requestedTier} → 上游回显 ${record.upstreamTier}（是否实际降级以 tok/s 为准）originator=${record.originator || "-"}`);
      }
      fs.appendFile(METRICS_FILE, JSON.stringify(record) + "\n", () => {});
    } catch { /* 观测永不阻断转发 */ }
    // 过载失败绝不进入 exact memo，否则会把瞬时故障固化到 TTL 内反复重放。
    if (!replay?.enabled || selected.exhausted || usedModelFallback) return;
    const body = Buffer.concat(chunks);
    const stored = responseMemo.set(replay.key, {
      statusCode: upRes.statusCode,
      headers: out,
      body,
      usageToken: replay.usageToken,
    });
    log(`response memo ${stored ? "STORE" : "SKIP"} key=${replay.key.slice(0, 16)} bytes=${body.length} entries=${responseMemo.size}`);
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

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  // 进来的每一条都记：客户端打哪个路径、带什么 originator，是排障的第一手事实。
  if (url !== "/health") log(`<- ${req.method} ${req.url} originator=${req.headers.originator || "-"}`);

  if (url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, port: PORT, policyVersion: POLICY_VERSION,
      tierFallback: TIER,
      explicitBreakpoint: EXPLICIT_BREAKPOINT,
      historyReplayEffort: HISTORY_REPLAY_EFFORT,
      forceReasoningEffort: "off",
      responseMemoTtlMs: RESPONSE_MEMO_TTL_MS,
      responseMemoEntries: responseMemo.size,
      authMode: accountPool ? "account-pool" : "codex-login-pass-through",
      accountHomes: ACCOUNT_HOMES || null,
      accounts: accountPool ? accountPool.snapshot() : [],
      upstreamProxy: `${UPSTREAM_PROXY_HOST}:${UPSTREAM_PROXY_PORT}`,
      upstreamAgent: { maxSockets: 16, maxFreeSockets: 8 },
      upstreamGzip: UPSTREAM_GZIP,
      overloadRetry: {
        maxRetries: OVERLOAD_MAX_RETRIES,
        baseDelayMs: OVERLOAD_BASE_DELAY_MS,
        maxDelayMs: OVERLOAD_MAX_DELAY_MS,
        maxPrefixBytes: OVERLOAD_PREFIX_MAX_BYTES,
        primaryModel: OVERLOAD_PRIMARY_MODEL,
        fallbackModels: OVERLOAD_FALLBACK_MODELS,
      },
      egress: currentEgress(),
      metricsFile: METRICS_FILE,
    }));
  }

  // 账号池控制面（仅本机回环，即时切号/看池状态，无需下游登录头）。
  if (url === "/accounts" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, enabled: Boolean(accountPool), accounts: accountPool ? accountPool.snapshot() : [] }));
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
    res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(result));
  }

  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!bearer) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "缺少 Codex 登录 token" } }));
  }

  // codex 启动时探 /v1/models 刷新可用模型列表。它要的是 {"models":[...]}，不是 OpenAI 的
  // {"object":"list","data":[...]}——静态拼一份会报 missing field `models`（2026-08-19 实测）。
  // 所以原样转发给上游同名端点，格式由上游保证，本地不猜。
  if (url === "/v1/models" && req.method === "GET") {
    try {
      const upRes = await upstreamGet("/backend-api/codex/models" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""), req.headers);
      const out = { ...upRes.headers };
      delete out["content-encoding"];
      delete out["transfer-encoding"];
      res.writeHead(upRes.statusCode, out);
      res.on("error", (error) => log(`models 响应流失败：${String(error?.message || error).slice(0, 120)}`));
      return upRes.pipe(res);
    } catch (e) {
      log("models 转发失败：" + String(e.message).slice(0, 80));
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "models 转发失败" } }));
    }
  }

  if (url === "/v1/responses" && req.method === "POST") {
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
  log(`Tier 兜底：${TIER === "off" ? "off（请求未指定时交给上游）" : TIER}；请求显式 service_tier 始终优先`);
  log(`历史快路：exact relevance=1 使用 reasoning=${HISTORY_REPLAY_EFFORT}，工具失败自动保持原强度`);
  log(`推理强度：透传会话请求值（桥不改写；历史快路除外）`);
  log(`响应复用：严格 exact 全语义键，TTL=${RESPONSE_MEMO_TTL_MS}ms，最多 64 条/512KiB 每条`);
  log(`上游连接：keep-alive maxSockets=16 maxFreeSockets=8；上行 gzip=${UPSTREAM_GZIP ? "on" : "off"}`);
  log(`容量过载保护：首个有效 SSE 前 ${OVERLOAD_PRIMARY_MODEL}→${OVERLOAD_FALLBACK_MODELS.join("→") || "same-model"}，最多重试 ${OVERLOAD_MAX_RETRIES} 次，退避 ${OVERLOAD_BASE_DELAY_MS}-${OVERLOAD_MAX_DELAY_MS}ms，prefix 上限 ${OVERLOAD_PREFIX_MAX_BYTES}B`);
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
  }
  log(`流吞吐观测：SSE 尾部真实 usage → ${METRICS_FILE}`);
});
