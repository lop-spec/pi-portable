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

export function dailyThoriumArgs({ exists = fs.existsSync, userHome = os.userInfo().homedir } = {}) {
  // Use Thorium's native default profile, like Windows HTTP/HTTPS associations.
  // Use the real account home, not Pi's sandbox HOME/USERPROFILE.
  const root = path.join(userHome, "AppData", "Local", "Thorium");
  const extensions = ["auto-close-old-tabs", "authenticator"]
    .map((name) => path.join(root, "Extensions", name))
    .filter((directory) => exists(path.join(directory, "manifest.json")));
  return [
    // Suppress chrome.debugger infobars for this trusted daily browser profile.
    // Browser automation uses the extension bridge, never a native debug port.
    "--silent-debugger-extension-api",
    "--no-default-browser-check",
    ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []),
  ];
}
