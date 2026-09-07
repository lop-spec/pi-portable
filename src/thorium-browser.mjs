import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One executable resolver for the visible pi-web launcher and isolated CDP tool.
// Profile selection is deliberately separate: only the GUI may use the daily profile.
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

export function dailyThoriumArgs({ exists = fs.existsSync, userHome = os.userInfo().homedir } = {}) {
  // Pi rewrites HOME/USERPROFILE for its sandbox; daily browsing belongs to the real Windows account.
  const root = path.join(userHome, "AppData", "Local", "Thorium");
  const extensions = ["auto-close-old-tabs", "authenticator"]
    .map((name) => path.join(root, "Extensions", name))
    .filter((directory) => exists(path.join(directory, "manifest.json")));
  return [
    `--user-data-dir=${path.join(root, "Daily User Data")}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--no-default-browser-check",
    ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []),
  ];
}
