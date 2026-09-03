import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const localPortable = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pi-web", "portable") : null;
const home = process.env.PI_PORTABLE_HOME
  || (localPortable && await fs.stat(path.join(localPortable, "app")).then(() => localPortable, () => null))
  || "D:\\Downloads\\pi-protable";
const data = process.env.PI_PORTABLE_DATA || path.join(home, "data");
// 两种安装布局:便携发行直装 app\node_modules\@earendil-works;本机 pi-web 包内嵌套 @agegr\pi-web\node_modules\@earendil-works
const cliCandidates = [
  path.join(home, "app", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  path.join(home, "app", "node_modules", "@agegr", "pi-web", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
];
let cli = null;
for (const candidate of cliCandidates) if (await fs.stat(candidate).then(() => true, () => false)) { cli = candidate; break; }
if (!cli) throw new Error(`pi cli.js not found under ${home}`);
const evidenceDir = path.join(data, "browser-agent", "evidence");
const events = [];
const stderr = [];
let resolveDone;
let rejectDone;
let timer;
const done = new Promise((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});

const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--approve"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: data,
    USERPROFILE: data,
    PI_PORTABLE_HOME: home,
    PI_PORTABLE_DATA: data,
    PI_OFFLINE: "1",
  },
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let commandsVerified = false;
let statusVerified = false;
let settled = false;

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (error) rejectDone(error);
  else resolveDone();
}

function onRecord(line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    finish(new Error(`non-JSON RPC stdout: ${line.slice(0, 500)}`));
    return;
  }
  events.push(event);
  if (event.type === "extension_error") {
    finish(new Error(`extension error (${event.extensionPath}): ${event.error}`));
    return;
  }
  if (event.type === "response" && event.id === "commands") {
    if (!event.success) {
      finish(new Error(`get_commands failed: ${event.error}`));
      return;
    }
    const names = new Set((event.data?.commands || []).map((command) => command.name));
    if (!names.has("browser-status") || !names.has("browser-close")) {
      finish(new Error(`browser commands were not loaded: ${JSON.stringify([...names])}`));
      return;
    }
    commandsVerified = true;
    child.stdin.write(`${JSON.stringify({ id: "status", type: "prompt", message: "/browser-status" })}\n`);
  }
  if (event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes("browser active=true")) {
    statusVerified = true;
  }
  if (event.type === "response" && event.id === "status") {
    if (!event.success) {
      finish(new Error(`browser-status failed: ${event.error}`));
      return;
    }
    setTimeout(() => {
      if (!statusVerified) finish(new Error("browser-status did not report browser active=true"));
      else finish();
    }, 100);
  }
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    onRecord(line);
  }
});
child.stderr.on("data", (chunk) => stderr.push(chunk));
child.once("error", (error) => finish(error));
child.once("exit", (code) => {
  if (!settled) finish(new Error(`pi RPC exited before validation (code ${code})`));
});

timer = setTimeout(() => finish(new Error("pi RPC extension-load validation timed out after 20s")), 20_000);
child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);

let failure = null;
try {
  await done;
} catch (error) {
  failure = error;
}

try { child.stdin.end(); } catch {}
await Promise.race([
  new Promise((resolve) => child.once("exit", resolve)),
  new Promise((resolve) => setTimeout(resolve, 3000)),
]);
if (child.exitCode === null) child.kill();

const evidence = {
  ok: !failure && commandsVerified && statusVerified,
  at: new Date().toISOString(),
  commandsVerified,
  statusVerified,
  extensionErrors: events.filter((event) => event.type === "extension_error"),
  stderr: Buffer.concat(stderr).toString("utf8").trim().slice(0, 4000),
  error: failure ? String(failure?.stack || failure) : null,
};
await fs.mkdir(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, `pi-load-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...evidence, evidenceFile }, null, 2));
if (!evidence.ok) process.exitCode = 1;
