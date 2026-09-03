// lop-swarm runtime —— 契约式子代理分工:
//   任务契约(verify.cmd 必填) → 队列认领(原子 rename) → 每任务 git worktree 隔离的子 pi 进程
//   → 宿主独立跑 verify → 独立验证者子进程(只看产物,不看生产者推理) → 文件态回收(status.json)。
// 纯 Node,无 pi 依赖,可单测(selftest.mjs)。启动方式抄 best-of-n.mjs(spawn node cli.js)与
// 上游 examples/extensions/subagent(--mode json -p --no-session --tools --append-system-prompt,message_end 解析)。
// 失败路径全部落 events.jsonl 与 status.json,不藏在调试开关后。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, exec, execFile } from "node:child_process";

export const SWARM_VERSION = "lop-swarm/0.1.0";
export const MAX_TASKS = 16;
export const MAX_SLOTS = 8;
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const ROLES = {
  worker: { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
  verifier: { tools: ["read", "grep", "find", "ls", "bash"] },
};

export const REASONS = [
  "ok", "missing-result", "invalid-result", "blocked", "child-timeout", "child-error", "aborted",
  "protected-modified", "verify-failed", "verify-timeout", "expect-mismatch",
  "verifier-failed", "verifier-missing-verdict", "verifier-invalid-verdict", "verifier-modified", "verifier-timeout",
  "isolation-failed", "error",
];

const WORKER_SYSTEM = `You are a lop-swarm worker: an isolated sub-agent executing exactly one contracted task inside the given working directory.
Rules:
1. Only the task contract defines success. The host runs the verify command independently after you finish; you may run it yourself to self-check.
2. Never modify protected files listed in the contract. Any change to them fails the task regardless of output.
3. Keep changes minimal and inside the working directory. Do not commit, push, or touch git state.
4. When finished (or blocked), you MUST write the result file at the exact path given, as JSON:
   {"id":"<task id>","status":"done"|"blocked","summary":"<=300 chars","files_changed":["relative/path"],"notes":"optional"}
   Use the write tool. Without this file the task is counted as failed.
5. No human is in the loop: never ask questions, never wait. Chat output is discarded; only files count.`;

const VERIFIER_SYSTEM = `You are a lop-swarm independent verifier. You receive ONLY the task contract, the host's verify-command output, the diff produced by the worker, and the worker's result.json. You never see the worker's reasoning.
Judge strictly from evidence: does the diff actually deliver the contracted deliverable, and does the verify output prove it? You may re-run read-only checks (tests, reading files). Do not modify any file; any modification invalidates your verdict.
You MUST write the verdict file at the exact path given, as JSON:
{"id":"<task id>","verdict":"pass"|"fail","reason":"<=200 chars","checks":["what you checked"]}
Use the write tool if available; otherwise use bash to write it. Chat output is discarded; only the file counts.`;

// ---------- 通用工具 ----------
export const nowIso = () => new Date().toISOString();
export const toPosix = (p) => String(p).replace(/\\/g, "/");
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}
export function appendEvent(runDir, event) {
  try { fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify({ ts: nowIso(), ...event }) + "\n"); } catch {}
}

export function swarmDataRoot(env = process.env) {
  if (env.PI_SWARM_DATA) return path.resolve(env.PI_SWARM_DATA);
  if (env.PI_PORTABLE_DATA) return path.join(path.resolve(env.PI_PORTABLE_DATA), "lop-swarm");
  return path.join(os.homedir(), ".pi", "agent", "lop-swarm");
}

// pi CLI 真实入口(Node24 spawn .cmd 会 EINVAL,必须 spawn node+js):env 覆盖 > 便携包 > 全局 npm。
export function detectPiCli(env = process.env) {
  const appdata = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const rel = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"];
  const home = env.PI_PORTABLE_HOME ? path.resolve(env.PI_PORTABLE_HOME) : "";
  const candidates = [
    env.PI_SWARM_CLI || "",
    env.PI_BESTOFN_CLI || "",
    home ? path.join(home, "app", ...rel) : "",
    home ? path.join(home, "app", "node_modules", "@agegr", "pi-web", ...rel) : "",
    home ? path.join(home, ...rel) : "",
    path.join(appdata, "npm", ...rel),
    path.join(appdata, "npm", "node_modules", "@agegr", "pi-web", ...rel),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

function runFile(file, args, { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, cwd, env,
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      stdout: String(stdout || ""), stderr: String(stderr || ""), timedOut: Boolean(error?.killed),
    }));
  });
}
export function runShell(command, { cwd, timeoutMs = 120000, env } = {}) {
  return new Promise((resolve) => {
    exec(command, {
      windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, cwd, env,
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      stdout: String(stdout || ""), stderr: String(stderr || ""), timedOut: Boolean(error?.killed),
    }));
  });
}
const git = (cwd, args, timeoutMs = 20000) =>
  runFile("git", ["-C", cwd, "-c", "core.quotepath=false", ...args], { timeoutMs });

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {}); } catch {}
  } else {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch {} }, 3000);
  }
}

