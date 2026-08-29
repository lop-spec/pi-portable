// Codex（VS Code / VSCodium 扩展、codex CLI）的透明请求策略代理。
//
// 链路：Codex 扩展 --(codex 原生 responses)--> 本进程 :8794
//       --(保留 Codex 官方登录身份 + 注入请求策略)-->
//       chatgpt.com/backend-api/codex/responses
//
// 身份与刷新由客户端的官方登录态负责，本进程只透传 Authorization 头，
// 不落盘、不打印任何凭证。默认直连上游；设 CODEX_UPSTREAM_PROXY_PORT 则走本机 CONNECT 代理。

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
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

const PORT = Number(process.env.CODEX_PROXY_PORT || 8794);
const HOST = "127.0.0.1";
const LOG_FILE = path.join(PORTABLE_DATA, "codex-responses-proxy.log");
const UPSTREAM_HOST = "chatgpt.com";
const UPSTREAM_PATH = "/backend-api/codex/responses";
const UPSTREAM_PROXY_HOST = process.env.CODEX_UPSTREAM_PROXY_HOST || "127.0.0.1";
const UPSTREAM_PROXY_PORT = Number(process.env.CODEX_UPSTREAM_PROXY_PORT || 0); // [portable] 0=直连
const EXPLICIT_BREAKPOINT = process.env.CODEX_CACHE_EXPLICIT_BREAKPOINT === "1";
const HISTORY_REPLAY_EFFORT = process.env.CODEX_HISTORY_REPLAY_EFFORT || "max";
const FORCE_REASONING_EFFORT = process.env.CODEX_FORCE_REASONING_EFFORT || "max";
const RESPONSE_MEMO_TTL_MS = Number(process.env.CODEX_RESPONSE_MEMO_TTL_MS || 600000);
const POLICY_VERSION = "gpt56-chain-replay-v7.9.3";
const UPSTREAM_GZIP = process.env.CODEX_UPSTREAM_GZIP !== "0";
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
  // 清单纪律:与 lop-chain 验收清单门(CHECKLIST_HEADER)构成协议闭环——模型自列
  // 清单,agent_end 确定性解析闭合状态,未勾项自动续跑。codex CLI 流量 MARK 命中
  // 跳过注入,不与其自带 update_plan 工具重复。
  "For any request that requires actions or changes (not a pure question), begin your first reply with an acceptance checklist: the line 【验收清单】 followed by '- [ ] <item>' lines covering each verifiable acceptance criterion of the task. Repeat the checklist with updated states in every later reply: mark an item '- [x]' only when it is verifiably done, or '- [~] <item>: <reason>' when explicitly canceled or deferred. Never end your turn while any item remains '- [ ]'.",
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

