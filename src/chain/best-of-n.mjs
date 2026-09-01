// Best-of-N 多候选并行 + goal-gate 筛选(文献依据:有执行验证器时重复采样是唯一
// 能持续吃算力的机制;Monkeys 15.9%→56%、SWE-World TTS@8 +13.2pp)。
// 触发:用户消息显式【多候选】N,或 LOP_BESTOFN_AUTO=1 时换向器 tabu 跳闸轮自动 N=2。
// 隔离:git stash create 捕获当前状态(不入 stash 栈)→ 每候选一个 detached worktree;
// 多样性:方法论正交指令(修复策略不同),不是 persona(同模型 persona 已被证伪);
// 筛选:每候选 worktree 内跑同一 goal-gate 命令,exit 0 为过;胜者取 diff 行数最小;
// 应用:git diff --binary → 主 cwd apply → 主 cwd 复验 goal-gate 才算 pass。
// 全程 fail-open:非 git 仓/git 失败/全候选失败/apply 冲突,回落单路续跑,零行为破坏。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile, spawn } from "node:child_process";

const BESTOFN_TIMEOUT_MS = Number(process.env.LOP_BESTOFN_TIMEOUT_MS || 360000);
const BESTOFN_GATE_TIMEOUT_MS = Number(process.env.LOP_GOAL_GATE_TIMEOUT_MS || 120000);
const BESTOFN_MAX = 4;

const DIRECTIVE_LINE = /^\s*(?:【多候选】|\[best-of-n\])\s*(\d*)\s*$/miu;

export function parseBestOfNDirective(prompt) {
  const match = String(prompt || "").match(DIRECTIVE_LINE);
  if (!match) return null;
  const n = Math.min(BESTOFN_MAX, Math.max(2, Number(match[1] || 2)));
  return { n };
}

// 方法论正交(不是 persona):每候选一条不同的求解策略约束,共享全部失败证据。
const STRATEGIES = [
  "策略约束:做最小定向修复——只改最少的行让校验命令通过,不做任何顺带重构。",
  "策略约束:先写一个最小复现脚本确认根因,再基于复现证据修复;禁止在没有复现前改业务代码。",
  "策略约束:换实现路径——假设此前的修法方向本身是错的,从另一个模块/层次重新实现,禁止提交与失败历史等价的改动。",
  "策略约束:先审查相关配置与调用链上游,优先检查是配置/环境问题而非代码逻辑问题。",
];

export function renderFanoutPrompt({ taskPrompt, gateCommand, bannedSummary, index, total }) {
  return [
    `你是 ${total} 个并行候选执行者中的第 ${index + 1} 个,各自独立完成同一任务,最终由确定性校验命令选出通过者。`,
    `任务:\n${String(taskPrompt || "").trim()}`,
    `完成判据(会在你的工作目录里执行,exit 0 才算完成):\n${gateCommand}`,
    bannedSummary ? `已被实测证伪的路径(禁止提交等价改动):\n${bannedSummary}` : "",
    STRATEGIES[index % STRATEGIES.length],
    "只修改本工作目录内的文件;禁止 git commit/push、禁止修改校验命令本身或伪造其输入。完成后自己先跑一遍校验命令确认。",
  ].filter(Boolean).join("\n\n");
}

// 通过者中 diff 行数最小(改动最小者优先);平手取序号小。无通过者返回 null。
export function pickWinner(candidates) {
  const passed = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.gateExit === 0);
  if (!passed.length) return null;
  passed.sort((a, b) => (a.diffLines - b.diffLines) || (a.index - b.index));
  return passed[0];
}

export function renderBestOfNOutcome(result) {
  const rows = (result?.results || []).map((c) =>
    `- 候选${c.index + 1}: 执行exit=${c.exit ?? "-"} 校验exit=${c.gateExit ?? "-"} diff行=${c.diffLines ?? "-"}${c.tail ? ` 失败尾部:${String(c.tail).slice(-160)}` : ""}`);
  if (result?.ok) {
    return `多候选并行(${result.results.length}路)已选出通过校验的最小改动并应用到工作区(候选${result.winner.index + 1},diff ${result.winner.diffLines} 行),主工作区复验 exit=0。\n${rows.join("\n")}`;
  }
  return `多候选并行未产生通过者(${result?.reason || "unknown"});各候选证据:\n${rows.join("\n") || "-"}`;
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs || 30000, cwd: options.cwd, env: options.env,
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      stdout: String(stdout || ""), stderr: String(stderr || ""),
      timedOut: Boolean(error?.killed),
    }));
  });
}

const git = (cwd, args, timeoutMs = 20000) =>
  run("git", ["-C", cwd, "-c", "core.quotepath=false", ...args], { timeoutMs });

// pi CLI 真实入口解析(Node24 spawn .cmd 会 EINVAL,必须 spawn node+js):
// env 覆盖 > 便携包内 > 全局 npm。返回 null 表示不可用(fail-open)。
export function detectPiCli(env = process.env) {
  const candidates = [
    env.PI_BESTOFN_CLI || "",
    env.PI_PORTABLE_HOME
      ? path.join(env.PI_PORTABLE_HOME, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
      : "",
    path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

function spawnCandidate({ cliPath, prompt, cwd, env, timeoutMs, log }) {
  return new Promise((resolve) => {
    let settled = false;
    let tail = "";
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(process.execPath, [cliPath, "-p", prompt], {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...env, LOP_CHAIN_DISABLE: "1" },
      });
    } catch (error) {
      return finish({ exit: null, tail: String(error).slice(0, 200), timedOut: false });
    }
    const keepTail = (chunk) => { tail = (tail + chunk).slice(-4000); };
    child.stdout?.on("data", keepTail);
    child.stderr?.on("data", keepTail);
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ exit: null, tail, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); finish({ exit: null, tail: String(error).slice(0, 200), timedOut: false }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ exit: code, tail, timedOut: false }); });
    log?.(`BESTOFN spawn pid=${child.pid} cwd=${cwd}`);
  });
}

