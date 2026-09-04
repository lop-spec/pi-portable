// 一次性基线采集:桥 503 / S6 预审 token / 监督器恢复延迟 / compact-guard 频率。
// 只读运行面日志,输出一行 JSON 汇总,证据写入 acceptance-evidence.md 由调用方追加。
import fs from "node:fs";
import path from "node:path";

const DATA = process.env.PI_PORTABLE_DATA || "C:\\Users\\lop\\AppData\\Local\\pi-web\\portable\\data";
const WINDOW_H = Number(process.argv[2] || 24);
const since = Date.now() - WINDOW_H * 3600 * 1000;

function readLines(file) {
  try { return fs.readFileSync(path.join(DATA, file), "utf8").split(/\r?\n/); } catch { return []; }
}
// 桥日志时间戳:[2026/9/4 15:12:09] 本地时区
function bridgeTs(line) {
  const m = /^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\]/u.exec(line);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

// ---- 1. 桥 HTTP 状态分布
const proxy = readLines("codex-responses-proxy.log");
const bridge = { post: {}, get: {}, postTotal: 0, getTotal: 0 };
for (const line of proxy) {
  const ts = bridgeTs(line);
  if (!ts || ts < since) continue;
  const m = /-> (POST|GET) (\d{3})/u.exec(line);
  if (!m) continue;
  const bucket = m[1] === "POST" ? bridge.post : bridge.get;
  bucket[m[2]] = (bucket[m[2]] || 0) + 1;
  if (m[1] === "POST") bridge.postTotal += 1; else bridge.getTotal += 1;
}

// ---- 2. proxy-metrics: 按 originator 聚合 token / 时长
const metrics = readLines("proxy-metrics.jsonl");
const byOriginator = new Map();
let metricsRows = 0;
for (const line of metrics) {
  if (!line) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  const ts = Date.parse(row.ts || "");
  if (!ts || ts < since) continue;
  metricsRows += 1;
  const key = String(row.originator || "unknown");
  const agg = byOriginator.get(key) || { n: 0, outTok: 0, reasTok: 0, inTok: 0, streamMs: 0, ttfbMs: 0, status: {} };
  agg.n += 1;
  agg.outTok += Number(row.outTok || 0);
  agg.reasTok += Number(row.reasTok || 0);
  agg.inTok += Number(row.inTok || 0);
  agg.streamMs += Number(row.streamMs || 0);
  agg.ttfbMs += Number(row.ttfbMs || 0);
  agg.status[String(row.status)] = (agg.status[String(row.status)] || 0) + 1;
  byOriginator.set(key, agg);
}

// ---- 3. 监督器恢复:注入次数与同 run 间隔
const sup = readLines("run-supervisor.log");
const recoveries = [];
for (const line of sup) {
  if (!line) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  const ts = Date.parse(row.at || row.ts || "");
  if (!ts || ts < since) continue;
  const event = String(row.event || row.action || "");
  if (/recover|dispatch/iu.test(event)) recoveries.push({ ts, event, sessionId: row.sessionId || "", reason: row.reason || "" });
}
const supEvents = {};
for (const line of sup) {
  if (!line) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  const ts = Date.parse(row.at || row.ts || "");
  if (!ts || ts < since) continue;
  const key = String(row.event || row.action || "unknown");
  supEvents[key] = (supEvents[key] || 0) + 1;
}

// ---- 4. lop-chain: COMPACT_GUARD 与 S6
const chain = readLines("lop-chain.log");
const chainCounts = { compactFreeze: 0, compactFrozen: 0, s6Block: 0, s6Delivered: 0, s6FailOpen: 0, lines: 0 };
for (const line of chain) {
  const m = /^\[([^\]]+)\]/u.exec(line);
  const ts = m ? Date.parse(m[1]) : 0;
  if (!ts || ts < since) continue;
  chainCounts.lines += 1;
  if (line.includes("COMPACT_GUARD freeze#")) chainCounts.compactFreeze += 1;
  if (line.includes("COMPACT_GUARD frozen#")) chainCounts.compactFrozen += 1;
  if (line.includes("S6 BLOCK")) chainCounts.s6Block += 1;
  if (line.includes("S6 DELIVERED")) chainCounts.s6Delivered += 1;
  if (line.includes("S6 FAIL_OPEN")) chainCounts.s6FailOpen += 1;
}

const out = {
  windowHours: WINDOW_H,
  bridge,
  metricsRows,
  byOriginator: Object.fromEntries([...byOriginator.entries()].map(([k, v]) => [k, {
    ...v,
    outTokPerHour: +(v.outTok / WINDOW_H).toFixed(0),
    reasTokPerHour: +(v.reasTok / WINDOW_H).toFixed(0),
    streamMinutes: +(v.streamMs / 60000).toFixed(1),
  }])),
  supervisorEvents: supEvents,
  recoveryCount: recoveries.length,
  chainCounts,
};
console.log(JSON.stringify(out, null, 2));
