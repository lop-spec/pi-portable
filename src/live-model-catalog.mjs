// Managed Pi model catalogue wiring.
//
// The legacy `codex-bridge` provider has a hand-written model array, so it can
// never see a newly published model until models.json is edited.  Pi's built-in
// `openai-codex` provider already owns a persisted, remotely refreshed catalogue.
// This module overlays that native provider onto the existing 8794 bridge while
// retaining the legacy provider so historical sessions remain resumable.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LEGACY_CODEX_PROVIDER = "codex-bridge";
export const LIVE_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const FIXED_CODEX_MODELS = Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra"]);
// Match GPT major versions >= 6, including future two-digit majors, while not
// exposing the older 5.x catalogue. Pi resolves enabledModels with minimatch.
export const NEWER_CODEX_MODEL_PATTERN = "openai-codex/gpt-@([6-9]|[1-9][0-9]*)*";
export const LIVE_CODEX_MODEL_PATTERNS = Object.freeze([
  ...FIXED_CODEX_MODELS.map((id) => `${LIVE_CODEX_PROVIDER}/${id}`),
  NEWER_CODEX_MODEL_PATTERN,
]);
export const MANAGED_PROVIDER_NAME = "Codex live catalogue via 8794";

const clone = (value) => JSON.parse(JSON.stringify(value));
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedBridgeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/u, "");
  if (!raw) return "";
  // Existing custom providers point at /v1. The native Codex API appends
  // /codex/responses, which the bridge accepts as an alias.
  return raw;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function enabledPatternMaySelectCodex(pattern) {
  if (typeof pattern !== "string") return false;
  const slash = pattern.indexOf("/");
  if (slash <= 0) return false;
  const providerPattern = pattern.slice(0, slash);
  if (providerPattern === LEGACY_CODEX_PROVIDER || providerPattern === LIVE_CODEX_PROVIDER) return true;
  // enabledModels is a positive-only minimatch list. A wildcard provider such
  // as `*/*:max` cannot preserve other providers while excluding Codex, so it
  // must be removed to keep the model selector bounded to the managed list.
  return providerPattern.includes("*")
    || providerPattern.includes("?")
    || providerPattern.includes("[")
    || providerPattern.includes("{")
    || providerPattern.includes("@(")
    || providerPattern.includes("+(")
    || providerPattern.includes("!(");
}

