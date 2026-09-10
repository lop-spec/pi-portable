import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AccountLogin } from "../src/account-login.mjs";
import { PiWebUiProxy } from "../src/piweb-ui-proxy.mjs";
import { createAccountPool, POOL_REMOVED_FILE } from "../src/bridge/account-pool.mjs";

const jwt = payload => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.test`;
const tokens = (email = "one@example.test", id = "one") => ({
  access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: id } }),
  id_token: jwt({ email, "https://api.openai.com/auth": { chatgpt_account_id: id } }),
  refresh_token: `secret-refresh-${id}`,
});
const auth = (email, id) => ({ custom: "preserved", tokens: { ...tokens(email, id), account_id: id || "one" } });
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-login-test-"));
  fs.mkdirSync(path.join(root, "acct2"));
  const file = path.join(root, "acct2", "auth.json");
  fs.writeFileSync(file, JSON.stringify(auth()));
  const logs = [], backups = [];
  const login = new AccountLogin({ context: async () => ({ homesRoot: root }), dataRoot: root, callbackPort: 0,
    log: (...args) => logs.push(args), exchange: async () => tokens(),
    backupFile: file => backups.push(fs.readFileSync(file, "utf8")), ...extra });
  t.after(() => { login.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, login, logs, backups };
}
const callback = login => `http://localhost:1455/auth/callback?code=test-code&state=${new URL(login.url).searchParams.get("state")}`;

test("reauth uses PKCE/state, verifies identity, backs up, merges and reads back only selected slot", async t => {
  const { login, file, root, logs, backups } = fixture(t);
  fs.mkdirSync(path.join(root, "acct3"));
  const other = path.join(root, "acct3", "auth.json"); fs.writeFileSync(other, JSON.stringify(auth("other@test", "other")));
  const before = fs.readFileSync(file, "utf8"), untouched = fs.readFileSync(other, "utf8");
  const start = await login.start("reauth", "acct2"), url = new URL(start.url);
  assert.equal(url.origin, "https://auth.openai.com"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("login_hint"), "one@example.test");
  assert.equal((await login.start("reauth", "acct2")).session, start.session);
  await assert.rejects(login.start("add"), /已有登录/);
  await assert.rejects(login.complete(start.session, callback(start).replace(/state=.*/, "state=evil")), /不匹配/);
  assert.equal(login.view().status, "waiting");
  const result = await login.complete(start.session, callback(start));
  assert.equal(result.status, "success"); assert.deepEqual(backups, [before]);
  assert.equal(JSON.parse(fs.readFileSync(file)).custom, "preserved");
  assert.equal(fs.readFileSync(other, "utf8"), untouched);
  assert.doesNotMatch(JSON.stringify([result, logs]), /secret-refresh|test-code|code_verifier|access_token|id_token/);
});

test("wrong account and wrong workspace never overwrite original", async t => {
  for (const replacement of [tokens("wrong@test", "two"), tokens("one@example.test", "other-workspace")]) {
    const { login, file, backups } = fixture(t, { exchange: async () => replacement });
    const before = fs.readFileSync(file, "utf8"), s = await login.start("reauth", "acct2");
    await assert.rejects(login.complete(s.session, callback(s)), /不一致/);
    assert.equal(fs.readFileSync(file, "utf8"), before); assert.equal(backups.length, 0);
  }
});

test("add auto-discovers next free slot; duplicate email/id rejected without writes", async t => {
  const { root, login, backups } = fixture(t, { exchange: async () => tokens("two@test", "two") });
  fs.mkdirSync(path.join(root, "acct3")); // reserved/unfinished slot must not be reused
  let s = await login.start("add");
  const result = await login.complete(s.session, callback(s));
  assert.equal(result.id, "acct4"); assert.equal(result.status, "success"); assert.equal(backups.length, 0);
  const before = fs.readFileSync(path.join(root, "acct4", "auth.json"), "utf8");
  s = await login.start("add"); await assert.rejects(login.complete(s.session, callback(s)), /已在账号池/);
  assert.equal(fs.readFileSync(path.join(root, "acct4", "auth.json"), "utf8"), before);
  assert.ok(!fs.existsSync(path.join(root, "acct5")));
});

