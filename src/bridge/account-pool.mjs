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
//
// 外部槽位：homes/<id>/.pi-external-codex.json 只指向来源文件（如 AcBoter 金库），池实时只读。
//       来源的所有者（AcBoter 自带的 token 保活）不运行时，access_token 约 10 天后过期且无人续期；
//       标记里加 "refresh":"writeback" 的槽位才允许池临期续期，并按金库格式原子写回同一个来源文件
//       （不另存副本；来源里的 refresh_token 变化＝所有者已重新登录，立即采用新的）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { readAccountUsageIdentity } from "./account-usage.mjs";

export const POOL_REMOVED_FILE = ".pi-pool-removed.json";
export const EXTERNAL_CODEX_FILE = ".pi-external-codex.json";

const COOLDOWN_DEFAULT_MS = 30 * 60_000;
const COOLDOWN_MAX_MS = 6 * 60 * 60_000;
const COOLDOWN_401_MS = 15 * 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
const REFRESH_RETRY_GAP_MS = 5 * 60_000;
// 写回外部来源文件时 Windows 上的占用重试；已被拒绝的 refresh_token 只在换新前每小时提示一次。
const VAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const DEAD_TOKEN_LOG_GAP_MS = 60 * 60_000;
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
    accountId: value?.tokens?.account_id || value?.account_id || "",
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
    removalIdentity = member => readAccountUsageIdentity(member.authPath),
    now = Date.now,
  } = options;

  const state = {
    active: "primary", cooldown: new Map(), lastRefreshTry: new Map(), loaded: false,
    // writeback 槽位里已被上游拒绝的 refresh_token 指纹（仅进程内；来源换了新的就自动失效）。
    deadRefresh: new Map(), deadLogged: new Map(),
  };
  const refreshInFlight = new Map();
  const removedLogged = new Set();

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
        const slot = path.join(homesRoot, entry.name);
        const authPath = path.join(slot, "auth.json");
        if (fs.existsSync(path.join(slot, POOL_REMOVED_FILE))) {
          if (!removedLogged.has(entry.name)) log(`账号 ${entry.name} 跳过：explicitly-removed-from-pool`);
          removedLogged.add(entry.name);
          continue;
        }
        removedLogged.delete(entry.name);
        const externalFile = path.join(slot, EXTERNAL_CODEX_FILE);
        if (fs.existsSync(externalFile)) {
          try {
            const { version, sourcePath, refresh: refreshMode } = JSON.parse(fs.readFileSync(externalFile, "utf8"));
            if (version !== 1 || !path.isAbsolute(sourcePath) || fs.existsSync(authPath)) throw new Error("invalid-external-slot");
            found.push({ id: entry.name, authPath: sourcePath, writable: false, external: true, writeback: refreshMode === "writeback" });
          } catch { log(`账号 ${entry.name} 跳过：external-source-invalid`); }
        } else if (fs.existsSync(authPath)) {
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
          if (response.statusCode !== 200) {
            // Only known machine-readable reasons may enter logs; never log the OAuth body.
            let code = "";
            try {
              const payload = JSON.parse(data);
              const candidate = payload.error?.code || payload.error;
              if (["refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated", "invalid_grant", "invalid_client", "invalid_request", "access_denied"].includes(candidate)) code = candidate;
            } catch { /* HTTP status remains the observable reason. */ }
            return reject(new Error(`refresh HTTP ${response.statusCode}${code ? ` (${code})` : ""}`));
          }
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
    if (!member.writable && !member.writeback) return Promise.resolve(false);
    const existing = refreshInFlight.get(member.id);
    if (existing) return existing;
    const last = state.lastRefreshTry.get(member.id) || 0;
    if (now() - last < REFRESH_RETRY_GAP_MS) {
      log(`账号 ${member.id} 刷新跳过：retry-backoff，剩余 ${Math.ceil((REFRESH_RETRY_GAP_MS - (now() - last)) / 1000)}s`);
      return Promise.resolve(false);
    }
    state.lastRefreshTry.set(member.id, now());
    const task = refreshOnce(member).finally(() => refreshInFlight.delete(member.id));
    refreshInFlight.set(member.id, task);
    return task;
  }

  async function refreshOnce(member) {
    if (member.writeback) return refreshVaultOnce(member);
    if (!member.writable) { log(`账号 ${member.id} 跳过刷新：external-or-primary-readonly`); return false; }
    let refreshToken;
    try { refreshToken = readAuthFile(member.authPath).refreshToken; }
    catch { log(`账号 ${member.id} 刷新失败：auth-read-failed`); return false; }
    if (!refreshToken) { log(`账号 ${member.id} 刷新失败：missing-refresh-token`); return false; }
    try {
      const tokens = await (refreshTransport || defaultRefreshTransport)(refreshToken);
      if (!tokens?.access_token) { log(`账号 ${member.id} 刷新失败：missing-access-token-in-response`); return false; }
      const value = JSON.parse(fs.readFileSync(member.authPath, "utf8"));
      // An explicit login may have replaced credentials while refresh was in flight.
      // Never overwrite that newer identity with the old refresh response.
      if (value.tokens?.refresh_token !== refreshToken) {
        log(`账号 ${member.id} 刷新结果丢弃：credentials-changed-during-refresh`);
        return true;
      }
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

  // writeback 外部槽位的续期：来源文件的所有者没在保活时，池代为换新并原子写回同一个文件。
  // 字段口径与 AcBoter 金库一致（tokens 三元组、token_generation+1、requires_reauth=false、last_used），
  // 其余字段原样保留。永不打印 token；被上游拒绝的 refresh_token 不再重试，来源换了新的才恢复。
  async function refreshVaultOnce(member) {
    const logLimited = (text) => {
      if (now() - (state.deadLogged.get(member.id) || 0) < DEAD_TOKEN_LOG_GAP_MS) return;
      state.deadLogged.set(member.id, now());
      log(text);
    };
    let before;
    try { before = JSON.parse(fs.readFileSync(member.authPath, "utf8")); }
    catch { log(`账号 ${member.id} 刷新失败：vault-read-failed`); return false; }
    const refreshToken = before?.tokens?.refresh_token;
    if (!refreshToken) { log(`账号 ${member.id} 刷新失败：missing-refresh-token`); return false; }
    if (before.requires_reauth === true) {
      logLimited(`账号 ${member.id} 跳过刷新：来源已标记需要重新登录（在 AcBoter 重新登录后自动恢复）`);
      return false;
    }
    const fingerprint = crypto.createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
    if (state.deadRefresh.get(member.id) === fingerprint) {
      logLimited(`账号 ${member.id} 跳过刷新：refresh_token 已被上游拒绝（在 AcBoter 重新登录后自动恢复）`);
      return false;
    }
    let tokens;
    try { tokens = await (refreshTransport || defaultRefreshTransport)(refreshToken); }
    catch (error) {
      const message = String(error?.message || error).slice(0, 80);
      if (/refresh HTTP (400|401|403)\b/.test(message)) state.deadRefresh.set(member.id, fingerprint);
      log(`账号 ${member.id} 刷新失败：${message}`);
      return false;
    }
    if (!tokens?.access_token) { log(`账号 ${member.id} 刷新失败：missing-access-token-in-response`); return false; }
    // 响应里的 token 必须解析得出未来的过期时间，坏响应不能写进来源文件。
    if (!(jwtExpiryMs(tokens.access_token) > now())) { log(`账号 ${member.id} 刷新失败：invalid-access-token-in-response`); return false; }
    let current;
    try { current = JSON.parse(fs.readFileSync(member.authPath, "utf8")); }
    catch { log(`账号 ${member.id} 刷新结果丢弃：vault-read-failed-after-refresh`); return false; }
    // 刷新期间所有者已重新登录或自己续期：以来源为准，不覆盖更新的身份。
    if (current?.tokens?.refresh_token !== refreshToken) {
      log(`账号 ${member.id} 刷新结果丢弃：credentials-changed-during-refresh`);
      return true;
    }
    const updated = {
      ...current,
      tokens: {
        ...current.tokens,
        access_token: tokens.access_token,
        id_token: tokens.id_token ?? current.tokens.id_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
      },
      token_generation: (Number(current.token_generation) || 0) + 1,
      requires_reauth: false,
      last_used: now(),
    };
    const temporary = `${member.authPath}.tmp.${process.pid}.${now()}`;
    let written = false;
    try {
      fs.writeFileSync(temporary, JSON.stringify(updated, null, 2), "utf8");
      written = true;
      for (let attempt = 0; ; attempt += 1) {
        try { fs.renameSync(temporary, member.authPath); break; }
        catch (error) {
          const delay = VAULT_RENAME_RETRY_DELAYS_MS[attempt];
          if (!delay || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      // 换发后的新 refresh_token 只在临时文件里：保留它供人工找回，不静默丢弃。
      log(`账号 ${member.id} 写回失败：${String(error?.code || error?.message || error).slice(0, 60)}${written ? `；新凭据保留在 ${path.basename(temporary)}` : ""}`);
      if (!written) { try { fs.rmSync(temporary, { force: true }); } catch { /* 无临时文件。 */ } }
      return false;
    }
    log(`账号 ${member.id} token 已刷新并写回来源文件 gen=${updated.token_generation}（不打印）`);
    return true;
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
      let expiry = jwtExpiryMs(auth.token);
      if (member.writeback && (!expiry || expiry - now() < REFRESH_AHEAD_MS)) {
        // 来源的所有者没在保活：池代为续期，成功后以来源文件的新内容为准；失败且已过期则落入下面的外部过期跳过。
        if (await refresh(member)) {
          try { auth = readAuthFile(member.authPath); expiry = jwtExpiryMs(auth.token); } catch { /* 沿用旧 token。 */ }
        }
      }
      if (member.external && (!expiry || expiry <= now())) {
        blockers.push(`${member.id}:外部 token 已过期或不可验证`);
        log(`账号 ${member.id} 跳过：external-token-expired-or-invalid`);
        continue;
      }
      if (member.writable && expiry && expiry - now() < REFRESH_AHEAD_MS) {
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
      if ((!account.member.external || account.member.writeback) && await refresh(account.member)) return "retry";
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
      if (!member.writable && !member.writeback) continue;
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

  // Removing a pool member never deletes shared Codex/CLI login files.
  // The marker is reversible and automatically discovered on both machines.
  function remove(id, email) {
    loadState();
    const all = members(), target = all.find(member => member.id === id);
    if (!target) return { ok: false, error: "账号不存在或已移除" };
    if (id === state.active || id === pinTarget()) return { ok: false, error: "请先切换当前或固定账号，再删除" };
    if (all.length <= 1) return { ok: false, error: "至少保留一个轮转账号" };
    let actual;
    try { actual = removalIdentity(target).email; }
    catch { return { ok: false, error: "无法核对账号邮箱，未删除" }; }
    if (!actual || String(email).toLowerCase() !== actual.toLowerCase()) return { ok: false, error: "账号邮箱不匹配，未删除" };
    const marker = path.join(homesRoot, id, POOL_REMOVED_FILE);
    const raw = JSON.stringify({ version: 1, removedAt: new Date(now()).toISOString(), credentialsPreserved: true });
    try {
      fs.writeFileSync(marker, raw, { flag: "wx", mode: 0o600 });
      if (fs.readFileSync(marker, "utf8") !== raw) throw new Error("marker readback mismatch");
      log(`账号 ${id} 已移出轮转池，登录文件保留`);
      return { ok: true, id, credentialsPreserved: true };
    } catch {
      log(`账号 ${id} 移除失败：marker-write-failed`);
      return { ok: false, error: "移除标记写入失败，请检查账号池" };
    }
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
        // primary 走下游请求自带的 Authorization(客户端自己刷新),文件里的 token 过期与否不影响它。
        identity: member.id === "primary" ? "downstream" : "pool",
        refreshOwner: member.writeback ? "external-writeback" : member.external ? "external" : member.id === "primary" ? "downstream" : "pool",
      };
    });
  }

  return { pick, onUpstreamFailure, select, remove, snapshot, refresh, refreshExpiring, members };
}

// 429/401 failover 环：在 200（或非池管状态码）之前完成「冷却 → 切号 → 重发」，
// 下游只看到最终响应。send(headers) 执行一次上游请求；drain/decode 由调用方注入
// （桥内已有实现），便于合同测试用假响应驱动。
// 返回 { response, account, drained }：drained 非空表示响应体已被本环读掉（调用方
// 需用它重建下游响应）；pinnedUnavailable 时返回 { pinnedUnavailable }，由调用方
// 合成 429 显式报错。
export async function sendWithAccountFailover({ pool, headers, send, applyIdentity, drain, decode, log = () => {}, onQuotaExhausted, isCancelled = () => false }) {
  if (!pool) return { response: await send(headers), account: null, drained: null, attempts: 1, accountsTried: ["downstream"] };
  let account = await pool.pick(new Set()).catch(() => null);
  if (account?.pinnedUnavailable) return { pinnedUnavailable: account, attempts: 0, accountsTried: [] };
  if (!account) return { response: await send(headers), account: null, drained: null, attempts: 1, accountsTried: ["downstream"] };
  const tried = new Set([account.id]);
  const accountsTried = [];
  const resetTried = new Set();
  let attempts = 0;
  for (;;) {
    if (isCancelled()) throw Object.assign(new Error("request cancelled"), { name: "AbortError" });
    attempts += 1;
    accountsTried.push(account.id);
    const response = await send(applyIdentity(headers, account));
    const status = response.statusCode;
    if (status !== 429 && status !== 401) return { response, account, drained: null, attempts, accountsTried };
    const raw = await drain(response);
    const text = decode(raw, response.headers);
    log(`上游 HTTP ${status} 账号=${account.id} ${text.slice(0, 200)}`);
    // Only the explicit Codex quota error is redeemable, never generic rate
    // limiting. The handler additionally confirms fresh window exhaustion.
    let quotaExhausted = false;
    try { const error = JSON.parse(text)?.error; quotaExhausted = error?.type === "usage_limit_reached" || error?.code === "usage_limit_reached"; }
    catch { /* A non-JSON 429 is not a quota signal; logged below. */ }
    if (status === 429 && onQuotaExhausted && !quotaExhausted) log(`自动额度卡 ${account.id}：skipped reason=non-quota-429`);
    // At most one redemption check and one same-identity replay per account.
    if (status === 429 && quotaExhausted && onQuotaExhausted && !resetTried.has(account.id) && !isCancelled()) {
      resetTried.add(account.id);
      let restored = false;
      try { restored = await onQuotaExhausted(account, applyIdentity(headers, account)); }
      catch { log(`自动额度卡 ${account.id}：failed reason=reset-handler-error; keeping original failover`); }
      if (restored) {
        log(`账号 ${account.id} 额度已恢复，原身份重发本条请求`);
        continue;
      }
    }
    if (isCancelled()) throw Object.assign(new Error("request cancelled"), { name: "AbortError" });
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
    return { response, account, drained: { raw, text }, attempts, accountsTried };
  }
}
