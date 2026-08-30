const PCON_ENABLE = "enable_pcon";
const PCON_TOKENS = new Set(["enable_pcon", "disable_pcon"]);

/**
 * Force Git for Windows/MSYS native children through ConPTY.
 * Existing unrelated MSYS options are preserved and duplicate/conflicting
 * pcon switches are collapsed to one deterministic enable_pcon token.
 */
export function forceMsysPseudoConsole(value) {
  const preserved = String(value || "")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !PCON_TOKENS.has(token.toLowerCase()));
  return [...preserved, PCON_ENABLE].join(" ");
}

/**
 * Return a cloned process environment. On Windows, enable the MSYS ConPTY
 * bridge so console-subsystem grandchildren do not allocate a visible window.
 */
export function withSilentWindowsProcessEnv(env, platform = process.platform) {
  const next = { ...env };
  if (platform !== "win32") return next;
  const existingKey = Object.keys(next).find((key) => key.toUpperCase() === "MSYS");
  const key = existingKey || "MSYS";
  next[key] = forceMsysPseudoConsole(next[key]);
  return next;
}
