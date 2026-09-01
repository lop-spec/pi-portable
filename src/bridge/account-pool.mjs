// Codex 账号池：把「多账号轮转」从整进程重启下沉为逐请求的身份头替换。
// 自 code-lite 的 services/codex-proxy/account-pool.mjs 移植（2026-09-01），
// 语义保持一致，pin 状态文件从 code-lite state.json 改为桥自己的 pin 文件。
//
// 布局：homes/<id>/auth.json 即账号槽位（与 code-lite 共用），primary 槽位的身份
//       永远取下游请求自带的 Authorization——它由客户端自己负责刷新，本进程
//       绝不写 primary 的 auth.json，避免 refresh_token 轮换互相作废。
// 策略：sticky——一直用 active 账号以保上游前缀缓存，仅在 429（额度/频控）或
//       401（刷新失败）时冷却当前账号并切下一个可用的；绝不按请求轮询。
// 池不可用（homes 缺失/无账号/读取异常）时返回 null，代理原样透传下游身份，
// 行为与无账号池版本完全一致。
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const COOLDOWN_DEFAULT_MS = 30 * 60_000;
const COOLDOWN_MAX_MS = 6 * 60 * 60_000;
const COOLDOWN_401_MS = 15 * 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
const REFRESH_RETRY_GAP_MS = 5 * 60_000;
// 端点与 client_id 与官方 codex CLI 同源（实测自 codex.exe 二进制字符串）。
const OAUTH_HOST = "auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// 429 冷却期：Retry-After 头 > 响应体 reset 字段 > 默认 30 分钟；上限 6 小时。
export function parseCooldownUntilMs(statusCode, bodyText, headers, nowMs = Date.now()) {
  if (statusCode === 401) return nowMs + COOLDOWN_401_MS;
  let untilMs = 0;
  const retryAfter = Number(headers?.["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) untilMs = nowMs + retryAfter * 1000;
  if (!untilMs) {
    const match = /reset[s]?_?(?:in|at|after)[^0-9]{0,20}([0-9]{2,13})/i.exec(bodyText || "");
    if (match) {
      const value = Number(match[1]);
      untilMs = value > 10_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : nowMs + value * 1000;
    }
  }
  if (!untilMs || untilMs <= nowMs) untilMs = nowMs + COOLDOWN_DEFAULT_MS;
  return Math.min(Math.max(untilMs, nowMs + 60_000), nowMs + COOLDOWN_MAX_MS);
}

function readAuthFile(authPath) {
  const value = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const token = value?.tokens?.access_token;
  if (!token) throw new Error("auth.json 缺少 access_token");
  return {
    token,
    accountId: value?.tokens?.account_id || "",
    refreshToken: value?.tokens?.refresh_token || "",
  };
}

export function createAccountPool(options) {
  const {
    homesRoot,
    poolStateFile,
    pinStateFile,
    connect,
    log = () => {},
    refreshTransport,
    now = Date.now,
  } = options;

  const state = { active: "primary", cooldown: new Map(), lastRefreshTry: new Map(), loaded: false };
  const refreshInFlight = new Map();

  function loadState() {
    if (state.loaded) return;
    state.loaded = true;
    try {
      const value = JSON.parse(fs.readFileSync(poolStateFile, "utf8"));
      if (typeof value?.active === "string") state.active = value.active;
      for (const [id, until] of Object.entries(value?.cooldown || {})) {
        if (Number(until) > now()) state.cooldown.set(id, Number(until));
      }
    } catch { /* 首次启动没有状态文件。 */ }
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(poolStateFile), { recursive: true });
      const temporary = `${poolStateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({
        active: state.active,
        cooldown: Object.fromEntries(state.cooldown),
      }), "utf8");
      fs.renameSync(temporary, poolStateFile);
    } catch (error) {
      log(`账号池状态落盘失败：${String(error.message).slice(0, 80)}`);
    }
  }

  // autoRotate=false 时锁定 pin 文件指定的账号（pin 模式）：用尽即报错，不偷偷换号。
  function pinTarget() {
    try {
      const value = JSON.parse(fs.readFileSync(pinStateFile, "utf8"));
      if (value?.autoRotate === false) {
        const id = String(value.account || "primary").trim().toLowerCase();
        return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) ? id : "primary";
      }
    } catch { /* 状态缺失时默认允许轮转。 */ }
    return null;
  }

  function members() {
    const found = [];
    try {
      for (const entry of fs.readdirSync(homesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(entry.name)) continue;
        const authPath = path.join(homesRoot, entry.name, "auth.json");
        if (fs.existsSync(authPath)) {
          found.push({ id: entry.name, authPath, writable: entry.name !== "primary" });
        }
      }
    } catch { /* homes 缺失＝池不可用。 */ }
    found.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : a.id.localeCompare(b.id)));
    return found;
  }

  async function defaultRefreshTransport(refreshToken) {
    const body = JSON.stringify({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
      scope: "openid profile email",
    });
    const socket = await connect(OAUTH_HOST);
    return new Promise((resolve, reject) => {
      const request = https.request({
        host: OAUTH_HOST,
        path: "/oauth/token",
        method: "POST",
        createConnection: () => socket,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (response) => {
        let data = "";
        response.on("data", (chunk) => { data += chunk.toString("utf8"); });
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(`refresh HTTP ${response.statusCode}`));
          try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
        });
      });
      request.on("error", (error) => { try { socket.destroy(); } catch { /* 已断开。 */ } reject(error); });
      request.setTimeout(30_000, () => request.destroy(new Error("refresh 超时 30s")));
      request.write(body);
      request.end();
    });
  }

  // 同一账号的并发刷新单飞：并发 401 共享同一次刷新结果，避免后到者因节流拿到
  // false 而把刚刷新成功的账号误冷却。
  function refresh(member) {
    if (!member.writable) return Promise.resolve(false);
    const existing = refreshInFlight.get(member.id);
    if (existing) return existing;
    const last = state.lastRefreshTry.get(member.id) || 0;
    if (now() - last < REFRESH_RETRY_GAP_MS) return Promise.resolve(false);
    state.lastRefreshTry.set(member.id, now());
    const task = refreshOnce(member).finally(() => refreshInFlight.delete(member.id));
    refreshInFlight.set(member.id, task);
    return task;
  }

  async function refreshOnce(member) {
    let refreshToken;
    try { refreshToken = readAuthFile(member.authPath).refreshToken; } catch { return false; }
    if (!refreshToken) return false;
    try {
      const tokens = await (refreshTransport || defaultRefreshTransport)(refreshToken);
      if (!tokens?.access_token) return false;
      const value = JSON.parse(fs.readFileSync(member.authPath, "utf8"));
      value.tokens = {
        ...value.tokens,
        access_token: tokens.access_token,
        id_token: tokens.id_token ?? value.tokens?.id_token,
        refresh_token: tokens.refresh_token ?? value.tokens?.refresh_token,
      };
      value.last_refresh = new Date(now()).toISOString();
      const temporary = `${member.authPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
      fs.renameSync(temporary, member.authPath);
      log(`账号 ${member.id} token 已刷新（不打印）`);
      return true;
    } catch (error) {
      log(`账号 ${member.id} 刷新失败：${String(error.message || error).slice(0, 80)}`);
      return false;
    }
  }

  function cooldown(id, untilMs, reason) {
    loadState();
    state.cooldown.set(id, untilMs);
    if (state.active === id) state.active = null;
    saveState();
    log(`账号 ${id} 冷却至 ${new Date(untilMs).toLocaleTimeString("zh-CN", { hour12: false })}（${reason}）`);
  }

  // sticky 选择：active 未冷却且 token 可用就一直用它；否则切下一个可用成员并落盘。
  // primary 返回 useDownstream=true：身份用下游请求自带的 Authorization（客户端自己刷新）。
  // primary 永远垫底：客户端只认它登录的 primary 的额度，primary 一见底界面就挂
  // 限额横幅。备用账号先消耗、primary 只做最后储备——横幅出现时就是全池真没额度了。
  function pickOrder(a, b) {
    const rank = (member) =>
      member.id === state.active && member.id !== "primary" ? 0 : member.id === "primary" ? 2 : 1;
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  }

  async function pick(excludeIds) {
    loadState();
    const pin = pinTarget();
    const all = members();
    if (!all.length) return null;
    const candidates = pin ? all.filter((member) => member.id === pin) : all;
    if (!candidates.length) return null;
    const ordered = [...candidates].sort(pickOrder);
    const blockers = [];
    for (const member of ordered) {
      if (excludeIds?.has(member.id)) { blockers.push(`${member.id}:本轮已试`); continue; }
      const until = state.cooldown.get(member.id) || 0;
      if (until > now()) { blockers.push(`${member.id}:冷却中(剩${Math.ceil((until - now()) / 60_000)}min)`); continue; }
      if (member.id === "primary") {
        if (state.active !== member.id) { state.active = member.id; saveState(); }
        return { id: member.id, member, useDownstream: true };
      }
      let auth;
      // 错误消息可能内嵌 auth.json 源文本片段，日志一律用固定文案。
      try { auth = readAuthFile(member.authPath); }
      catch { blockers.push(`${member.id}:auth.json 不可用`); continue; }
      const expiry = jwtExpiryMs(auth.token);
      if (expiry && expiry - now() < REFRESH_AHEAD_MS) {
        if (await refresh(member)) {
          try { auth = readAuthFile(member.authPath); } catch { /* 沿用旧 token。 */ }
        } else if (expiry <= now()) {
          blockers.push(`${member.id}:token 已过期`);
          continue;
        }
      }
      if (state.active !== member.id) {
        state.active = member.id;
        saveState();
        log(`账号池启用 ${member.id}（新账号首条请求会全量重灌前缀缓存）`);
      }
      return { id: member.id, member, useDownstream: false, token: auth.token, accountId: auth.accountId };
    }
    log(`账号池无可用账号：${blockers.join("；") || "池为空"}`);
    // pin 模式下指定账号不可用 ≠ 池不可用：必须显式报错，不得回落到下游身份
    // 静默消耗 primary 额度。
    if (pin) return { pinnedUnavailable: true, id: pin, reason: blockers.join("；") || "账号不可用" };
    return null;
  }

  // 429 → 冷却并切换；401 → 池内账号先刷新重试，失败才冷却切换；primary 的 401
  // 归客户端处理（透传，让它走自己的重新登录流程）；其余状态码不归账号池管。
  async function onUpstreamFailure(account, statusCode, bodyText, headers) {
    if (statusCode === 429) {
      cooldown(account.id, parseCooldownUntilMs(429, bodyText, headers, now()), "429 额度/频控");
      return "switch";
    }
    if (statusCode === 401) {
      if (account.useDownstream) return "give-up";
      if (await refresh(account.member)) return "retry";
      cooldown(account.id, parseCooldownUntilMs(401, bodyText, headers, now()), "401 token 失效");
      return "switch";
    }
    return "give-up";
  }

  // 凭据保鲜：主动刷新临期的池内账号（primary 归客户端自己管），让长期闲置的
  // 备用账号在轮转需要它时一定可用。由代理启动时与定时器调用。
  async function refreshExpiring(windowMs = 48 * 60 * 60_000) {
    const refreshed = [];
    for (const member of members()) {
      if (!member.writable) continue;
      let auth;
      try { auth = readAuthFile(member.authPath); } catch { continue; }
      const expiry = jwtExpiryMs(auth.token);
      if (expiry !== null && expiry - now() > windowMs) continue;
      if (await refresh(member)) refreshed.push(member.id);
    }
    if (refreshed.length) log(`凭据保鲜：已刷新 ${refreshed.join(",")}`);
    return refreshed;
  }

  // 手动切号：清该账号冷却、设为 active，立即对后续请求生效（无需重启）。
  function select(id) {
    loadState();
    const target = members().find((member) => member.id === id);
    if (!target) return { ok: false, error: `账号不存在：${id}` };
    state.cooldown.delete(id);
    state.active = id;
    saveState();
    log(`账号池手动切换到 ${id}`);
    return { ok: true, id };
  }

  function snapshot() {
    loadState();
    const pin = pinTarget();
    return members().map((member) => {
      let tokenExpDays = null;
      try {
        const expiry = jwtExpiryMs(readAuthFile(member.authPath).token);
        if (expiry) tokenExpDays = Math.round(((expiry - now()) / 86_400_000) * 10) / 10;
      } catch { /* 槽位未登录。 */ }
      const until = state.cooldown.get(member.id) || 0;
      return {
        id: member.id,
        active: state.active === member.id,
        pinned: pin === member.id,
        cooldownMinLeft: until > now() ? Math.ceil((until - now()) / 60_000) : 0,
        tokenExpDays,
      };
    });
  }

  return { pick, onUpstreamFailure, select, snapshot, refresh, refreshExpiring, members };
}

// 429/401 failover 环：在 200（或非池管状态码）之前完成「冷却 → 切号 → 重发」，
// 下游只看到最终响应。send(headers) 执行一次上游请求；drain/decode 由调用方注入
// （桥内已有实现），便于合同测试用假响应驱动。
// 返回 { response, account, drained }：drained 非空表示响应体已被本环读掉（调用方
// 需用它重建下游响应）；pinnedUnavailable 时返回 { pinnedUnavailable }，由调用方
// 合成 429 显式报错。
export async function sendWithAccountFailover({ pool, headers, send, applyIdentity, drain, decode, log = () => {} }) {
  if (!pool) return { response: await send(headers), account: null, drained: null };
  let account = await pool.pick(new Set()).catch(() => null);
  if (account?.pinnedUnavailable) return { pinnedUnavailable: account };
  if (!account) return { response: await send(headers), account: null, drained: null };
  const tried = new Set([account.id]);
  for (;;) {
    const response = await send(applyIdentity(headers, account));
    const status = response.statusCode;
    if (status !== 429 && status !== 401) return { response, account, drained: null };
    const raw = await drain(response);
    const text = decode(raw, response.headers);
    log(`上游 HTTP ${status} 账号=${account.id} ${text.slice(0, 200)}`);
    const action = await pool.onUpstreamFailure(account, status, text, response.headers);
    if (action === "retry") {
      // 401 刷新成功：重挑一次（可能换 active）；挑不出可用的就沿用当前账号重发。
      const again = await pool.pick(new Set()).catch(() => null);
      if (again && !again.pinnedUnavailable) account = again;
      continue;
    }
    if (action === "switch") {
      const next = await pool.pick(tried).catch(() => null);
      if (next && !next.pinnedUnavailable) {
        log(`账号切换 ${account.id} → ${next.id}，重发本条请求`);
        tried.add(next.id);
        account = next;
        continue;
      }
    }
    return { response, account, drained: { raw, text } };
  }
}
