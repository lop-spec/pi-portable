// Narrow, idempotent upstream prompt patch. No custom SYSTEM.md and no model calls.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const OLD_DOC_RULES = [
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
];
export const NEW_DOC_RULES = [
  "- For questions or changes involving pi capabilities, configuration, APIs, or implementation, locate the relevant official documentation sections and read enough to support the current decision or change; consult examples only as needed",
  "- Follow documentation cross-references only when the current conclusion or implementation depends on them. Full-file reading and exhaustive link traversal are not required; when logs and current runtime code directly answer the question, additional general documentation reading is unnecessary",
];
export function patchPrompt(source) {
  const oldCounts = OLD_DOC_RULES.map((s) => source.split(s).length - 1);
  const newCounts = NEW_DOC_RULES.map((s) => source.split(s).length - 1);
  if (newCounts.every((n) => n === 1) && oldCounts.every((n) => n === 0)) return source;
  if (!oldCounts.every((n) => n === 1) || !newCounts.every((n) => n === 0)) throw new Error("prompt anchor mismatch; no write; inspect upstream changes");
  return OLD_DOC_RULES.reduce((s, old, i) => s.replace(old, NEW_DOC_RULES[i]), source);
}
export function resolveSdk(pkg) {
  let dir = fs.realpathSync(pkg);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "node_modules/@earendil-works/pi-coding-agent");
    if (fs.existsSync(path.join(candidate, "dist/core/system-prompt.js"))) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot resolve the installed Pi SDK from ${pkg}`);
}
export function patchInstalledPrompt(sdk, { check = false } = {}) {
  const core = path.join(sdk, "dist/core/system-prompt.js");
  const files = [core];
  const chunks = path.join(sdk, "dist/bundle/chunks");
  if (fs.existsSync(chunks)) for (const name of fs.readdirSync(chunks)) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(chunks, name), s = fs.readFileSync(file, "utf8");
    if (s.includes("Always read pi .md files") || s.includes(NEW_DOC_RULES[0])) files.push(file);
  }
  // Validate every target before taking backups or changing any file.
  const edits = files.map((file) => { const before = fs.readFileSync(file, "utf8"); return { file, before, after: patchPrompt(before) }; }).filter((e) => e.before !== e.after);
  if (!check && edits.length) {
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "backup.mjs");
    execFileSync(process.execPath, [helper, ...edits.map((e) => e.file), "--label", "native-prompt"], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    for (const { file, before, after } of edits) {
      if (fs.readFileSync(file, "utf8") !== before) throw new Error(`Concurrent change: ${file}`);
      const temp = fs.mkdtempSync(path.join(path.dirname(file), ".native-policy-"));
      const staged = path.join(temp, "prompt.js");
      try {
        fs.writeFileSync(staged, after, { encoding: "utf8", flag: "wx" });
        fs.renameSync(staged, file);
        if (fs.readFileSync(file, "utf8") !== after) throw new Error(`Readback mismatch: ${file}`);
      } finally {
        if (fs.existsSync(staged)) fs.unlinkSync(staged);
        fs.rmdirSync(temp);
      }
    }
  }
  return { status: edits.length ? (check ? "pending" : "patched") : "already-patched", sdk, changed: edits.length, checked: files.length, runtime: "not-verified" };
}
// Portable tools may be reached through a directory junction. Node resolves the module URL, not argv.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const i = process.argv.indexOf("--pkg"), j = process.argv.indexOf("--sdk");
    const sdk = j >= 0 ? process.argv[j + 1] : resolveSdk(i >= 0 ? process.argv[i + 1] : path.join(process.env.PI_PORTABLE_HOME || ".", "app/node_modules/@agegr/pi-web"));
    const result = patchInstalledPrompt(sdk, { check: process.argv.includes("--check") });
    console.log(JSON.stringify(result));
    if (result.status === "pending") process.exitCode = 1;
  } catch (error) { console.error(`[native-policy] ${error.message}`); process.exitCode = 1; }
}
