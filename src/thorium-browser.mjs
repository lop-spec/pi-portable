import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One executable resolver for the launcher and browser tool.
// The tool attaches to the daily browser; only explicit self-tests launch a separate profile.
export function dailyThoriumProfile({ userHome = os.userInfo().homedir } = {}) {
  return path.join(userHome, "AppData", "Local", "Thorium", "User Data");
}
export function resolveThoriumExecutable({ env = process.env, exists = fs.existsSync, portableHome = env.PI_PORTABLE_HOME, userHome = os.userInfo().homedir } = {}) {
  const local = path.join(userHome, "AppData", "Local");
  const roots = [
    env.LOCALAPPDATA,
    local,
    env.PI_PORTABLE_DATA && path.join(env.PI_PORTABLE_DATA, "AppData", "Local"),
    portableHome && path.join(portableHome, "data", "AppData", "Local"),
    path.join(local, "pi-web", "portable", "data", "AppData", "Local"),
    env.ProgramFiles || "C:/Program Files",
    env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
  ].filter(Boolean);
  for (const root of [...new Set(roots)]) {
    const candidate = path.join(root, "Thorium", "Application", "thorium.exe");
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Unpacked extensions installed persistently (Secure Preferences location 4), keyed by lower-cased path.
// Unreadable/missing prefs → empty set, so callers fall back to --load-extension.
export function persistentExtensionPaths({ userHome = os.userInfo().homedir, readFile = fs.readFileSync } = {}) {
  try {
    const prefs = JSON.parse(readFile(path.join(dailyThoriumProfile({ userHome }), "Default", "Secure Preferences"), "utf8"));
    return new Set(Object.values(prefs.extensions?.settings || {})
      .filter((entry) => entry?.location === 4 && typeof entry.path === "string")
      .map((entry) => path.resolve(entry.path).toLowerCase()));
  } catch {
    return new Set();
  }
}

export function dailyThoriumArgs({ exists = fs.existsSync, userHome = os.userInfo().homedir, persistent = persistentExtensionPaths({ userHome }) } = {}) {
  // Use Thorium's native default profile, like Windows HTTP/HTTPS associations.
  // Use the real account home, not Pi's sandbox HOME/USERPROFILE.
  const root = path.join(userHome, "AppData", "Local", "Thorium");
  // Never pass --load-extension for an already persistent extension: Chromium re-registers it as
  // command-line (location 8) and the next start from a shortcut/link without the flag drops it.
  // 2026-09-11 both were made persistent; this flag reverted that on the 2026-09-25 cold start.
  const extensions = ["auto-close-old-tabs", "authenticator"]
    .map((name) => path.join(root, "Extensions", name))
    .filter((directory) => exists(path.join(directory, "manifest.json")))
    .filter((directory) => !persistent.has(path.resolve(directory).toLowerCase()));
  return [
    // Suppress chrome.debugger infobars for this trusted daily browser profile.
    // Browser automation uses the extension bridge, never a native debug port.
    "--silent-debugger-extension-api",
    "--no-default-browser-check",
    ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []),
  ];
}
