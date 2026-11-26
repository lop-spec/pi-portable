// Lightweight Codex account quota monitor.
// It calls ChatGPT's read-only /wham/usage endpoint, never a model endpoint, so
// refreshes consume zero inference tokens. Successful snapshots are cached on
// disk without credentials and refreshed every four minutes (five-minute SLA).
import fs from "node:fs";
import path from "node:path";

export const ACCOUNT_USAGE_REFRESH_MS = 4 * 60_000;
export const ACCOUNT_USAGE_FRESH_MS = 5 * 60_000;
const ACCOUNT_USAGE_CACHE_VERSION = 2; // v1 mixed applicable reset counts with card balances.

function safeMessage(error) {
  const status = Number(error?.statusCode || 0);
  if (status) return `HTTP ${status}`;
  return String(error?.message || error || "unknown error")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]+/gu, "[redacted-token]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

export function decodeJwtPayload(token) {
  try {
    const segment = String(token || "").split(".")[1];
    return segment ? JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) : {};
  } catch {
    return {};
  }
}

export function identityFromAuthJson(value) {
  const tokens = value?.tokens && typeof value.tokens === "object" ? value.tokens : {};
  const token = String(tokens.access_token || "");
  const idClaims = decodeJwtPayload(tokens.id_token);
  const accessClaims = decodeJwtPayload(token);
  const profile = accessClaims?.["https://api.openai.com/profile"] || {};
  const auth = accessClaims?.["https://api.openai.com/auth"] || {};
  const email = String(idClaims.email || profile.email || accessClaims.email || "").trim();
  const accountId = String(tokens.account_id || value?.account_id || auth.chatgpt_account_id || "").trim();
  return { token, accountId, email };
}

export function readAccountUsageIdentity(authPath) {
  return identityFromAuthJson(JSON.parse(fs.readFileSync(authPath, "utf8")));
}

function normalizeResetAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const milliseconds = Number.isFinite(numeric)
    ? (numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function resetCreditCount(value) {
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "")
    ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function parseAccountUsagePayload(value) {
  const primary = value?.rate_limit?.primary_window || {};
  const rawUsed = primary.used_percent;
  const usedValue = typeof rawUsed === "number" || (typeof rawUsed === "string" && rawUsed.trim())
    ? Number(rawUsed) : NaN;
  if (!Number.isFinite(usedValue)) throw new Error("usage response has no primary quota");
  const usedPercent = Math.min(100, Math.max(0, Math.round(usedValue)));
  // available_count is the banked card balance. applicable_available_count can
  // be zero while cards remain; it describes current redemption eligibility.
  const resetCredits = resetCreditCount(value?.rate_limit_reset_credits?.available_count);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAt: normalizeResetAt(primary.resets_at ?? primary.reset_at),
    resetCredits,
    allowed: value?.rate_limit?.allowed !== false,
    planType: String(value?.plan_type || ""),
  };
}

function cleanCachedRecord(record) {
  if (!record || typeof record.id !== "string") return null;
  const used = Number(record.usedPercent);
  const remaining = Number(record.remainingPercent);
  const fetchedAtMs = Date.parse(String(record.fetchedAt || ""));
  if (!Number.isFinite(used) || !Number.isFinite(remaining) || !Number.isFinite(fetchedAtMs)) return null;
  return {
    id: record.id,
    email: String(record.email || ""),
    usedPercent: Math.min(100, Math.max(0, Math.round(used))),
    remainingPercent: Math.min(100, Math.max(0, Math.round(remaining))),
    resetAt: normalizeResetAt(record.resetAt),
    resetCredits: resetCreditCount(record.resetCredits),
    allowed: record.allowed !== false,
    planType: String(record.planType || ""),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    error: null,
    failedAt: null,
  };
}

function readCache(cacheFile, log) {
  if (!cacheFile || !fs.existsSync(cacheFile)) return new Map();
  try {
    const value = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const records = Array.isArray(value?.accounts) ? value.accounts.map(cleanCachedRecord).filter(Boolean) : [];
    if (value?.version !== ACCOUNT_USAGE_CACHE_VERSION && records.length) {
      for (const record of records) record.resetCredits = null;
      log("重置卡缓存口径更新：旧次数未验证为余额，显示未知并等待刷新；其他额度缓存保留");
    }
    return new Map(records.map((record) => [record.id, record]));
  } catch (error) {
    log(`账号额度缓存读取失败：${safeMessage(error)}`);
    return new Map();
  }
}

