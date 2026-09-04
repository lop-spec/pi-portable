// live pi-web 复验:发一轮最小问答,读回 lop-chain.log / chain-metrics.jsonl 证明
// compact-guard 关闭留痕、S6 起审被跳过、会话本身不回归。输出一行 LIVE_RESULT JSON。
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.PIWEB_BASE || "http://127.0.0.1:30140";
const DATA = process.env.PI_PORTABLE_DATA || "C:\\Users\\lop\\AppData\\Local\\pi-web\\portable\\data";
const CHAIN_LOG = path.join(DATA, "lop-chain.log");
const CHAIN_METRICS = path.join(DATA, "chain-metrics.jsonl");
const PROXY_METRICS = path.join(DATA, "proxy-metrics.jsonl");

const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const tailFrom = (file, offset) => {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= offset) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
};

async function api(p, body) {
  const res = await fetch(BASE + p, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300), status: res.status }; }
}

const chainOffset = sizeOf(CHAIN_LOG);
const metricsOffset = sizeOf(CHAIN_METRICS);
const proxyOffset = sizeOf(PROXY_METRICS);

const t0 = Date.now();
const created = await api("/api/agent/new", {
  type: "prompt",
  cwd: process.env.TEMP || "C:\\Windows\\Temp",
  message: "只回一个词:ok",
  provider: "codex-bridge",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "low",
});
const sessionId = created?.sessionId || "";
let failed = sessionId ? "" : "create: " + JSON.stringify(created).slice(0, 200);
if (sessionId) {
  let done = false;
  for (let i = 0; i < 150; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const run = await api("/api/agent/running");
      if (!run.runningSessionIds?.includes(sessionId)) { done = true; break; }
    } catch { /* pi-web 暂时不可达时继续轮询 */ }
  }
  if (!done) failed = "timeout 150s";
}
let answer = "";
if (sessionId) {
  try {
    const j = await api("/api/agent/" + sessionId, { type: "get_last_assistant_text" });
    answer = typeof j?.data === "string" ? j.data : String(j?.data?.text || "");
  } catch (e) { failed = failed || "read: " + String(e).slice(0, 100); }
}

const chainTail = tailFrom(CHAIN_LOG, chainOffset);
const metricsTail = tailFrom(CHAIN_METRICS, metricsOffset);
const proxyTail = tailFrom(PROXY_METRICS, proxyOffset);

const s6Values = [];
let compactGuardMetric = null;
for (const line of metricsTail.split(/\r?\n/)) {
  if (!line) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  if (row.s6Start !== undefined) s6Values.push(String(row.s6Start));
  if (row.compactGuard === false) compactGuardMetric = row.compactGuardReason || "unknown";
}
const proxyOriginators = {};
for (const line of proxyTail.split(/\r?\n/)) {
  if (!line) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  const key = String(row.originator || "unknown");
  proxyOriginators[key] = (proxyOriginators[key] || 0) + 1;
}

console.log("LIVE_RESULT " + JSON.stringify({
  sessionId,
  wallMs: Date.now() - t0,
  failed,
  answer: answer.slice(0, 200),
  compactGuardDisabledLog: /COMPACT_GUARD disabled/.test(chainTail),
  compactGuardFreeze: (chainTail.match(/COMPACT_GUARD freeze#/gu) || []).length,
  compactGuardMetric,
  s6Values,
  proxyOriginators,
}));
process.exit(failed ? 1 : 0);
