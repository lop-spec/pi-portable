// 端到端探针：自动发现当前便携根的 acct2 身份，向桥发最小 responses 请求。
// 只打印状态码与首段事件类型，不打印凭据。用法：node bridge-e2e-probe.mjs [authJsonPath] [--summary]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveBridgeRuntime } from "./bridge-runtime-paths.mjs";

const runtime = resolveBridgeRuntime(import.meta.url);
const authPath = process.argv[2] || process.env.CODEX_PROBE_AUTH_FILE || (runtime.accountHomes && path.join(runtime.accountHomes, "acct2", "auth.json"));
if (!authPath || !fs.existsSync(authPath)) throw new Error("未找到 acct2 auth.json；请传入路径或设置 CODEX_ACCOUNT_HOMES");
const port = Number(process.env.PI_BRIDGE_PORT || process.env.CODEX_PROXY_PORT || 8794);
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
// --summary：模拟 pi 压缩摘要请求（input[0] 为 pi 固定摘要系统提示、effort max），
// 用于核对桥的 summaryEffort 只对这种请求改档：桥日志应出现「摘要请求 reasoning：max→low」，
// proxy-metrics 最后一行 reasoningOverride=summary:max->low 且 reasTok 很小。
const summaryMode = process.argv.includes("--summary");
const PI_SUMMARY_PROMPT = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
const body = JSON.stringify(summaryMode ? {
  model: "gpt-5.6-sol", stream: true, store: false,
  input: [
    { role: "developer", content: PI_SUMMARY_PROMPT },
    { role: "user", content: [{ type: "input_text", text: "<conversation>\nuser: ping\nassistant: OK\n</conversation>\n\nThe messages above are a conversation to summarize. Reply with a one-line summary." }] },
  ],
  reasoning: { effort: "max" },
} : {
  model: "gpt-5.6-sol", stream: true, store: false,
  instructions: "Reply with the single word OK.",
  input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
  reasoning: { effort: "low" },
});
const req = http.request({
  host: "127.0.0.1", port, path: "/v1/responses", method: "POST",
  headers: {
    "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    originator: "pi_bridge_test", "OpenAI-Beta": "responses=experimental",
  },
}, (res) => {
  let data = "";
  res.on("data", (c) => { if (data.length < 4000) data += c.toString("utf8"); });
  res.on("end", () => {
    const events = [...data.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    const text = [...data.matchAll(/"delta":"([^"]*)"/g)].map((m) => m[1]).join("");
    console.log("status", res.statusCode, "events", [...new Set(events)].slice(0, 6).join(","), "text", JSON.stringify(text.slice(0, 40)));
    if (res.statusCode !== 200) { console.log(data.slice(0, 300)); process.exitCode = 1; }
  });
});
req.setTimeout(60_000, () => { console.log("timeout 60s"); process.exitCode = 1; req.destroy(); });
req.on("error", (e) => { console.log("error", e.message); process.exitCode = 1; });
req.end(body);
