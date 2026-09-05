// 端到端探针：用 pi models.json 里同一份下游身份（默认 vscodium/homes/acct2）向 8794 发最小 responses 请求。
// 只打印状态码与首段事件类型，不打印凭据。用法：node bridge-e2e-probe.mjs [authJsonPath]
import fs from "node:fs";
import http from "node:http";

const authPath = process.argv[2] || "C:/Users/lop/Documents/claude/vscodium/homes/acct2/auth.json";
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
const body = JSON.stringify({
  model: "gpt-5.6-sol", stream: true, store: false,
  instructions: "Reply with the single word OK.",
  input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
  reasoning: { effort: "low" },
});
const req = http.request({
  host: "127.0.0.1", port: 8794, path: "/v1/responses", method: "POST",
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
    if (res.statusCode !== 200) console.log(data.slice(0, 300));
  });
});
req.setTimeout(60_000, () => { console.log("timeout 60s"); req.destroy(); });
req.on("error", (e) => console.log("error", e.message));
req.end(body);
