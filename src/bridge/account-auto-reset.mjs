// Redeem existing Codex reset cards only after a real request hits an exhausted
// quota. Contract verified against ChatGPT's own usage UI (2026-09-14):
// GET /wham/rate-limit-reset-credits; POST .../consume with credit_id and
// redeem_request_id. No purchase endpoints, browser credentials or model calls.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AUTO_RESET_VERSION = "existing-cards-v1";
export const RESET_CARDS_PATH = "/backend-api/wham/rate-limit-reset-credits";
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const backupTool = fileURLToPath(new URL("../../tools/backup.mjs", import.meta.url));
const knownCodes = new Set(["reset", "already_redeemed", "no_credit", "nothing_to_reset"]);
const safeError = error => Number(error?.statusCode) ? `HTTP ${Number(error.statusCode)}` : "transport-or-state-error";

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = JSON.stringify(value), tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (fs.readFileSync(file, "utf8") !== raw) throw new Error("state readback mismatch");
}

export function exhaustedWindows(payload) {
  const limit = payload?.rate_limit;
  if (!limit || (limit.allowed !== false && limit.limit_reached !== true)) return [];
  return [limit.primary_window, limit.secondary_window].filter(window =>
    window && typeof window.used_percent === "number" && Number.isFinite(window.used_percent)
    && window.used_percent >= 100 && [18000, 604800].includes(window.limit_window_seconds));
}

export function selectResetCard(payload, windows, now = Date.now()) {
  if (!windows.length || !Number.isSafeInteger(payload?.available_count) || payload.available_count <= 0) return null;
  const covers = card => windows.every(window => card.reset_type === "codex_rate_limits"
    || (card.reset_type === "codex_five_hour" && window.limit_window_seconds === 18000)
    || (card.reset_type === "codex_weekly" && window.limit_window_seconds === 604800));
  return (Array.isArray(payload.credits) ? payload.credits : []).filter(card =>
    typeof card.id === "string" && card.id.length > 0 && card.id.length < 200
    && card.status === "available" && card.is_supported_by_plan === true
    && Number.isFinite(Date.parse(card.expires_at)) && Date.parse(card.expires_at) > now
    && covers(card))
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at) || a.id.localeCompare(b.id))[0] || null;
}

function recovered(payload) {
  const limit = payload?.rate_limit;
  const windows = [limit?.primary_window, limit?.secondary_window].filter(Boolean);
  return limit?.allowed === true && limit.limit_reached !== true && windows.length > 0
    && windows.every(w => typeof w.used_percent === "number" && Number.isFinite(w.used_percent) && w.used_percent < 100);
}

