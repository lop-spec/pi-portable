// pi RPC 装载自检:确认 lop-swarm 扩展被 pi 发现并注册了 swarm-status 命令(与 browser-agent 同一 discover 路径)。
// 用法: node src/lop-swarm/selftest-pi-load.mjs   (可设 PI_PORTABLE_HOME / PI_PORTABLE_DATA;对端用 runtime\node.exe)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const home = process.env.PI_PORTABLE_HOME
  || (fs.existsSync(path.join(localAppData, "pi-web", "portable")) ? path.join(localAppData, "pi-web", "portable") : "");
const data = process.env.PI_PORTABLE_DATA || (home ? path.join(home, "data") : "");
const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const rel = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"];
const candidates = [
  home ? path.join(home, "app", ...rel) : "",
  home ? path.join(home, "app", "node_modules", "@agegr", "pi-web", ...rel) : "",
  path.join(appdata, "npm", ...rel),
  path.join(appdata, "npm", "node_modules", "@agegr", "pi-web", ...rel),
].filter(Boolean);
const cli = candidates.find((c) => fs.existsSync(c));
if (!cli) throw new Error(`pi cli.js not found: ${candidates.join(" | ")}`);

// 与 launcher.mjs 同一套 env:便携布局下 pi 的 agent 目录是 data\.pi\agent(对端没有 ~/.pi,不设则零扩展装载)。
const env = { ...process.env, LOP_CHAIN_DISABLE: "1", PI_OFFLINE: "1" };
if (home) env.PI_PORTABLE_HOME = home;
if (data) {
  env.PI_PORTABLE_DATA = data;
  env.HOME = data;
  env.USERPROFILE = data;
  env.PI_CODING_AGENT_DIR = path.join(data, ".pi", "agent");
}

const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--approve"], {
  cwd: os.tmpdir(), env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const stderr = [];
let buffer = "";
let settled = false;
let notified = false;
let resolveDone; let rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
const timer = setTimeout(() => finish(new Error("pi RPC extension-load validation timed out after 25s")), 25_000);
function finish(error) { if (settled) return; settled = true; clearTimeout(timer); if (error) rejectDone(error); else resolveDone(); }
function onRecord(line) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { finish(new Error(`non-JSON RPC stdout: ${line.slice(0, 300)}`)); return; }
  if (event.type === "extension_error") { finish(new Error(`extension error (${event.extensionPath}): ${event.error}`)); return; }
  if (event.type === "response" && event.id === "commands") {
    if (!event.success) { finish(new Error(`get_commands failed: ${event.error}`)); return; }
    const names = new Set((event.data?.commands || []).map((c) => c.name));
    if (!names.has("swarm-status")) { finish(new Error(`swarm-status command not loaded: ${JSON.stringify([...names].filter((n) => /swarm|browser/.test(n)))}`)); return; }
    child.stdin.write(`${JSON.stringify({ id: "status", type: "prompt", message: "/swarm-status" })}\n`);
  }
  if (event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes("lop-swarm")) {
    notified = true;
    console.log(`notify: ${event.message}`);
  }
  if (event.type === "response" && event.id === "status") {
    if (!event.success) { finish(new Error(`swarm-status failed: ${event.error}`)); return; }
    setTimeout(() => finish(notified ? undefined : new Error("swarm-status did not notify lop-swarm status")), 150);
  }
}
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) { let line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (line.endsWith("\r")) line = line.slice(0, -1); onRecord(line); }
});
child.stderr.on("data", (chunk) => stderr.push(chunk));
child.once("error", (error) => finish(error));
child.once("exit", (code) => { if (!settled) finish(new Error(`pi RPC exited before validation (code ${code}) stderr=${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`)); });
child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);

let failure = null;
try { await done; } catch (error) { failure = error; }
try { child.stdin.end(); } catch {}
await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
try { child.kill(); } catch {}
if (failure) { console.error(`FAIL pi-load: ${failure.message}`); process.exit(1); }
console.log(`PASS pi-load: cli=${cli} home=${home || "-"} data=${data || "-"}`);