// ---------- 契约校验 ----------
export function validatePlan(tasks, { cwd } = {}) {
  const errors = [];
  const seen = new Set();
  const normalized = [];
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, errors: ["tasks 为空"], tasks: [] };
  if (tasks.length > MAX_TASKS) errors.push(`tasks 超过 ${MAX_TASKS}`);
  const root = cwd ? path.resolve(cwd) : "";
  tasks.forEach((t, i) => {
    const id = String(t?.id ?? "").trim();
    const label = id || `#${i + 1}`;
    if (!ID_RE.test(id)) errors.push(`${label}: id 非法(小写字母数字 -_,≤40)`);
    if (seen.has(id)) errors.push(`${label}: id 重复`);
    seen.add(id);
    if (typeof t?.goal !== "string" || t.goal.trim().length < 8) errors.push(`${label}: goal 至少 8 字`);
    if (typeof t?.deliverable !== "string" || !t.deliverable.trim()) errors.push(`${label}: deliverable 必填`);
    const cmd = typeof t?.verify?.cmd === "string" ? t.verify.cmd.trim() : "";
    if (!cmd) errors.push(`${label}: verify.cmd 必填(缺判据的子任务不进入队列)`);
    let expect = "";
    if (t?.verify?.expect) {
      expect = String(t.verify.expect);
      try { new RegExp(expect); } catch { errors.push(`${label}: verify.expect 不是合法正则`); }
    }
    const role = t?.role ? String(t.role) : "worker";
    if (!ROLES[role]) errors.push(`${label}: role 未知 ${role}`);
    const protectedList = new Set((Array.isArray(t?.protected) ? t.protected : []).map((p) => toPosix(String(p).trim())).filter(Boolean));
    // 自动保护:verify.cmd 里指向仓内既有文件的 token(判据文件不许被子代理改)
    if (root && cmd) {
      for (const tok of cmd.split(/\s+/)) {
        const clean = tok.replace(/^["']|["']$/g, "");
        if (!clean || /^[-|&;<>]/.test(clean)) continue;
        const abs = path.resolve(root, clean);
        if (!abs.toLowerCase().startsWith(root.toLowerCase())) continue;
        try { if (fs.statSync(abs).isFile()) protectedList.add(toPosix(path.relative(root, abs))); } catch {}
      }
    }
    normalized.push({
      id, role,
      goal: typeof t?.goal === "string" ? t.goal.trim().slice(0, 4000) : "",
      deliverable: typeof t?.deliverable === "string" ? t.deliverable.trim().slice(0, 500) : "",
      inputs: Array.isArray(t?.inputs) ? t.inputs.map(String).slice(0, 20) : [],
      hints: typeof t?.hints === "string" ? t.hints.slice(0, 4000) : "",
      verify: { cmd, expect, timeoutMs: clamp(int(t?.verify?.timeoutMs) || 120000, 5000, 900000) },
      protected: [...protectedList].sort(),
    });
  });
  return { ok: errors.length === 0, errors, tasks: errors.length ? [] : normalized };
}

// ---------- run 目录 ----------
export function createRun({ cwd, tasks, options = {}, dataRoot = swarmDataRoot() }) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const runId = `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  const runDir = path.join(dataRoot, "runs", runId);
  for (const d of ["queue/pending", "queue/claimed", "queue/done", "queue/failed", "out", "prompts", "wt"]) {
    fs.mkdirSync(path.join(runDir, d), { recursive: true });
  }
  const run = { version: SWARM_VERSION, runId, cwd: path.resolve(cwd), createdAt: nowIso(), options, taskIds: tasks.map((t) => t.id) };
  writeJson(path.join(runDir, "run.json"), run);
  tasks.forEach((t, i) => {
    writeJson(path.join(runDir, "queue", "pending", `${String(i + 1).padStart(3, "0")}-${t.id}.json`), t);
  });
  appendEvent(runDir, { type: "run_created", tasks: tasks.length, cwd: run.cwd });
  return { runId, runDir, run };
}

export function listRuns(dataRoot = swarmDataRoot()) {
  const dir = path.join(dataRoot, "runs");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.sort().reverse().map((runId) => ({ runId, runDir: path.join(dir, runId) }));
}

export function resolveRunDir(runId, dataRoot = swarmDataRoot()) {
  if (!runId || /[\\/]/.test(runId)) return null;
  const runDir = path.join(dataRoot, "runs", runId);
  return fs.existsSync(path.join(runDir, "run.json")) ? runDir : null;
}

// ---------- 认领(原子 rename,跨槽/跨进程安全) ----------
export function claimNext(runDir, worker, capabilities = ["worker"]) {
  const pending = path.join(runDir, "queue", "pending");
  let names = [];
  try { names = fs.readdirSync(pending).filter((n) => n.endsWith(".json")).sort(); } catch { return null; }
  for (const name of names) {
    const task = readJson(path.join(pending, name));
    if (!task || !capabilities.includes(task.role || "worker")) continue;
    const dest = path.join(runDir, "queue", "claimed", worker);
    fs.mkdirSync(dest, { recursive: true });
    try {
      fs.renameSync(path.join(pending, name), path.join(dest, name));
    } catch (error) {
      if (["ENOENT", "EEXIST", "EPERM", "EBUSY"].includes(error?.code)) continue;
      throw error;
    }
    fs.appendFileSync(path.join(runDir, "claims.log"), `${nowIso()}\t${worker}\t${task.id}\t${name}\n`);
    appendEvent(runDir, { type: "claimed", worker, task: task.id });
    return { task, name };
  }
  return null;
}

function settleQueueFile(runDir, worker, name, status) {
  const from = path.join(runDir, "queue", "claimed", worker, name);
  const to = path.join(runDir, "queue", status === "done" ? "done" : "failed", name);
  try { fs.renameSync(from, to); } catch (error) { appendEvent(runDir, { type: "queue_settle_error", worker, name, error: String(error?.code || error) }); }
}

// ---------- 结果契约 ----------
export function collectResult(task, candidates) {
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { ok: false, reason: "invalid-result", path: file, errors: ["not JSON"] }; }
    const errors = [];
    if (raw?.id !== task.id) errors.push(`id 不符: ${String(raw?.id)}`);
    if (!["done", "blocked"].includes(raw?.status)) errors.push(`status 非法: ${String(raw?.status)}`);
    if (typeof raw?.summary !== "string" || !raw.summary.trim()) errors.push("summary 缺失");
    if (raw?.files_changed !== undefined && !Array.isArray(raw.files_changed)) errors.push("files_changed 非数组");
    if (errors.length) return { ok: false, reason: "invalid-result", path: file, errors };
    return {
      ok: true, path: file,
      result: {
        id: task.id, status: raw.status, summary: raw.summary.trim().slice(0, 600),
        files_changed: (raw.files_changed || []).map(String).slice(0, 100),
        notes: typeof raw.notes === "string" ? raw.notes.slice(0, 2000) : "",
      },
    };
  }
  return { ok: false, reason: "missing-result", path: null, errors: ["result.json 未写"] };
}

export function collectVerdict(task, candidates) {
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { ok: false, reason: "verifier-invalid-verdict", path: file }; }
    if (raw?.id !== task.id || !["pass", "fail"].includes(raw?.verdict)) return { ok: false, reason: "verifier-invalid-verdict", path: file };
    return {
      ok: true, path: file,
      verdict: { verdict: raw.verdict, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 400) : "", checks: Array.isArray(raw.checks) ? raw.checks.map(String).slice(0, 20) : [] },
    };
  }
  return { ok: false, reason: "verifier-missing-verdict", path: null };
}

export function protectedViolations(changed, protectedList) {
  const prot = new Set((protectedList || []).map(toPosix));
  return (changed || []).map(toPosix).filter((f) => prot.has(f));
}

// ---------- git 隔离 ----------
async function prepareIsolation(cwd) {
  const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.code !== 0 || !/true/.test(inRepo.stdout)) return { mode: "none", reason: "not-git" };
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return { mode: "none", reason: "no-commits" };
  let base = head.stdout.trim();
  const stash = await git(cwd, ["stash", "create"]);
  if (stash.code === 0 && stash.stdout.trim()) base = stash.stdout.trim();
  return { mode: "worktree", base };
}
async function copyUntracked(cwd, wt) {
  const st = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of st.stdout.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, "");
    if (!rel || rel.startsWith(".swarm/")) continue;
    const from = path.join(cwd, rel);
    const to = path.join(wt, rel);
    try {
      if (fs.statSync(from).isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    } catch {}
  }
}
async function addWorktree(cwd, base, wt) {
  const added = await git(cwd, ["worktree", "add", "--detach", wt, base], 60000);
  if (added.code !== 0) throw new Error(`worktree add: ${added.stderr.trim().slice(0, 200)}`);
  await copyUntracked(cwd, wt);
}
async function removeWorktree(cwd, wt) {
  await git(cwd, ["worktree", "remove", "--force", wt], 60000);
  await git(cwd, ["worktree", "prune"]);
}
export async function changedFiles(wt) {
  const st = await git(wt, ["status", "--porcelain", "--untracked-files=all"]);
  const files = [];
  for (const line of st.stdout.split("\n")) {
    if (!line.trim()) continue;
    let rel = line.slice(3).trim().replace(/^"|"$/g, "");
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop();
    rel = toPosix(rel);
    if (!rel || rel.startsWith(".swarm/")) continue;
    files.push(rel);
  }
  return files;
}
async function capturePatch(wt, file) {
  await git(wt, ["add", "-A", "--", ".", ":!.swarm"]);
  const diff = await git(wt, ["diff", "--cached", "--binary"], 60000);
  await git(wt, ["reset", "-q"]);
  fs.writeFileSync(file, diff.stdout);
  const diffLines = diff.stdout.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
  return { diffLines, sha256: crypto.createHash("sha256").update(diff.stdout).digest("hex") };
}

// ---------- 子 pi 进程 ----------
function extractText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}
export function spawnPi({ cli, args, cwd, env, timeoutMs, signal, logPath, onEvent }) {
  return new Promise((resolve) => {
    const result = {
      exit: null, timedOut: false, aborted: false, model: "", errorMessage: "", stderrTail: "", lastAssistantText: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    };
    let settled = false;
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const finish = () => { if (settled) return; settled = true; try { logStream.end(); } catch {} resolve(result); };
    let child;
    try {
      // 便携布局(对端无 ~/.pi)下 pi 的 agent 目录是 data\.pi\agent;launcher 已设则原样继承。
      const childEnv = { ...process.env, ...(env || {}), LOP_CHAIN_DISABLE: "1", PI_SWARM_CHILD: "1" };
      if (childEnv.PI_PORTABLE_DATA && !childEnv.PI_CODING_AGENT_DIR) {
        childEnv.PI_CODING_AGENT_DIR = path.join(path.resolve(childEnv.PI_PORTABLE_DATA), ".pi", "agent");
      }
      child = spawn(process.execPath, [cli, ...args], {
        cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
      });
    } catch (error) {
      result.stderrTail = String(error).slice(0, 300);
      return finish();
    }
    let buffer = "";
    const handleLine = (line) => {
      if (!line.trim()) return;
      logStream.write(line + "\n");
      let event;
      try { event = JSON.parse(line); } catch { return; }
      try { onEvent?.(event); } catch {}
      if (event.type === "message_end" && event.message && event.message.role === "assistant") {
        const m = event.message;
        result.usage.turns += 1;
        const u = m.usage || {};
        result.usage.input += u.input || 0;
        result.usage.output += u.output || 0;
        result.usage.cacheRead += u.cacheRead || 0;
        result.usage.cacheWrite += u.cacheWrite || 0;
        result.usage.cost += u.cost?.total || 0;
        if (m.model) result.model = m.model;
        if (m.errorMessage) result.errorMessage = String(m.errorMessage).slice(0, 300);
        const text = extractText(m);
        if (text) result.lastAssistantText = text;
      }
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line.replace(/\r$/, ""));
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      result.stderrTail = (result.stderrTail + s).slice(-2000);
      logStream.write("[stderr] " + s);
    });
    const timer = setTimeout(() => { result.timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { result.aborted = true; killTree(child); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    child.on("error", (error) => { clearTimeout(timer); result.stderrTail = (result.stderrTail + String(error)).slice(-2000); finish(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);
      result.exit = code;
      try { signal?.removeEventListener("abort", onAbort); } catch {}
      finish();
    });
  });
}

function writePrompt(runDir, name, text) {
  const file = path.join(runDir, "prompts", name);
  fs.writeFileSync(file, text);
  return file;
}
function renderWorkerTask(task, wt, resultPath) {
  return [
    "Task contract (JSON):",
    JSON.stringify(task, null, 2),
    "",
    `Working directory: ${toPosix(wt)}`,
    `Result file (MUST write when finished or blocked): ${toPosix(resultPath)}`,
    `Fallback result path if the primary path is not writable: .swarm/${task.id}/result.json (relative to the working directory)`,
    "Verify command the host will run in the working directory after you finish: " + task.verify.cmd,
    task.verify.expect ? `Host additionally requires the verify output to match regex: ${task.verify.expect}` : "",
    task.protected.length ? `Protected files (never modify): ${task.protected.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
function renderVerifierInput(task, { verifyText, patchText, resultJson, verdictPath, fallbackVerdict, wt }) {
  return [
    "# lop-swarm independent verification",
    "",
    `Working directory: ${toPosix(wt)}`,
    `Verdict file (MUST write): ${toPosix(verdictPath)}`,
    `Fallback verdict path if the primary path is not writable: ${fallbackVerdict}`,
    "",
    "## Task contract", "```json", JSON.stringify(task, null, 2), "```",
    "",
    "## Worker result.json (claims, unverified)", "```json", JSON.stringify(resultJson, null, 2), "```",
    "",
    "## Host verify output (authoritative)", "```", verifyText.slice(-4000), "```",
    "",
    "## Diff produced by the worker (head)", "```diff", patchText.slice(0, 24000), patchText.length > 24000 ? "\n... (truncated)" : "", "```",
  ].join("\n");
}

function baseArgs(role, sysPromptFile, options, forVerifier) {
  const args = ["--mode", "json", "-p", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates",
    "--tools", ROLES[role].tools.join(","), "--append-system-prompt", sysPromptFile];
  const model = forVerifier ? (options.verifierModel || options.model) : options.model;
  if (model) args.push("--model", model);
  if (options.thinking) args.push("--thinking", options.thinking);
  return args;
}

async function processTask({ run, runDir, task, name, worker, cli, isolation, options, signal, onProgress }) {
  const outDir = path.join(runDir, "out", task.id);
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const status = {
    id: task.id, worker, startedAt: nowIso(), status: "failed", reason: "", isolation: isolation.mode,
    childExit: null, model: "", verifyExit: null, expectOk: null, verdict: null, verdictReason: "",
    diffLines: 0, changedFiles: [], protectedViolations: [], resultSummary: "", usage: null, verifierUsage: null,
    durationMs: 0, artifacts: {},
  };
  const fail = (reason) => { status.status = "failed"; status.reason = reason; };
  let wt = run.cwd;
  let wtCreated = false;
  try {
    if (isolation.mode === "worktree") {
      wt = path.join(runDir, "wt", task.id);
      try { await addWorktree(run.cwd, isolation.base, wt); wtCreated = true; }
      catch (error) { fail("isolation-failed"); status.error = String(error.message || error).slice(0, 200); throw error; }
    }
    const resultPath = path.join(outDir, "result.json");
    const workerSys = writePrompt(runDir, `${task.id}-worker-system.md`, WORKER_SYSTEM);
    const taskPrompt = renderWorkerTask(task, wt, resultPath);
    fs.writeFileSync(path.join(outDir, "worker-prompt.md"), taskPrompt);
    onProgress?.(`${task.id}: ${worker} 执行中`);
    appendEvent(runDir, { type: "task_start", worker, task: task.id, wt: toPosix(wt) });
    const child = await spawnPi({
      cli, args: [...baseArgs(task.role, workerSys, options, false), taskPrompt], cwd: wt,
      timeoutMs: options.taskTimeoutMs, signal, logPath: path.join(outDir, "worker.log"),
    });
    status.childExit = child.exit;
    status.model = child.model;
    status.usage = child.usage;
    // 生产者最终话语只留档,不回传主链
    fs.writeFileSync(path.join(outDir, "worker-final.txt"), child.lastAssistantText || "");
    if (child.errorMessage) status.childError = child.errorMessage;

    const collected = collectResult(task, [resultPath, path.join(wt, ".swarm", task.id, "result.json")]);
    status.artifacts.result = collected.path ? toPosix(collected.path) : null;
    if (collected.ok) status.resultSummary = collected.result.summary;
    if (collected.errors) status.resultErrors = collected.errors;

    status.changedFiles = await changedFiles(wt);
    status.protectedViolations = protectedViolations(status.changedFiles, task.protected);
    let patchSha = "";
    if (isolation.mode === "worktree") {
      const patchFile = path.join(outDir, "patch.diff");
      const p = await capturePatch(wt, patchFile);
      status.diffLines = p.diffLines;
      patchSha = p.sha256;
      status.artifacts.patch = toPosix(patchFile);
    }
    const v = await runShell(task.verify.cmd, { cwd: wt, timeoutMs: task.verify.timeoutMs });
    const verifyText = `$ ${task.verify.cmd}\nexit=${v.code} timedOut=${v.timedOut}\n--- stdout ---\n${v.stdout}\n--- stderr ---\n${v.stderr}`;
    fs.writeFileSync(path.join(outDir, "verify.txt"), verifyText);
    status.artifacts.verify = toPosix(path.join(outDir, "verify.txt"));
    status.verifyExit = v.timedOut ? null : v.code;
    status.expectOk = task.verify.expect ? new RegExp(task.verify.expect).test(`${v.stdout}\n${v.stderr}`) : null;

    if (child.aborted) fail("aborted");
    else if (child.timedOut) fail("child-timeout");
    else if (!collected.ok) fail(collected.reason);
    else if (status.protectedViolations.length) fail("protected-modified");
    else if (collected.result.status === "blocked") fail("blocked");
    else if (v.timedOut) fail("verify-timeout");
    else if (v.code !== 0) fail("verify-failed");
    else if (status.expectOk === false) fail("expect-mismatch");
    else if (options.verifier === "pi") {
      onProgress?.(`${task.id}: 独立验证中`);
      const verdictPath = path.join(outDir, "verdict.json");
      const materials = renderVerifierInput(task, {
        verifyText, patchText: status.artifacts.patch ? fs.readFileSync(status.artifacts.patch, "utf8") : "(no isolation: diff unavailable)",
        resultJson: collected.result, verdictPath, fallbackVerdict: `.swarm/${task.id}/verdict.json`, wt,
      });
      const inputFile = path.join(outDir, "verifier-input.md");
      fs.writeFileSync(inputFile, materials);
      const verifierSys = writePrompt(runDir, `${task.id}-verifier-system.md`, VERIFIER_SYSTEM);
      const pointer = `Read the verification input file ${toPosix(inputFile)} with the read tool and follow it. Write the verdict JSON to ${toPosix(verdictPath)}.`;
      const vres = await spawnPi({
        cli, args: [...baseArgs("verifier", verifierSys, options, true), pointer], cwd: wt,
        timeoutMs: options.verifierTimeoutMs, signal, logPath: path.join(outDir, "verifier.log"),
      });
      status.verifierUsage = vres.usage;
      status.verifierExit = vres.exit;
      let verifierTouched = false;
      if (isolation.mode === "worktree") {
        const again = await capturePatch(wt, path.join(outDir, "patch.after-verifier.diff"));
        verifierTouched = again.sha256 !== patchSha;
        if (!verifierTouched) { try { fs.unlinkSync(path.join(outDir, "patch.after-verifier.diff")); } catch {} }
      }
      const verdict = collectVerdict(task, [verdictPath, path.join(wt, ".swarm", task.id, "verdict.json")]);
      status.artifacts.verdict = verdict.path ? toPosix(verdict.path) : null;
      if (vres.timedOut) fail("verifier-timeout");
      else if (verifierTouched) fail("verifier-modified");
      else if (!verdict.ok) fail(verdict.reason);
      else {
        status.verdict = verdict.verdict.verdict;
        status.verdictReason = verdict.verdict.reason;
        if (verdict.verdict.verdict === "pass") { status.status = "done"; status.reason = "ok"; }
        else fail("verifier-failed");
      }
    } else {
      status.status = "done";
      status.reason = "ok";
      status.verdict = "skipped";
    }
  } catch (error) {
    if (!status.reason) { fail("error"); status.error = String(error?.message || error).slice(0, 300); }
  } finally {
    if (wtCreated && !options.keepWorktrees) {
      try { await removeWorktree(run.cwd, wt); } catch (error) { appendEvent(runDir, { type: "worktree_remove_error", task: task.id, error: String(error?.message || error).slice(0, 200) }); }
    } else if (wtCreated) {
      status.artifacts.worktree = toPosix(wt);
    }
    status.durationMs = Date.now() - started;
    status.finishedAt = nowIso();
    writeJson(path.join(outDir, "status.json"), status);
    settleQueueFile(runDir, worker, name, status.status);
    appendEvent(runDir, { type: "task_end", worker, task: task.id, status: status.status, reason: status.reason, durationMs: status.durationMs });
    onProgress?.(`${task.id}: ${status.status}(${status.reason})`);
  }
  return status;
}

export async function runSwarm({
  runDir, workers = 2, verifier = "pi", model, verifierModel, thinking,
  taskTimeoutMs = 420000, verifierTimeoutMs = 240000, keepWorktrees = false,
  cli = detectPiCli(), signal, onProgress,
}) {
  const run = readJson(path.join(runDir, "run.json"));
  if (!run) throw new Error(`run.json 不存在: ${runDir}`);
  if (!cli) {
    appendEvent(runDir, { type: "run_error", error: "pi cli.js 不可用" });
    throw new Error("pi cli.js 不可用(PI_SWARM_CLI / PI_PORTABLE_HOME / npm 全局均未命中)");
  }
  const isolation = await prepareIsolation(run.cwd);
  const slots = isolation.mode === "worktree" ? clamp(int(workers) || 1, 1, MAX_SLOTS) : 1;
  const options = {
    verifier: verifier === "none" ? "none" : "pi", model, verifierModel, thinking,
    taskTimeoutMs: clamp(int(taskTimeoutMs) || 420000, 30000, 3600000),
    verifierTimeoutMs: clamp(int(verifierTimeoutMs) || 240000, 30000, 1800000),
    keepWorktrees: Boolean(keepWorktrees),
  };
  appendEvent(runDir, { type: "run_start", slots, isolation, cli: toPosix(cli), options });
  const started = Date.now();
  const statuses = [];
  await Promise.all(Array.from({ length: slots }, (_, i) => (async () => {
    const worker = `w${i + 1}`;
    while (!signal?.aborted) {
      const claimed = claimNext(runDir, worker, ["worker"]);
      if (!claimed) break;
      statuses.push(await processTask({ run, runDir, task: claimed.task, name: claimed.name, worker, cli, isolation, options, signal, onProgress }));
    }
  })()));
  const summary = buildSummary(run, runDir, statuses, { isolation: isolation.mode, slots, wallMs: Date.now() - started });
  writeJson(path.join(runDir, "summary.json"), summary);
  appendEvent(runDir, { type: "run_end", wallMs: summary.wallMs, counts: summary.counts });
  return summary;
}

function buildSummary(run, runDir, statuses, extra) {
  const tasks = [...statuses].sort((a, b) => a.id.localeCompare(b.id));
  const counts = { done: 0, failed: 0, pending: 0 };
  for (const t of tasks) counts[t.status === "done" ? "done" : "failed"] += 1;
  try { counts.pending = fs.readdirSync(path.join(runDir, "queue", "pending")).filter((n) => n.endsWith(".json")).length; } catch {}
  return { version: SWARM_VERSION, runId: run.runId, runDir: toPosix(runDir), cwd: toPosix(run.cwd), ...extra, counts, tasks };
}

export function readStatus(runDir) {
  const run = readJson(path.join(runDir, "run.json"));
  if (!run) return null;
  const statuses = [];
  try {
    for (const id of fs.readdirSync(path.join(runDir, "out"))) {
      const st = readJson(path.join(runDir, "out", id, "status.json"));
      if (st) statuses.push(st);
    }
  } catch {}
  const saved = readJson(path.join(runDir, "summary.json"));
  return buildSummary(run, runDir, statuses, { isolation: saved?.isolation || "?", slots: saved?.slots || 0, wallMs: saved?.wallMs || 0 });
}

// 主链只看这张确定性表格:不含任何子代理对话文本。
export function renderTable(summary) {
  if (!summary) return "run 不存在";
  const fmtTok = (u) => (u ? `${u.input}/${u.output}` : "-");
  const lines = [
    `lop-swarm run=${summary.runId} isolation=${summary.isolation} slots=${summary.slots} wall=${Math.round((summary.wallMs || 0) / 1000)}s done=${summary.counts.done} failed=${summary.counts.failed} pending=${summary.counts.pending}`,
    "| id | status | reason | verify | verdict | diff | files | worker | tok(in/out) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const t of summary.tasks) {
    const verify = t.verifyExit === null ? "timeout" : `exit ${t.verifyExit}${t.expectOk === false ? " expect✗" : ""}`;
    lines.push(`| ${t.id} | ${t.status} | ${t.reason}${t.verdictReason && t.verdict === "fail" ? `: ${t.verdictReason.slice(0, 80)}` : ""} | ${verify} | ${t.verdict ?? "-"} | ${t.diffLines} | ${t.changedFiles.length} | ${t.worker} | ${fmtTok(t.usage)} |`);
  }
  lines.push(`产物: ${summary.runDir}/out/<id>/{result.json,verify.txt,patch.diff,verdict.json,status.json}`);
  lines.push("子代理对话未注入主链;如需细节读上述文件。通过的任务用 swarm_apply 应用补丁。");
  return lines.join("\n");
}

// 把通过任务的补丁按序应用到主 cwd,并在主 cwd 复验 verify。
export async function applyRun({ runDir, ids }) {
  const summary = readStatus(runDir);
  if (!summary) throw new Error("run 不存在");
  const cwd = summary.cwd;
  const wanted = new Set(ids && ids.length ? ids : summary.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const rows = [];
  for (const t of summary.tasks) {
    if (!wanted.has(t.id)) continue;
    const row = { id: t.id, applied: false, verifyExit: null, reason: "" };
    const patch = path.join(runDir, "out", t.id, "patch.diff");
    if (t.status !== "done") { row.reason = `skip: status=${t.status}`; rows.push(row); continue; }
    if (!fs.existsSync(patch) || !fs.statSync(patch).size) { row.reason = "skip: empty patch"; rows.push(row); continue; }
    const check = await git(cwd, ["apply", "--check", "--binary", patch]);
    if (check.code !== 0) { row.reason = `apply --check failed: ${check.stderr.trim().slice(0, 160)}`; rows.push(row); continue; }
    const apply = await git(cwd, ["apply", "--binary", patch]);
    if (apply.code !== 0) { row.reason = `apply failed: ${apply.stderr.trim().slice(0, 160)}`; rows.push(row); continue; }
    row.applied = true;
    const task = readJson(path.join(runDir, "queue", "done", `${t.id}.json`)) || findTaskFile(runDir, t.id);
    if (task?.verify?.cmd) {
      const v = await runShell(task.verify.cmd, { cwd, timeoutMs: task.verify.timeoutMs || 120000 });
      row.verifyExit = v.timedOut ? null : v.code;
      row.reason = v.code === 0 ? "ok" : "verify failed in main cwd";
    } else row.reason = "applied (verify cmd not found)";
    rows.push(row);
  }
  appendEvent(runDir, { type: "apply", rows });
  return { runId: summary.runId, cwd, rows };
}
function findTaskFile(runDir, id) {
  for (const bucket of ["done", "failed", "pending"]) {
    const dir = path.join(runDir, "queue", bucket);
    try {
      for (const name of fs.readdirSync(dir)) if (name.endsWith(`-${id}.json`)) return readJson(path.join(dir, name));
    } catch {}
  }
  return null;
}
export function renderApply(result) {
  const lines = [`lop-swarm apply run=${result.runId} cwd=${result.cwd}`, "| id | applied | verify(main) | note |", "|---|---|---|---|"];
  for (const r of result.rows) lines.push(`| ${r.id} | ${r.applied ? "yes" : "no"} | ${r.verifyExit === null ? "-" : `exit ${r.verifyExit}`} | ${r.reason} |`);
  return lines.join("\n");
}