export function createAccountAutoReset({ dataDir, requestUsage, requestCards, consumeCard,
  log = () => {}, now = Date.now, backup = file => execFileSync(process.execPath,
    [backupTool, file, "--label", `auto-reset-${crypto.randomUUID()}`], { windowsHide: true, stdio: "pipe" }) }) {
  const configFile = path.join(dataDir, "account-auto-reset.json");
  const stateDir = path.join(dataDir, "account-auto-reset-state");
  const inflight = new Map(), recent = new Map();
  let settingsError = false;

  function enabled() {
    try {
      if (!fs.existsSync(configFile)) { settingsError = false; return true; }
      const value = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (typeof value.enabled !== "boolean") throw new Error("invalid setting");
      settingsError = false;
      return value.enabled;
    } catch {
      settingsError = true;
      log("自动额度卡停用：settings-unreadable");
      return false;
    }
  }
  function configure(value) {
    if (typeof value !== "boolean") throw new Error("enabled must be boolean");
    let previous = {};
    if (fs.existsSync(configFile)) {
      previous = JSON.parse(fs.readFileSync(configFile, "utf8"));
      backup(configFile); // failure prevents any modification
    }
    atomicWrite(configFile, { ...previous, version: 1, enabled: value });
    log(`自动额度卡：${value ? "enabled" : "disabled"}`);
    return snapshot();
  }
  function report(id, status, reason) {
    recent.set(id, { status, reason, at: new Date(now()).toISOString() });
    log(`自动额度卡 ${id}：${status} reason=${reason}`);
  }
  function snapshot() {
    const active = enabled();
    return { version: AUTO_RESET_VERSION, enabled: active, settingsError,
      policy: "on-exhaustion-existing-only", accounts: Object.fromEntries(recent) };
  }

  async function run({ id, identity, isCancelled = () => false }, key) {
    if (!enabled()) { report(id, "skipped", "disabled"); return false; }
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, `${key}.json`), lock = `${file}.lock`;
    // Per-identity cross-process exclusion, including two aliases of one account.
    // Crash locks are recovered only when the recorded process no longer exists.
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid lock owner");
      try { process.kill(owner.pid, 0); report(id, "skipped", "another-process-in-flight"); return false; }
      catch (error) { if (error.code !== "ESRCH") throw error; fs.unlinkSync(lock); }
    }
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; report(id, "skipped", "another-process-in-flight"); return false; }
    try {
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      if (previous && (!Number.isFinite(previous.at) || typeof previous.requestId !== "string" || typeof previous.creditId !== "string")) throw new Error("invalid reset state");
      if (previous && now() - previous.at < 60_000) {
        report(id, "skipped", "reset-cooldown"); return false;
      }
      const usage = await requestUsage(identity);
      if (isCancelled()) { report(id, "skipped", "request-cancelled"); return false; }
      const windows = exhaustedWindows(usage);
      let card, retry = false;
      if (previous && !["verified", "rejected"].includes(previous.status)) {
        // After an ambiguous POST, NEVER select another card or generate another
        // request UUID. The official client reuses both on transport failure.
        const list = await requestCards(identity);
        const oldCard = list?.credits?.find(c => c.id === previous.creditId);
        if (oldCard?.status === "redeemed" && recovered(usage)) {
          atomicWrite(file, { ...previous, status: "verified", at: now() });
          report(id, "used", "reconciled"); return true;
        }
        card = selectResetCard({ ...list, credits: oldCard ? [oldCard] : [] }, windows, now());
        if (!card) { report(id, "uncertain", "previous-reset-unconfirmed"); return false; }
        retry = true;
      } else {
        if (!windows.length) { report(id, "skipped", "quota-not-exhausted"); return false; }
        card = selectResetCard(await requestCards(identity), windows, now());
        if (!card) { report(id, "skipped", "no-applicable-card"); return false; }
      }
      if (!enabled() || isCancelled()) { report(id, "skipped", "disabled-or-cancelled"); return false; }
      const attempt = { version: 1, creditId: card.id, requestId: retry ? previous.requestId : crypto.randomUUID(), at: now(), status: "pending" };
      // Durable intent before consuming the asset; do not POST if this fails.
      atomicWrite(file, attempt);
      report(id, "using", retry ? "retry-same-card-and-request-id" : "quota-exhausted");
      let result;
      try { result = await consumeCard(identity, { credit_id: attempt.creditId, redeem_request_id: attempt.requestId }); }
      catch (error) { report(id, "uncertain", safeError(error)); return false; }
      const code = knownCodes.has(result?.code) ? result.code : "unknown-response";
      if (code === "no_credit" || code === "nothing_to_reset") {
        atomicWrite(file, { ...attempt, status: "rejected", at: now() });
        report(id, "skipped", code); return false;
      }
      if (code !== "reset" && code !== "already_redeemed") {
        // Even an unrecognised success body may have consumed a card: retain
        // pending state rather than risk burning another on the next request.
        report(id, "uncertain", code); return false;
      }
      const [after, afterCards] = await Promise.all([requestUsage(identity), requestCards(identity)]);
      const used = afterCards?.credits?.find(c => c.id === card.id)?.status === "redeemed";
      if (!recovered(after) || !(used || code === "reset")) {
        report(id, "uncertain", "reset-not-yet-visible"); return false;
      }
      atomicWrite(file, { ...attempt, status: "verified", at: now() });
      report(id, "used", "quota-restored");
      return true;
    } finally { fs.unlinkSync(lock); }
  }

  function tryReset(context) {
    const { identity, id } = context;
    if (!identity?.token || !identity.accountId) {
      report(id, "skipped", "identity-unavailable"); return Promise.resolve(false);
    }
    const key = hash(identity.accountId);
    if (inflight.has(key)) {
      log(`自动额度卡 ${id}：shared-in-flight`);
      const shared = inflight.get(key);
      return shared.task.then(result => {
        // Keep aliases visible without exposing the account identity or token.
        if (recent.has(shared.id)) recent.set(id, recent.get(shared.id));
        return result;
      });
    }
    const task = run(context, key).catch(error => {
      report(id, "failed", safeError(error)); return false;
    }).finally(() => inflight.delete(key));
    inflight.set(key, { task, id });
    return task;
  }
  return { tryReset, configure, snapshot };
}
