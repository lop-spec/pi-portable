// 端到端探针：自动发现当前便携根的 acct2 身份，向桥发最小 responses 请求。
// 只打印状态码与首段事件类型，不打印凭据。用法：node bridge-e2e-probe.mjs [authJsonPath]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveBridgeRuntime } from "./bridge-runtime-paths.mjs";

const runtime = resolveBridgeRuntime(import.meta.url);
const authPath = process.argv[2] || process.env.CODEX_PROBE_AUTH_FILE || (runtime.accountHomes && path.join(runtime.accountHomes, "acct2", "auth.json"));
if (!authPath || !fs.existsSync(authPath)) throw new Error("未找到 acct2 auth.json；请传入路径或设置 CODEX_ACCOUNT_HOMES");
const port = Number(process.env.PI_BRIDGE_PORT || process.env.CODEX_PROXY_PORT || 8794);
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
const body = JSON.stringify({
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