test("backup failure, malformed tokens and cancellation during token exchange leave disk unchanged", async t => {
  for (const extra of [{ backupFile: () => { throw new Error("backup failed"); } }, { exchange: async () => ({ access_token: "secret" }) }]) {
    const { login, file } = fixture(t, extra), before = fs.readFileSync(file, "utf8");
    const s = await login.start("reauth", "acct2");
    await assert.rejects(login.complete(s.session, callback(s))); assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  let release;
  const { login, file } = fixture(t, { exchange: () => new Promise(resolve => { release = resolve; }) });
  const before = fs.readFileSync(file, "utf8"), s = await login.start("reauth", "acct2");
  const task = login.complete(s.session, callback(s));
  login.cancel(s.session); release(tokens()); await assert.rejects(task, /取消/);
  assert.equal(login.view().status, "cancelled"); assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("real bak helper verifies backup and stores it locally before reauth", async t => {
  // Leave backupFile undefined to exercise production helper, never real credentials.
  const { login, root } = fixture(t, { backupFile: undefined });
  fs.mkdirSync(path.join(root, "_历史版本"));
  const s = await login.start("reauth", "acct2");
  assert.equal((await login.complete(s.session, callback(s))).status, "success");
  assert.equal(fs.readdirSync(path.join(root, "_历史版本")).length, 1);
});

test("local callback works, occupied port exposes manual route, timeout frees the session", async t => {
  const { login } = fixture(t);
  const s = await login.start("reauth", "acct2");
  const url = new URL(callback(s));
  const result = await fetch(`http://127.0.0.1:${login.session.server.address().port}${url.pathname}${url.search}`);
  assert.equal(result.status, 200); assert.equal(login.view().status, "success");
  const occupied = http.createServer(); await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  const manual = fixture(t, { callbackPort: occupied.address().port, ttlMs: 50 });
  const m = await manual.login.start("add"); assert.equal(m.manual, true);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(manual.login.view().status, "expired"); assert.ok(manual.logs.some(row => row[0] === "account-login-manual"));
});

function req(value, headers = {}) {
  const request = Readable.from([JSON.stringify(value)]);
  request.headers = { host: "127.0.0.1:30141", origin: "http://127.0.0.1:30141", "content-type": "application/json", ...headers };
  request.method = "POST"; request.url = "/__pi_account_login"; return request;
}
function res() { return { status: 0, headers: {}, body: "", writeHead(status, headers) { Object.assign(this, { status, headers }); }, end(body) { this.body = String(body); } }; }

test("same-origin local auth route enforces JSON, method, state handle and prevents DNS rebinding", async t => {
  const { login, root } = fixture(t), proxy = new PiWebUiProxy({ dataRoot: root, accountLogin: login });
  for (const headers of [{ origin: "https://evil.test" }, { origin: "" }, { host: "evil.test:30141", origin: "http://evil.test:30141" }]) {
    const response = res(); await proxy.handlePublicProxy(req({ action: "start", mode: "add" }, headers), response); assert.equal(response.status, 403);
  }
  let response = res(); await proxy.handlePublicProxy(req({}, { "content-type": "text/plain" }), response); assert.equal(response.status, 415);
  const get = req({}); get.method = "GET"; response = res(); await proxy.handlePublicProxy(get, response); assert.equal(response.status, 405);
  response = res(); await proxy.handlePublicProxy(req({ action: "start", mode: "add" }), response);
  assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
  const session = JSON.parse(response.body).login.session;
  response = res(); await proxy.handlePublicProxy(req({ action: "status", session: "wrong" }), response); assert.equal(response.status, 400);
  response = res(); await proxy.handlePublicProxy(req({ action: "cancel", session }), response); assert.equal(JSON.parse(response.body).login.status, "cancelled");
});

test("delete confirms email, protects current/pinned account, preserves auth and add restores it", async t => {
  const { root, login, file, logs, backups } = fixture(t);
  fs.mkdirSync(path.join(root, "acct3"));
  fs.writeFileSync(path.join(root, "acct3", "auth.json"), JSON.stringify(auth("two@test", "two")));
  const pool = createAccountPool({ homesRoot: root, poolStateFile: path.join(root, "pool.json"), pinStateFile: path.join(root, "pin.json"), log: (...args) => logs.push(args) });
  const original = fs.readFileSync(file, "utf8");
  pool.select("acct2"); assert.equal(pool.remove("acct2", "one@example.test").ok, false);
  pool.select("acct3"); assert.equal(pool.remove("acct2", "wrong@test").ok, false);
  fs.writeFileSync(path.join(root, "pin.json"), JSON.stringify({ autoRotate: false, account: "acct2" }));
  assert.equal(pool.remove("acct2", "one@example.test").ok, false);
  fs.writeFileSync(path.join(root, "pin.json"), JSON.stringify({ autoRotate: true }));
  assert.equal(pool.remove("acct2", "one@example.test").ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(pool.members().map(m => m.id), ["acct3"]);
  assert.equal(pool.select("acct2").ok, false);
  const start = await login.start("add");
  assert.equal((await login.complete(start.session, callback(start))).id, "acct2");
  assert.equal(backups.length, 2);
  assert.ok(!fs.existsSync(path.join(root, "acct2", POOL_REMOVED_FILE)));
  assert.equal(pool.members().length, 2);
});

test("primary reauth/restoration uses displayed identity and the pool's removal marker", async t => {
  const { root, login, file, backups } = fixture(t, { exchange: async () => tokens("primary@test", "primary") });
  const primaryAuthFile = path.join(root, "primary-live.json");
  fs.writeFileSync(primaryAuthFile, JSON.stringify(auth("primary@test", "primary")));
  fs.mkdirSync(path.join(root, "primary"));
  fs.copyFileSync(file, path.join(root, "primary", "auth.json"));
  login.context = async () => ({ homesRoot: root, primaryAuthFile });
  const marker = path.join(root, "primary", POOL_REMOVED_FILE);
  fs.writeFileSync(marker, "{}");
  await assert.rejects(login.start("reauth", "primary"), /已移除/);
  const s = await login.start("add");
  assert.equal((await login.complete(s.session, callback(s))).id, "primary");
  assert.equal(backups.length, 2); assert.ok(!fs.existsSync(marker));
  const reauth = await login.start("reauth", "primary"); assert.equal(reauth.email, "primary@test");
});

test("remove API is routed through local bridge without exposing login files", async t => {
  const { root, login } = fixture(t), calls = [];
  const proxy = new PiWebUiProxy({ dataRoot: root, accountLogin: login, fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, id: "acct2", credentialsPreserved: true, accounts: [] }));
  } });
  const response = res();
  await proxy.handlePublicProxy(req({ action: "remove", id: "acct2", email: "one@example.test" }), response);
  assert.equal(response.status, 200); assert.equal(calls[0].url, "http://127.0.0.1:8794/account/remove");
  assert.equal(JSON.parse(response.body).credentialsPreserved, true);
});