function writeCache(cacheFile, records, log) {
  if (!cacheFile) return;
  const accounts = [...records.values()]
    .filter((record) => record?.fetchedAt && Number.isFinite(Number(record.usedPercent)))
    .map(({ error: _error, failedAt: _failedAt, ...record }) => record);
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version: ACCOUNT_USAGE_CACHE_VERSION, accounts }, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, cacheFile);
  } catch (error) {
    log(`账号额度缓存落盘失败：${safeMessage(error)}`);
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

export function createAccountUsageMonitor(options) {
  const {
    members,
    accountState = () => [],
    requestUsage,
    refreshMember = async () => false,
    identityOverride = () => null,
    cacheFile = "",
    log = () => {},
    now = Date.now,
    refreshMs = ACCOUNT_USAGE_REFRESH_MS,
    freshMs = ACCOUNT_USAGE_FRESH_MS,
    live = false,
    modelRefreshDelayMs = 2_000,
    modelRefreshMinGapMs = 5_000,
  } = options;
  if (typeof members !== "function" || typeof requestUsage !== "function") {
    throw new Error("account usage monitor requires members and requestUsage");
  }

  let records = readCache(cacheFile, log);
  let refreshInFlight = null;
  let timer = null;
  let lastAttemptAt = 0;
  let lastCompletedAt = 0;
  const memberInFlight = new Map();
  const followUps = new Map();
  const lastMemberAttemptAt = new Map();

  function resolveIdentity(member) {
    let fromFile = { token: "", accountId: "", email: "" };
    try { fromFile = readAccountUsageIdentity(member.authPath); }
    catch (error) {
      const wrapped = new Error(`auth unavailable: ${safeMessage(error)}`);
      wrapped.cause = error;
      throw wrapped;
    }
    const override = identityOverride(member.id) || {};
    return {
      token: String(override.token || fromFile.token || ""),
      accountId: String(override.accountId || fromFile.accountId || ""),
      email: String(override.email || fromFile.email || ""),
    };
  }

  async function refreshOne(member) {
    let identity = resolveIdentity(member);
    if (!identity.token) throw new Error("auth has no access token");
    try {
      const payload = await requestUsage(identity, member);
      return { identity, usage: parseAccountUsagePayload(payload) };
    } catch (error) {
      if (Number(error?.statusCode) !== 401 || (!member.writable && !member.writeback)) throw error;
      const refreshed = await refreshMember(member);
      if (!refreshed) throw error;
      identity = resolveIdentity(member);
      const payload = await requestUsage(identity, member);
      return { identity, usage: parseAccountUsagePayload(payload) };
    }
  }

  function refreshMemberUsage(member) {
    const { id } = member;
    if (memberInFlight.has(id)) return memberInFlight.get(id);
    if (live) lastMemberAttemptAt.set(id, now());
    const work = (async () => {
      const previous = records.get(id);
      try {
        const { identity, usage } = await refreshOne(member);
        if (usage.resetCredits === null && previous?.resetCredits !== null) log(`账号重置卡余额不可用：${id} available_count 缺失或无效，显示未知而非 0`);
        records.set(id, { id, email: identity.email || previous?.email || "", ...usage,
          fetchedAt: new Date(now()).toISOString(), error: null });
        if (previous?.error) log(`账号额度恢复：${id}`);
        return true;
      } catch (reason) {
        const error = safeMessage(reason);
        let email = previous?.email || "";
        try { email ||= resolveIdentity(member).email; } catch { /* original error is logged below */ }
        records.set(id, { id, ...previous, email, error });
        if (!live || previous?.error !== error) log(`账号额度刷新失败：${id} ${error}`);
        return false;
      }
    })().finally(() => { memberInFlight.delete(id); });
    memberInFlight.set(id, work);
    return work;
  }

  function refresh(reason = "scheduled") {
    if (refreshInFlight) return refreshInFlight;
    lastAttemptAt = now();
    refreshInFlight = Promise.resolve().then(async () => {
      const currentMembers = members();
      const settled = await Promise.all(currentMembers.map(refreshMemberUsage));
      const successes = settled.filter(Boolean).length;
      lastCompletedAt = now();
      if (successes > 0) writeCache(cacheFile, records, log);
      if (reason === "startup") log(`账号额度监控就绪：${successes}/${currentMembers.length}，每 ${refreshMs / 1000} 秒刷新（零模型 token）`);
    }).catch(error => log(`账号额度刷新失败：${safeMessage(error)}`))
      .finally(() => { refreshInFlight = null; }).then(snapshot);
    return refreshInFlight;
  }

  // A read already in flight can predate the charge. Keep one trailing read per
  // account; a later model completion while it runs can enqueue another.
  function notifyModelUse(id) {
    if (!live || !id || followUps.has(id)) return;
    const earliest = now() + modelRefreshDelayMs;
    const run = () => {
      const inFlight = memberInFlight.get(id);
      if (inFlight) { void inFlight.then(() => { if (followUps.has(id)) schedule(); }); return; }
      followUps.delete(id);
      let member;
      try { member = members().find(item => item.id === id); }
      catch (error) { log(`账号额度成员读取失败：${safeMessage(error)}`); }
      if (!member) return;
      void refreshMemberUsage(member).then(ok => {
        if (ok) writeCache(cacheFile, records, log);
      });
    };
    const schedule = () => {
      const gapUntil = (lastMemberAttemptAt.get(id) ?? -Infinity) + modelRefreshMinGapMs;
      followUps.set(id, setTimeout(run, Math.max(0, Math.max(earliest, gapUntil) - now())));
      followUps.get(id).unref?.();
    };
    schedule();
  }

  function refreshIfDue(force = false) {
    if (refreshInFlight) return refreshInFlight;
    if (!force && lastAttemptAt && now() - lastAttemptAt < refreshMs) return null;
    return refresh(force ? "manual" : "due");
  }

  function snapshot() {
    let currentMembers = [];
    let states = [];
    try { currentMembers = members(); } catch (error) { log(`账号额度成员读取失败：${safeMessage(error)}`); }
    try { states = accountState(); } catch (error) { log(`账号额度状态读取失败：${safeMessage(error)}`); }
    const stateById = new Map(states.map((state) => [String(state.id), state]));
    const accounts = currentMembers.map((member) => {
      const record = records.get(member.id) || null;
      const state = stateById.get(member.id) || {};
      const fetchedAtMs = Date.parse(String(record?.fetchedAt || ""));
      const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, now() - fetchedAtMs) : null;
      let email = String(record?.email || "");
      if (!email) {
        try { email = resolveIdentity(member).email; } catch { /* error field already explains unavailable data */ }
      }
      return {
        id: member.id,
        email,
        active: state.active === true,
        pinned: state.pinned === true,
        cooldownMinLeft: Math.max(0, Number(state.cooldownMinLeft) || 0),
        usedPercent: record?.usedPercent !== null && record?.usedPercent !== undefined && Number.isFinite(Number(record.usedPercent))
          ? Number(record.usedPercent)
          : null,
        remainingPercent: record?.remainingPercent !== null && record?.remainingPercent !== undefined && Number.isFinite(Number(record.remainingPercent))
          ? Number(record.remainingPercent)
          : null,
        resetCredits: resetCreditCount(record?.resetCredits),
        resetAt: record?.resetAt || null,
        allowed: record ? record.allowed !== false : false,
        planType: String(record?.planType || ""),
        fetchedAt: record?.fetchedAt || null,
        ageMs,
        stale: ageMs === null || ageMs > freshMs,
        error: record?.error || null,
      };
    });
    return {
      ok: true,
      enabled: currentMembers.length > 0,
      refreshing: Boolean(refreshInFlight || memberInFlight.size || followUps.size),
      ...(live ? { live: true } : {}),
      generatedAt: new Date(now()).toISOString(),
      refreshIntervalMs: refreshMs,
      accuracyMaxAgeMs: freshMs,
      modelTokensConsumed: 0,
      lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null,
      lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt).toISOString() : null,
      accounts,
    };
  }

  function start() {
    if (timer) return;
    queueMicrotask(() => { void refresh("startup"); });
    timer = setInterval(() => { void refresh("scheduled"); }, refreshMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const pending of followUps.values()) clearTimeout(pending);
    followUps.clear();
    lastMemberAttemptAt.clear();
  }

  return { refresh, refreshIfDue, notifyModelUse, snapshot, start, stop };
}
