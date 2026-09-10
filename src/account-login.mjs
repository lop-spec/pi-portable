// Explicit, browser-driven Codex OAuth. No browser launch, model call, credential
// sync or CLI subprocess. Protocol matches pi-ai's OpenAI Codex browser login.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { POOL_REMOVED_FILE } from "./bridge/account-pool.mjs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT = "http://localhost:1455/auth/callback";
const CLAIM = "https://api.openai.com/auth";
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(message); };
function claims(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url")); }
  catch { return {}; }
}
function identity(auth) {
  const id = claims(auth?.tokens?.id_token), access = claims(auth?.tokens?.access_token);
  return {
    email: String(id.email || access["https://api.openai.com/profile"]?.email || "").toLowerCase(),
    accountId: String(auth?.tokens?.account_id || id[CLAIM]?.chatgpt_account_id || access[CLAIM]?.chatgpt_account_id || ""),
  };
}
function readAuth(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fail("无法读取账号凭据，未修改任何账号"); }
}
function backup(file) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/backup.mjs", import.meta.url)), file, "--label", `oauth-${crypto.randomUUID()}`], {
    windowsHide: true, stdio: "pipe", timeout: 10_000,
  });
  if (result.error || result.status !== 0) fail("凭据备份失败，未修改账号");
}

// Only the configured egress is used. Never try an unrelated proxy or silently
// switch to direct. Body/error text from OAuth must not enter logs or UI.
export async function exchangeCodexCode({ code, verifier, signal, dataRoot }) {
  let egress;
  try { egress = JSON.parse(fs.readFileSync(path.join(dataRoot, "egress.json"), "utf8")); }
  catch { return fail("无法读取出口配置，授权未完成"); }
  if (!["direct", "proxy"].includes(egress.mode)) fail("出口配置无效，授权未完成");
  const host = "auth.openai.com";
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT }).toString();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  return new Promise((resolve, reject) => {
    let tunnel, socket, request, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener("abort", abort);
      request?.destroy(); tunnel?.destroy(); socket?.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("授权请求已取消或超时"));
    deadline.addEventListener("abort", abort, { once: true });
    if (deadline.aborted) return abort();
    const send = rawSocket => {
      socket = tls.connect({ ...(rawSocket ? { socket: rawSocket } : { host, port: 443 }), servername: host, ALPNProtocols: ["http/1.1"] });
      socket.once("error", () => finish(new Error("授权 TLS 连接失败")));
      socket.once("secureConnect", () => {
        request = https.request({ host, path: "/oauth/token", method: "POST", createConnection: () => socket,
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, response => {
          let data = "";
          response.on("data", chunk => { data += chunk; if (data.length > 128 * 1024) finish(new Error("授权响应过大")); });
          response.on("error", () => finish(new Error("授权响应中断")));
          response.on("end", () => {
            if (response.statusCode !== 200) return finish(new Error(`授权失败 HTTP ${response.statusCode}`));
            try { finish(null, JSON.parse(data)); } catch { finish(new Error("授权响应无效")); }
          });
        });
        request.on("error", () => finish(new Error("授权网络请求失败")));
        request.end(body);
      });
    };
    if (egress.mode === "direct") return send();
    if (!Number.isInteger(egress.port) || egress.port < 1 || egress.port > 65535) return finish(new Error("代理端口无效"));
    tunnel = http.request({ host: egress.host || "127.0.0.1", port: egress.port, method: "CONNECT", path: `${host}:443` });
    tunnel.on("error", () => finish(new Error("授权代理连接失败")));
    tunnel.on("connect", (response, rawSocket) => {
      if (response.statusCode !== 200 || settled) { rawSocket.destroy(); return finish(new Error(`授权代理 HTTP ${response.statusCode}`)); }
      send(rawSocket);
    });
    tunnel.end();
  });
}

