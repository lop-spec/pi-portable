import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isDirectory(candidate) {
  if (!candidate) return false;
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

function firstDirectory(candidates) {
  return candidates.filter(Boolean).map((candidate) => path.resolve(candidate)).find(isDirectory) || "";
}

export function resolveBridgeRuntime(importMetaUrl, env = process.env) {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
  const portableRoot = path.resolve(env.PI_PORTABLE_HOME || sourceRoot);
  const localAppData = String(env.LOCALAPPDATA || "").trim();
  const profileFromLocalAppData = localAppData ? path.resolve(localAppData, "..", "..") : "";
  const userProfile = String(env.USERPROFILE || "").trim();
  const data = path.resolve(env.PI_PORTABLE_DATA || firstDirectory([
    path.join(portableRoot, "data"),
    localAppData && path.join(localAppData, "pi-web", "portable", "data"),
  ]) || path.join(portableRoot, "data"));
  const accountHomes = firstDirectory([
    env.CODEX_ACCOUNT_HOMES,
    path.join(data, "homes"),
    path.join(data, "code-lite", "homes"),
    profileFromLocalAppData && path.join(profileFromLocalAppData, "Documents", "claude", "vscodium", "data", "code-lite", "homes"),
    userProfile && path.join(userProfile, "Documents", "claude", "vscodium", "data", "code-lite", "homes"),
    userProfile && path.join(userProfile, "Documents", "claude", "vscodium", "homes"),
  ]);
  return { sourceRoot, portableRoot, data, accountHomes };
}

export function commandReferencesPath(command, candidate) {
  const normalize = (value) => String(value || "").replaceAll("\\", "/").toLowerCase();
  return Boolean(candidate) && normalize(command).includes(normalize(path.resolve(candidate)));
}

export function readBridgeEgress(data) {
  for (const name of ["egress.json", "active-egress.json"]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));
      if (value && typeof value === "object") {
        if (name === "active-egress.json" && value.port && !value.mode) return { ...value, mode: "proxy", host: value.host || "127.0.0.1" };
        return value;
      }
    } catch { /* 下一候选 */ }
  }
  return {};
}