test("real bridge delete endpoint rejects cross-origin requests and returns the remaining members", async t => {
  let child;
  t.after(async () => { if (child?.pid && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); } });
  const { root, file } = fixture(t);
  fs.mkdirSync(path.join(root, "acct3"));
  fs.writeFileSync(path.join(root, "acct3", "auth.json"), JSON.stringify(auth("two@test", "two")));
  const data = path.join(root, "runtime"); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "account-pool.json"), JSON.stringify({ active: "acct3" }));
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [fileURLToPath(new URL("../src/bridge/codex-responses-proxy.mjs", import.meta.url))], {
    env: { ...process.env, PI_PORTABLE_DATA: data, CODEX_ACCOUNT_HOMES: root, CODEX_PROXY_PORT: String(port), CODEX_UPSTREAM_PROXY_HOST: "127.0.0.1", CODEX_UPSTREAM_PROXY_PORT: "9", CODEX_EGRESS_FALLBACK_PORTS: "" },
    windowsHide: true, stdio: "ignore",
  });
  let spawnError; child.on("error", error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 50; n++) {
    try { if ((await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).json()).accountRemoval) { ready = true; break; } } catch {}
    if (spawnError || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `isolated bridge unavailable: ${spawnError?.message || child.exitCode}`);
  const post = (id, email, extra = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${base}/account/remove`, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, timeout: 1500 }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: async () => JSON.parse(body) }));
    });
    request.on("error", reject); request.on("timeout", () => request.destroy(new Error("test request timeout")));
    request.end(JSON.stringify({ id, email }));
  });
  assert.equal((await post("acct2", "one@example.test", { Origin: "https://evil.test" })).status, 403);
  assert.equal((await post("acct2", "one@example.test", { Host: "evil.test" })).status, 403);
  assert.equal((await post("acct2", "wrong@test")).status, 409);
  assert.equal((await post("acct3", "two@test")).status, 409);
  const before = fs.readFileSync(file, "utf8"), response = await post("acct2", "one@example.test");
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).accounts.map(a => a.id), ["acct3"]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("an in-flight refresh cannot overwrite credentials from explicit reauth", async t => {
  let release;
  const { root, file, logs } = fixture(t);
  const pool = createAccountPool({ homesRoot: root, poolStateFile: path.join(root, "pool.json"), pinStateFile: path.join(root, "pin.json"),
    log: message => logs.push(message), refreshTransport: () => new Promise(resolve => { release = resolve; }) });
  const task = pool.refresh(pool.members()[0]);
  const replacement = { ...auth(), tokens: { ...tokens(), refresh_token: "new-login-refresh" } };
  fs.writeFileSync(file, JSON.stringify(replacement));
  release(tokens()); assert.equal(await task, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), replacement);
  assert.match(JSON.stringify(logs), /credentials-changed-during-refresh/);
});