function freshUpstreamSocket(proxyPort) {
  // [portable] 直连模式:无本机 CONNECT 代理时直接 TLS 到上游(换机默认路径)
  if (!proxyPort) {
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ host: UPSTREAM_HOST, port: 443, servername: UPSTREAM_HOST, ALPNProtocols: ["http/1.1"] });
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
      path: `${UPSTREAM_HOST}:443`,
      headers: { Host: `${UPSTREAM_HOST}:443` },
    });
    connect.setTimeout(10000, () => connect.destroy(new Error("CONNECT 超时 10s")));
    connect.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`CONNECT 返回 ${res.statusCode}`));
      }
      if (head?.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: UPSTREAM_HOST, ALPNProtocols: ["http/1.1"] });
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
    forceReasoningEffort: FORCE_REASONING_EFFORT,
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
    log(`cache 注入：key=${c.key} breakpoint=${c.breakpointApplied ? "explicit" : "off"} boundary=input[${c.itemIndex}].content[${c.blockIndex}] body=${originalBytes}B→${body.length}B`);
  } else if (rewritten.meta.parseFailed) {
    log(`cache/tier 解析失败，fail-open 原样透传 body=${originalBytes}B`);
  } else if (process.env.CODEX_PROXY_DUMP === "1") {
    log(`cache 未注入：${rewritten.meta.cache?.reason || "未命中策略"}`);
  }
  if (rewritten.meta.tierApplied) {
    log(`tier 兜底：service_tier=${rewritten.meta.effectiveTier} originator=${req.headers.originator || "-"}`);
  } else if (rewritten.meta.tierSource === "request") {
    log(`tier 透传：service_tier=${rewritten.meta.effectiveTier} originator=${req.headers.originator || "-"}`);
  }
  if (rewritten.meta.forcedReasoningApplied) {
    log(`推理强度强制：reasoning ${rewritten.meta.forcedReasoning.from || "default"}→${rewritten.meta.forcedReasoning.to}`);
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
  // 上行重压缩：改写后的明文大包恢复 gzip 再出网（透传体/小包在函数内自动跳过）。
  let upBody = body;
  let upHeaders = fwdHeaders;
  if (UPSTREAM_GZIP) {
    const compressed = compressUpstreamBody(body, fwdHeaders);
    if (compressed.compressed) {
      log(`上行 gzip：${body.length}B→${compressed.body.length}B`);
      ({ body: upBody, headers: upHeaders } = compressed);
    }
  }
  let upRes;
  try { upRes = await upstreamOnce(upBody, upHeaders); }
  catch (e) {
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
  const out = { ...upRes.headers };
  delete out["content-encoding"];
  delete out["content-length"];
  delete out["transfer-encoding"];
  res.writeHead(upRes.statusCode, out);
  // 客户端半途断开（pi 中止/页面刷新）：吞掉 error 防击穿，并停止继续拉上游流。
  res.on("error", (error) => log(`客户端响应流失败：${String(error?.message || error).slice(0, 120)}`));
  res.on("close", () => { if (!upRes.readableEnded) upRes.destroy(); });
  const chunks = [];
  const tail = createTailRing();
  upRes.on("data", (chunk) => {
    const data = Buffer.from(chunk);
    chunks.push(data);
    tail.push(data);
    res.write(data);
  });
  upRes.on("end", () => {
    res.end();
    // 流吞吐观测：真实 usage 来自 SSE 尾部的 response.completed，观测失败不影响转发。
    try {
      const meta = upRes.lopMeta || {};
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
      };
      log(`流吞吐：egress=${record.egressKey || "?"}:${record.egressPort} ttfb=${record.ttfbMs}ms stream=${streamMs}ms outTok=${usage.outputTokens ?? "-"} reas=${usage.reasoningTokens ?? "-"} tok/s=${tokPerSec ?? "-"}`);
      fs.appendFile(METRICS_FILE, JSON.stringify(record) + "\n", () => {});
    } catch { /* 观测永不阻断转发 */ }
    if (!replay?.enabled) return;
    const body = Buffer.concat(chunks);
    const stored = responseMemo.set(replay.key, {
      statusCode: upRes.statusCode,
      headers: out,
      body,
      usageToken: replay.usageToken,
    });
    log(`response memo ${stored ? "STORE" : "SKIP"} key=${replay.key.slice(0, 16)} bytes=${body.length} entries=${responseMemo.size}`);
  });
  upRes.on("error", (error) => {
    log(`上游响应流失败：${String(error?.message || error).slice(0, 120)}`);
    res.destroy(error);
  });
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
      forceReasoningEffort: FORCE_REASONING_EFFORT,
      responseMemoTtlMs: RESPONSE_MEMO_TTL_MS,
      responseMemoEntries: responseMemo.size,
      authMode: "codex-login-pass-through",
      upstreamProxy: `${UPSTREAM_PROXY_HOST}:${UPSTREAM_PROXY_PORT}`,
      upstreamAgent: { maxSockets: 16, maxFreeSockets: 8 },
      upstreamGzip: UPSTREAM_GZIP,
      egress: currentEgress(),
      metricsFile: METRICS_FILE,
    }));
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
  log(`推理强度：GPT-5.6 全请求强制 reasoning=${FORCE_REASONING_EFFORT}`);
  log(`响应复用：严格 exact 全语义键，TTL=${RESPONSE_MEMO_TTL_MS}ms，最多 64 条/512KiB 每条`);
  log(`上游连接：keep-alive maxSockets=16 maxFreeSockets=8；上行 gzip=${UPSTREAM_GZIP ? "on" : "off"}`);
  const bootEgress = currentEgress();
  log(`身份：Codex 官方登录透明传递；出口跟随 ${EGRESS_STATE_FILE}（当前 ${bootEgress.key}:${bootEgress.port}，缺省 ${UPSTREAM_PROXY_HOST}:${UPSTREAM_PROXY_PORT}）`);
  log(`流吞吐观测：SSE 尾部真实 usage → ${METRICS_FILE}`);
});