/** Pure migration used by both the launcher and contract tests. */
export function buildLiveModelConfiguration(modelsInput, settingsInput) {
  const models = clone(isRecord(modelsInput) ? modelsInput : {});
  const settings = clone(isRecord(settingsInput) ? settingsInput : {});
  models.providers = isRecord(models.providers) ? models.providers : {};

  const legacy = models.providers[LEGACY_CODEX_PROVIDER];
  if (!isRecord(legacy)) {
    return { ok: false, reason: `${LEGACY_CODEX_PROVIDER} provider is missing`, models, settings };
  }
  const baseUrl = normalizedBridgeBaseUrl(legacy.baseUrl);
  const existing = isRecord(models.providers[LIVE_CODEX_PROVIDER])
    ? models.providers[LIVE_CODEX_PROVIDER]
    : {};
  const apiKey = legacy.apiKey ?? existing.apiKey;
  if (!baseUrl || typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, reason: `${LEGACY_CODEX_PROVIDER} baseUrl/apiKey is incomplete`, models, settings };
  }

  const providerWasManaged = existing.name === MANAGED_PROVIDER_NAME;
  models.providers[LIVE_CODEX_PROVIDER] = {
    ...existing,
    name: MANAGED_PROVIDER_NAME,
    baseUrl,
    apiKey,
    // Do not copy chatgpt-account-id or other identity-bearing legacy headers.
    // The native Codex adapter derives the account id from its token, and the
    // bridge performs the final sticky-account substitution per request.
    headers: {
      ...(isRecord(existing.headers) ? existing.headers : {}),
      originator: "pi_web",
    },
  };

  const previousPatterns = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const unrelatedPatterns = previousPatterns.filter((pattern) => (
    typeof pattern === "string" && !enabledPatternMaySelectCodex(pattern)
  ));
  settings.enabledModels = uniqueStrings([...unrelatedPatterns, ...LIVE_CODEX_MODEL_PATTERNS]);

  if (!settings.defaultProvider || settings.defaultProvider === LEGACY_CODEX_PROVIDER) {
    const inherited = typeof settings.defaultModel === "string" && settings.defaultModel.trim()
      ? settings.defaultModel.trim()
      : DEFAULT_CODEX_MODEL;
    settings.defaultProvider = LIVE_CODEX_PROVIDER;
    settings.defaultModel = inherited;
  } else if (settings.defaultProvider === LIVE_CODEX_PROVIDER && !settings.defaultModel) {
    settings.defaultModel = DEFAULT_CODEX_MODEL;
  }

  const thinking = isRecord(settings.modelThinkingLevels) ? settings.modelThinkingLevels : {};
  const legacySolLevel = thinking[`${LEGACY_CODEX_PROVIDER}/${DEFAULT_CODEX_MODEL}`];
  for (const id of FIXED_CODEX_MODELS) {
    const key = `${LIVE_CODEX_PROVIDER}/${id}`;
    if (!thinking[key]) thinking[key] = legacySolLevel || "max";
  }
  settings.modelThinkingLevels = thinking;

  // The local bridge is HTTP/SSE only. Set this once during migration; after
  // that, an explicit user transport choice is preserved.
  if (!providerWasManaged && (!settings.transport || settings.transport === "auto")) {
    settings.transport = "sse";
  }

  return { ok: true, reason: "configured", models, settings };
}

function backupFiles(files, historyDir, label, now = new Date()) {
  fs.mkdirSync(historyDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15);
  const backups = [];
  for (const file of files) {
    const target = path.join(historyDir, `${path.basename(file)}.bak-${stamp}-${label}`);
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
    const sourceHash = sha256(file);
    const targetHash = sha256(target);
    if (sourceHash !== targetHash) throw new Error(`backup hash mismatch: ${file}`);
    backups.push({ file, target, sha256: sourceHash });
  }
  return backups;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, stableJson(value), { flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } finally {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Configure the native catalogue in ~/.pi/agent without replacing unrelated
 * providers/settings. Every changed existing file is physically backed up and
 * hash-verified before the first write.
 */
export function configureLiveModelCatalog(agentDir, options = {}) {
  const root = path.resolve(agentDir);
  const modelsFile = path.join(root, "models.json");
  const settingsFile = path.join(root, "settings.json");
  if (!fs.existsSync(modelsFile) || !fs.existsSync(settingsFile)) {
    return { status: "skipped", reason: "models.json or settings.json is missing", changed: [] };
  }

  const models = JSON.parse(fs.readFileSync(modelsFile, "utf8").replace(/^\uFEFF/u, ""));
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8").replace(/^\uFEFF/u, ""));
  const next = buildLiveModelConfiguration(models, settings);
  if (!next.ok) return { status: "skipped", reason: next.reason, changed: [] };

  const changed = [];
  if (stableJson(models) !== stableJson(next.models)) changed.push({ file: modelsFile, value: next.models });
  if (stableJson(settings) !== stableJson(next.settings)) changed.push({ file: settingsFile, value: next.settings });
  if (changed.length === 0) return { status: "already-current", reason: next.reason, changed: [] };

  const backups = backupFiles(
    changed.map((entry) => entry.file),
    path.join(root, "_历史版本"),
    "live-model-catalog",
    options.now,
  );
  for (const entry of changed) writeJsonAtomic(entry.file, entry.value);
  return {
    status: "updated",
    reason: next.reason,
    changed: changed.map((entry) => entry.file),
    backups,
    defaultModel: `${next.settings.defaultProvider}/${next.settings.defaultModel}`,
    enabledModels: next.settings.enabledModels,
  };
}