function runGate(command, cwd) {
  return new Promise((resolve) => {
    const child = exec(command, {
      windowsHide: true, timeout: BESTOFN_GATE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      encoding: "utf8", cwd,
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === "number" ? error.code : null) : 0,
      output: `${stdout || ""}\n${stderr || ""}`.trim(),
    }));
    child.unref?.();
  });
}

async function copyUntracked(mainCwd, worktreeCwd) {
  const status = await git(mainCwd, ["status", "--porcelain"]);
  if (status.code !== 0) return 0;
  const files = status.stdout.split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
    .filter(Boolean).slice(0, 200);
  let copied = 0;
  for (const file of files) {
    try {
      const from = path.join(mainCwd, file);
      const to = path.join(worktreeCwd, file);
      const stat = fs.statSync(from);
      if (stat.isDirectory()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    } catch {}
  }
  return copied;
}

// 主流程。返回 { ok, winner, results, reason };调用方拿 ok 决定 pass 还是把
// renderBestOfNOutcome 并入续跑文案。任何异常都被吞成 { ok:false, reason } (fail-open)。
export async function runBestOfN({ cwd, gateCommand, taskPrompt, n, bannedSummary, log }) {
  const note = (line) => { try { log?.(line); } catch {} };
  const results = [];
  const worktrees = [];
  try {
    if (!cwd || !fs.existsSync(cwd)) return { ok: false, results, reason: "no-cwd" };
    const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inRepo.code !== 0 || !/true/.test(inRepo.stdout)) return { ok: false, results, reason: "not-git" };
    const cliPath = detectPiCli();
    if (!cliPath) return { ok: false, results, reason: "pi-cli-not-found" };

    // 基底 = 当前工作区状态:stash create 只造 commit 对象,不入 stash 栈、不动工作区。
    let base = "HEAD";
    const stash = await git(cwd, ["stash", "create", "lop-bestofn-base"]);
    if (stash.code === 0 && stash.stdout.trim()) base = stash.stdout.trim();

    const total = Math.min(BESTOFN_MAX, Math.max(2, Number(n) || 2));
    const stampRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lop-bestofn-"));
    for (let index = 0; index < total; index += 1) {
      const wt = path.join(stampRoot, `cand-${index + 1}`);
      const added = await git(cwd, ["worktree", "add", "--detach", wt, base], 60000);
      if (added.code !== 0) { note(`BESTOFN worktree-add fail cand${index + 1}: ${added.stderr.slice(0, 160)}`); continue; }
      worktrees.push(wt);
      await copyUntracked(cwd, wt);
    }
    if (worktrees.length < 2) return { ok: false, results, reason: "worktree-unavailable" };

    note(`BESTOFN fanout n=${worktrees.length} base=${base.slice(0, 12)} timeout=${BESTOFN_TIMEOUT_MS}ms`);
    const runs = await Promise.all(worktrees.map((wt, index) =>
      spawnCandidate({
        cliPath,
        prompt: renderFanoutPrompt({ taskPrompt, gateCommand, bannedSummary, index, total: worktrees.length }),
        cwd: wt, env: process.env, timeoutMs: BESTOFN_TIMEOUT_MS, log,
      })));

    for (let index = 0; index < worktrees.length; index += 1) {
      const wt = worktrees[index];
      const gate = await runGate(gateCommand, wt);
      let diffLines = Number.MAX_SAFE_INTEGER;
      await git(wt, ["add", "-A"], 30000);
      const diff = await git(wt, ["diff", "--cached", "--binary", base], 30000);
      if (diff.code === 0) diffLines = diff.stdout ? diff.stdout.split("\n").length : 0;
      results.push({
        index, worktree: wt, exit: runs[index].exit, timedOut: runs[index].timedOut,
        gateExit: gate.code, diffLines,
        diffPatch: gate.code === 0 ? diff.stdout : "",
        tail: gate.code === 0 ? "" : (gate.output || runs[index].tail || "").slice(-400),
      });
      note(`BESTOFN cand${index + 1} exit=${runs[index].exit} gateExit=${gate.code} diffLines=${diffLines}`);
    }

    const winner = pickWinner(results);
    if (!winner) return { ok: false, results, reason: "no-candidate-passed" };
    if (winner.diffLines > 0) {
      const patchFile = path.join(stampRoot, "winner.patch");
      fs.writeFileSync(patchFile, winner.diffPatch, "utf8");
      const applied = await git(cwd, ["apply", "--whitespace=nowarn", patchFile], 30000);
      if (applied.code !== 0) return { ok: false, results, winner, reason: `apply-failed:${applied.stderr.slice(0, 160)}` };
    }
    const verify = await runGate(gateCommand, cwd);
    if (verify.code !== 0) return { ok: false, results, winner, reason: `main-verify-failed:exit=${verify.code}` };
    note(`BESTOFN winner=cand${winner.index + 1} diffLines=${winner.diffLines} main-verify=0`);
    return { ok: true, results, winner, reason: "pass" };
  } catch (error) {
    return { ok: false, results, reason: String(error).slice(0, 200) };
  } finally {
    for (const wt of worktrees) {
      await git(cwd, ["worktree", "remove", "--force", wt], 30000).catch(() => {});
    }
    await git(cwd, ["worktree", "prune"], 15000).catch(() => {});
  }
}
