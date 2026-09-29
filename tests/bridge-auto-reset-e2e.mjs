// Real bridge + HTTP client; all upstream requests replaced BEFORE import.
// Uses synthetic JWT/account homes only. Never touches real cards or logins.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const reservation = http.createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-auto-reset-e2e-"));
const homes = path.join(root, "homes"), acct = path.join(homes, "acct2"); fs.mkdirSync(acct, { recursive: true });
const token = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864000,
  "https://api.openai.com/auth": { chatgpt_account_id: "fake-account-2" } })).toString("base64url")}.signature`;
fs.writeFileSync(path.join(acct, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "fake-account-2" } }));
Object.assign(process.env, { CODEX_FOLLOW_SYSTEM_PROXY: "0", CODEX_PROXY_PORT: String(port), PI_PORTABLE_DATA: root,
  CODEX_ACCOUNT_HOMES: homes, CODEX_UPSTREAM_GZIP: "0", CODEX_OVERLOAD_BASE_DELAY_MS: "10", CODEX_EGRESS_FALLBACK_PORTS: "" });
delete process.env.CODEX_UPSTREAM_PROXY_PORT;
let used = false, scenario = "reset", responseCalls = 0;
const requests = [], posts = [];
const quota = () => ({ rate_limit: { allowed: used, limit_reached: !used,
  primary_window: { used_percent: used ? 0 : 100, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 18000 } },
  rate_limit_reset_credits: { available_count: used ? 0 : 1 } });
const card = () => ({ available_count: used ? 0 : 1, credits: [{ id: "fake-credit", status: used ? "redeemed" : "available",
  is_supported_by_plan: true, reset_type: "codex_rate_limits", expires_at: new Date(Date.now() + 86400000).toISOString() }] });
const sse = ["response.created", "response.completed"].map(type => `event: ${type}\ndata: ${JSON.stringify({ type, response: { status: type === "response.completed" ? "completed" : "in_progress" } })}\n\n`).join("");
https.request = (options, callback) => {
  const fake = new EventEmitter(), chunks = [];
  fake.reusedSocket = false; fake.setTimeout = () => fake; fake.write = chunk => chunks.push(Buffer.from(chunk));
  fake.destroy = error => { if (error) fake.emit("error", error); fake.emit("close"); };
  fake.end = chunk => {
    if (chunk) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: options.path, method: options.method, headers: options.headers, raw });
    let statusCode = 200, payload, contentType = "application/json";
    if (options.path === "/backend-api/wham/usage") payload = JSON.stringify(quota());
    else if (options.path === "/backend-api/wham/rate-limit-reset-credits") payload = JSON.stringify(card());
    else if (options.path === "/backend-api/wham/rate-limit-reset-credits/consume") {
      assert.equal(options.method, "POST"); assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.headers["chatgpt-account-id"], "fake-account-2");
      assert.equal(Number(options.headers["Content-Length"]), Buffer.byteLength(raw));
      posts.push(JSON.parse(raw)); used = true; payload = JSON.stringify({ code: "reset" });
    } else if (options.path === "/backend-api/codex/responses") {
      responseCalls++;
      if (used && scenario === "reset") { payload = sse; contentType = "text/event-stream"; }
      else { statusCode = 429; payload = JSON.stringify({ error: { type: scenario === "generic" ? "rate_limit_error" : "usage_limit_reached", resets_in_seconds: 60 } }); }
    } else throw new Error(`unexpected fixture endpoint ${options.path}`);
    const response = Object.assign(Readable.from([Buffer.from(payload)]), { statusCode, headers: { "content-type": contentType } });
    response.once("end", () => fake.emit("close"));
    setImmediate(() => callback(response));
  };
  return fake;
};
await import("../src/bridge/codex-responses-proxy.mjs");
const base = `http://127.0.0.1:${port}`;
const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-downstream" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
const prompt = () => post("/v1/responses", { model: "gpt-5.6-sol", stream: true, input: [] });
let exitCode = 0;
try {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.autoReset.enabled, true);
  const response = await prompt(), text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /response.completed/);
  assert.equal(responseCalls, 2); assert.equal(posts.length, 1);
  assert.equal(posts[0].credit_id, "fake-credit"); assert.match(posts[0].redeem_request_id, /^[0-9a-f-]{36}$/);
  const responseRequests = requests.filter(r => r.path === "/backend-api/codex/responses");
  assert.equal(responseRequests[0].headers.authorization, `Bearer ${token}`);
  assert.deepEqual(responseRequests[0], responseRequests[1], "replay must preserve identity and the original model/body");
  const snapshot = await (await fetch(`${base}/account-usage`)).json();
  assert.equal(snapshot.autoReset.accounts.acct2.status, "used");
  assert.doesNotMatch(JSON.stringify(snapshot), /signature|fake-account-2|fake-credit/);
  scenario = "generic"; used = false;
  const generic = await prompt(); await generic.text();
  assert.equal(generic.status, 429); assert.equal(posts.length, 1);
  await post("/account/select", { id: "acct2" });
  await post("/account/auto-reset", { enabled: false });
  scenario = "disabled";
  const disabled = await prompt(); await disabled.text();
  assert.equal(disabled.status, 429); assert.equal(posts.length, 1);
  console.log("bridge-auto-reset-e2e: PASS (real routing, exact POST/identity, one same-account replay, generic 429 skipped, disabled respected; zero real cards)");
} catch (error) { exitCode = 1; console.error(error.stack); }
setTimeout(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(exitCode); }, 200);