export class AccountLogin {
  constructor({ context, dataRoot, log, exchange = exchangeCodexCode, backupFile = backup, callbackPort = 1455, ttlMs = 15 * 60_000 }) {
    Object.assign(this, { context, dataRoot, log, exchange, backupFile, callbackPort, ttlMs });
    this.session = null;
    this.starting = false;
  }
  busy() { return this.session && ["waiting", "exchanging"].includes(this.session.status); }
  view() {
    const s = this.session;
    return s ? { session: s.key, status: s.status, mode: s.mode, id: s.id, email: s.email, url: s.status === "waiting" ? s.url : "", expiresAt: s.expiresAt, manual: s.manual, error: s.error || "" } : { status: "idle" };
  }
  async start(mode, id) {
    if (!["add", "reauth"].includes(mode) || (mode === "reauth" && !ID.test(id))) fail("登录请求无效");
    if (this.busy() && this.session.mode === mode && (mode === "add" || this.session.id === id)) return this.view();
    if (this.starting || this.busy()) fail("已有登录进行中，请先完成或取消");
    this.starting = true;
    try {
      const { homesRoot, primaryAuthFile } = await this.context();
      if (!homesRoot || !fs.existsSync(homesRoot) || !fs.statSync(homesRoot).isDirectory()) fail("账号池未启用");
      const root = fs.realpathSync(homesRoot);
      let file, expected;
      if (mode === "reauth") {
        if (fs.existsSync(path.join(root, id, POOL_REMOVED_FILE))) fail("账号已移除，请通过添加账号恢复");
        file = id === "primary" && primaryAuthFile ? primaryAuthFile : path.join(root, id, "auth.json");
        if (!fs.existsSync(file)) fail("账号不存在");
        file = fs.realpathSync(file);
        expected = identity(readAuth(file));
        if (!expected.email || !expected.accountId) fail("无法核对原账号身份，拒绝覆盖");
      }
      const verifier = crypto.randomBytes(32).toString("base64url"), state = crypto.randomBytes(32).toString("base64url");
      const url = new URL("https://auth.openai.com/oauth/authorize");
      url.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT,
        scope: "openid profile email offline_access", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "pi", prompt: "login",
        ...(expected ? { login_hint: expected.email } : {}), }).toString();
      const s = { key: crypto.randomUUID(), mode, id: mode === "reauth" ? id : "", email: expected?.email || "", expected, root, file,
        primaryAuthFile, verifier, state, url: url.href, status: "waiting", manual: false, controller: new AbortController(), expiresAt: Date.now() + this.ttlMs };
      this.session = s;
      s.timer = setTimeout(() => this.finish(s, "expired", "登录已超时，请重试"), this.ttlMs);
      s.timer.unref?.();
      const server = http.createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        let callback;
        try { callback = new URL(request.url || "/", REDIRECT); }
        catch { response.writeHead(400); response.end(); return; }
        if (request.method !== "GET" || callback.pathname !== "/auth/callback") { response.writeHead(404); response.end(); return; }
        // Do not return/log callback URL, code or state.
        this.complete(s.key, callback.href).then(() => {
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); response.end("登录成功，可关闭此页并返回 Pi Web。");
        }, () => {
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); response.end("登录未完成，请返回 Pi Web 查看原因或重试。");
        });
      });
      s.server = server;
      await new Promise(resolve => {
        server.once("error", () => { s.manual = true; this.log("account-login-manual", { reason: "callback-port-unavailable" }); resolve(); });
        server.listen(this.callbackPort, "127.0.0.1", resolve);
      });
      this.log("account-login-start", { mode, id: s.id });
      return this.view();
    } finally { this.starting = false; }
  }
  require(key) {
    if (!this.session || key !== this.session.key) fail("登录会话已失效，请重试");
    return this.session;
  }
  finish(s, status, error = "") {
    clearTimeout(s.timer);
    s.status = status; s.error = error;
    s.verifier = ""; s.state = ""; s.url = "";
    s.controller.abort();
    s.server?.close();
    this.log(`account-login-${status}`, { mode: s.mode, id: s.id, ...(error ? { reason: error } : {}) });
  }
  cancel(key) {
    const s = this.require(key);
    if (this.busy()) this.finish(s, "cancelled");
    return this.view();
  }
  async complete(key, input) {
    const s = this.require(key);
    if (typeof input !== "string" || input.length > 8192) fail("回调网址无效");
    if (s.status !== "waiting") fail("登录不在等待授权状态");
    if (Date.now() >= s.expiresAt) { this.finish(s, "expired", "登录已超时，请重试"); fail(s.error); }
    let url;
    try { url = new URL(input); } catch { fail("请粘贴完整的 localhost 回调网址"); }
    if (url.origin !== "http://localhost:1455" || url.pathname !== "/auth/callback" || url.searchParams.get("state") !== s.state) {
      this.log("account-login-rejected", { reason: "callback-state-or-url-mismatch" });
      fail("回调网址或校验状态不匹配，未修改账号");
    }
    if (url.searchParams.has("error")) { this.finish(s, "failed", "授权被拒绝，请重新登录"); fail(s.error); }
    const code = url.searchParams.get("code");
    if (!code) fail("回调网址缺少授权码");
    s.status = "exchanging";
    try {
      const tokens = await this.exchange({ code, verifier: s.verifier, signal: s.controller.signal, dataRoot: this.dataRoot });
      if (s.controller.signal.aborted) fail("登录已取消或超时");
      if (!tokens?.access_token || !tokens.refresh_token || !tokens.id_token) fail("授权响应缺少凭据，未修改账号");
      const auth = { auth_mode: "chatgpt", tokens: { ...tokens }, last_refresh: new Date().toISOString() };
      const who = identity(auth);
      if (!who.email || !who.accountId) fail("授权响应缺少账号身份，未修改账号");
      auth.tokens.account_id = who.accountId;
      if (s.expected && (who.email !== s.expected.email || who.accountId !== s.expected.accountId)) fail("登录账号与原账号不一致，未修改任何账号");
      let original;
      if (s.mode === "reauth") {
        original = readAuth(s.file);
        const current = identity(original);
        if (current.email !== who.email || current.accountId !== who.accountId) fail("原账号身份已变更，拒绝覆盖");
        this.backupFile(s.file);
      } else {
        const files = fs.readdirSync(s.root, { withFileTypes: true }).filter(e => e.isDirectory() && ID.test(e.name))
          .map(e => ({ id: e.name, file: e.name === "primary" && s.primaryAuthFile ? s.primaryAuthFile : path.join(s.root, e.name, "auth.json"),
            marker: path.join(s.root, e.name, POOL_REMOVED_FILE) })).filter(e => fs.existsSync(e.file));
        for (const { id, file, marker } of files) {
          const other = identity(readAuth(file));
          if (other.email === who.email || other.accountId === who.accountId) {
            if (!fs.existsSync(marker) || other.email !== who.email || other.accountId !== who.accountId) fail("该账号已在账号池中，请使用重新登录");
            s.file = file; s.id = id; s.restoreMarker = marker;
          }
        }
        if (s.restoreMarker) {
          original = readAuth(s.file);
          this.backupFile(s.file);
          this.backupFile(s.restoreMarker);
        } else {
          let n = 2;
          while (fs.existsSync(path.join(s.root, `acct${n}`))) n++;
          s.id = `acct${n}`;
          fs.mkdirSync(path.join(s.root, s.id));
          s.file = path.join(s.root, s.id, "auth.json");
        }
      }
      const merged = { ...original, ...auth, tokens: { ...original?.tokens, ...auth.tokens } };
      const raw = Buffer.from(JSON.stringify(merged, null, 2) + "\n");
      const temporary = `${s.file}.oauth-${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, s.file);
      if (hash(fs.readFileSync(s.file)) !== hash(raw)) fail("凭据写入读回校验失败，请检查本机备份");
      if (s.restoreMarker) fs.renameSync(s.restoreMarker, `${s.restoreMarker}.restored-${crypto.randomUUID()}`);
      s.email = who.email;
      this.finish(s, "success");
      return this.view();
    } catch (error) {
      // Our errors are fixed strings; injected/unexpected errors can contain secrets.
      const message = /^(登录|授权|账号|原账号|该账号|无法|凭据|回调|代理|出口)/u.test(error?.message || "") ? error.message : "登录处理失败，未自动重试，请检查本机日志";
      if (!s.controller.signal.aborted) this.finish(s, "failed", message);
      throw new Error(s.error || message);
    }
  }
  close() { if (this.busy()) this.cancel(this.session.key); }
}
