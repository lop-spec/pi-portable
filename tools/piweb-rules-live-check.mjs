// pi-web 规则生效复验:开一个最小会话,让模型原文引用它当前加载的全局规则里
// 「慢查询」和「数据库治理」两行,读回后判断是否已是精简版(不再引用已归档的 rules/db-*.md)。
// 用法: node tools/piweb-rules-live-check.mjs   (环境 PIWEB_BASE 可覆盖,默认 30140)
const BASE = process.env.PIWEB_BASE || "http://127.0.0.1:30140";

async function api(p, body) {
  const res = await fetch(BASE + p, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300), status: res.status }; }
}

const message = [
  "不要调用任何工具。只做一件事:把你当前加载的全局规则(AGENTS.md)里「按需准确性资料」一节中,",
  "以「慢查询」开头和以「数据库治理」开头的两行逐字原文抄出来,不加任何解释。",
].join("");

const t0 = Date.now();
const created = await api("/api/agent/new", {
  type: "prompt",
  cwd: process.env.TEMP || "C:\\Windows\\Temp",
  message,
  provider: "codex-bridge",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "low",
});
const sessionId = created?.sessionId || "";
let failed = sessionId ? "" : "create: " + JSON.stringify(created).slice(0, 200);
if (sessionId) {
  let done = false;
  for (let i = 0; i < 180; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const run = await api("/api/agent/running");
      if (!run.runningSessionIds?.includes(sessionId)) { done = true; break; }
    } catch { /* 暂时不可达继续轮询 */ }
  }
  if (!done) failed = "timeout 180s";
}
let answer = "";
if (sessionId) {
  try {
    const j = await api("/api/agent/" + sessionId, { type: "get_last_assistant_text" });
    answer = typeof j?.data === "string" ? j.data : String(j?.data?.text || "");
  } catch (e) { failed = failed || "read: " + String(e).slice(0, 100); }
}
const slim = answer.includes("db-readonly-analysis.md") && !answer.includes("db-sql-impact-analysis")
  && answer.includes("db-maintenance-and-release.md") && !answer.includes("db-maintenance-scripts");
console.log(JSON.stringify({ LIVE_RESULT: true, ok: !failed && slim, slim, failed, sessionId, seconds: Math.round((Date.now() - t0) / 1000), answer: answer.slice(0, 600) }));
