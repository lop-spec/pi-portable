// 验收命令自动生成(auto goal-gate):执行型任务无显式【目标门】时,后台由独立 LLM
// 调用生成 2 条候选只读验证命令(生成侧多候选=验证器投票的生成面),经确定性安全
// 过滤 + 双红基线(改前必须 exit!=0,证明有判别力;AlphaCodium/mech-check L2 同款
// 纪律,防自测试假阳性——Reflexion 在 MBPP 上翻车的根因)后,安装为 auto goal-gate,
// 复用 goal-gate 现有 retry/换向器/账本全链。显式门永远优先;全程 fail-open。
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

const AUTO_GATE_GEN_TIMEOUT_MS = Number(process.env.LOP_AUTO_GATE_GEN_TIMEOUT_MS || 45000);
const AUTO_GATE_PROBE_TIMEOUT_MS = Number(process.env.LOP_AUTO_GATE_PROBE_TIMEOUT_MS || 60000);

// 白名单起始 token(分段后每段独立判):只读观测类。
const SAFE_HEAD = /^(?:node|git|grep|findstr|cat|type|ls|dir|test|wc|head|tail|diff|cmp|stat)\b/u;
const SAFE_GIT_SUB = /^git\s+(?:status|diff|log|show|grep|ls-files)\b/u;
// 黑 token(任意位置含引号内,大小写不敏感):写盘/状态变更/网络/进程/包管理。
// 注意 ">" 不在这里——引号内 > 是合法比较运算符,重定向在摘引号后的结构层拦。
const DENY = new RegExp([
  "\\brm\\b", "\\bdel\\b", "\\brmdir\\b", "\\bmv\\b", "\\bmove\\b", "\\bcp\\b", "\\bcopy\\b",
  "\\bpush\\b", "\\bcommit\\b", "\\bcheckout\\b", "\\breset\\b", "\\bclean\\b", "\\bstash\\b",
  "invoke-", "remove-", "set-", "add-content", "out-file", "start-process",
  "\\bschtasks\\b", "\\breg\\b", "\\bnetsh\\b", "\\btaskkill\\b", "\\bshutdown\\b", "\\bformat\\b",
  "npm\\s+i", "\\bpip\\b", "\\bwget\\b", "curl\\s+-x", "\\bfetch\\s*\\(", "http\\.request",
  "writefilesync", "appendfilesync", "\\bunlink", "rmsync", "renamesync", "mkdirsync", "copyfilesync",
  "child_process", "execsync", "\\bspawn", "process\\.kill",
].join("|"), "iu");

export function isSafeReadOnlyCommand(command) {
  const text = String(command || "").trim();
  if (!text || text.length > 500 || /[\r\n]/u.test(text)) return false;
  if (DENY.test(text)) return false;
  // 引号内容属参数负载(黑 token 已全文检查过);摘除后才能正确判外层结构,
  // 否则 node -e "a;b" 的引号内 ;/&& 会被误当串接切段(E2 实测两条合法命令全被误拒)。
  const structural = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, '""');
  if (/[<>`]|\$\(/u.test(structural)) return false; // 外层禁重定向/反引号/子shell
  const segments = structural.split(/&&|\|\||;|\|/u).map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return false;
  for (const raw of segments) {
    const segment = raw.replace(/^!\s*/u, ""); // shell 取反是只读安全的
    if (!SAFE_HEAD.test(segment)) return false;
    if (/^git\b/u.test(segment) && !SAFE_GIT_SUB.test(segment)) return false;
  }
  return true;
}

export function parseGeneratedGate(text) {
  const body = String(text || "").trim()
    .replace(/^```(?:json)?\s*/iu, "").replace(/```\s*$/u, "");
  try {
    const parsed = JSON.parse(body);
    const commands = (Array.isArray(parsed?.commands) ? parsed.commands : [])
      .map((command) => String(command || "").trim()).filter(Boolean).slice(0, 2);
    return { commands };
  } catch { return { commands: [] }; }
}

// 坏红:非零 exit 但根因是命令自身坏掉(语法错/工具缺失),任务做完也永远红,不能当门。
const BROKEN_RED = /SyntaxError|ReferenceError|is not recognized|command not found|no such file or directory.*\bnode\b|Usage:|无法将.*识别|不是内部或外部命令/iu;

export function probeVerdict({ exitCode, output, timedOut }) {
  if (timedOut || exitCode === null) return "broken";
  if (exitCode === 0) return "green-before"; // 改前就绿=无判别力,拒绝
  if (BROKEN_RED.test(String(output || ""))) return "broken";
  return "red"; // 合格的双红基线
}

function runProbe(command, cwd) {
  return new Promise((resolve) => {
    const child = exec(command, {
      windowsHide: true, timeout: AUTO_GATE_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      encoding: "utf8", ...(cwd && fs.existsSync(cwd) ? { cwd } : {}),
    }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
      output: `${stdout || ""}\n${stderr || ""}`.trim(),
      timedOut: Boolean(error?.killed),
    }));
    child.unref?.();
  });
}

const GEN_SYSTEM = [
  "你为一个即将执行的编码/运维任务生成验收命令。输出 JSON:{\"commands\":[\"cmd1\",\"cmd2\"]}。",
  "两条互为替代的单行验证命令,在任务工作目录执行,语义必须是:任务完成时 exit 0,任务未完成时非 0。",
  "执行环境是 Windows cmd.exe:grep/cat/ls 等 unix 工具可能不存在,node 和 git 必定可用——",
  "首选 node -e 形态(如 node -e \"process.exit(require('fs').readFileSync('x','utf8').includes('y')?0:1)\")。",
  "硬约束:只读(禁止写文件、网络请求、改任何状态);只用 node/git(status|diff|log|show|grep|ls-files);",
  "node -e 内禁止 fs 写、child_process、网络、反引号与 shell 重定向;单行≤400字符;120秒内完成;",
  "不依赖可能不存在的测试框架或脚本——用最直接的文件存在性/内容断言;",
  "断言对象必须来自任务文本里明确提到的文件/内容/行为,禁止臆造路径。",
  "若任务不可机器验证(纯咨询/解释/主观判断),输出 {\"commands\":[]}。不要任何解释或 markdown 代码块。",
].join("\n");

function shallowListing(cwd) {
  try {
    return fs.readdirSync(cwd).slice(0, 50).join(", ");
  } catch { return ""; }
}

// bridge: async ({ system, user, maxTokens, timeoutMs }) => ({ ok, text })
export async function generateAcceptanceGate({ prompt, cwd, bridge, log }) {
  const note = (line) => { try { log?.(line); } catch {} };
  try {
    const listing = shallowListing(cwd);
    const reply = await bridge({
      system: GEN_SYSTEM,
      user: `任务:\n${String(prompt || "").slice(0, 3000)}\n\n工作目录文件(浅层):${listing || "(不可读)"}`,
      maxTokens: 600,
      timeoutMs: AUTO_GATE_GEN_TIMEOUT_MS,
    });
    if (!reply?.ok) return { command: "", reason: `bridge:${reply?.reason || "fail"}`, rejected: [] };
    const { commands } = parseGeneratedGate(reply.text);
    if (!commands.length) return { command: "", reason: "not-verifiable", rejected: [] };
    const rejected = [];
    for (const command of commands) {
      if (!isSafeReadOnlyCommand(command)) {
        rejected.push({ command, why: "unsafe" });
        note(`AUTO_GATE reject unsafe: ${command.slice(0, 160)}`);
        continue;
      }
      const probe = await runProbe(command, cwd);
      const verdict = probeVerdict(probe);
      if (verdict === "red") {
        note(`AUTO_GATE double-red ok exit=${probe.exitCode} cmd=${command.slice(0, 160)}`);
        return { command, reason: "double-red", beforeExit: probe.exitCode, rejected };
      }
      rejected.push({ command, why: verdict });
      note(`AUTO_GATE reject ${verdict} exit=${probe.exitCode} cmd=${command.slice(0, 160)}`);
    }
    return { command: "", reason: "no-candidate-survived", rejected };
  } catch (error) {
    return { command: "", reason: String(error).slice(0, 160), rejected: [] };
  }
}

// 会话内后台任务管理(内存态,与 portable-adversary 同风格)。
const jobs = new Map();

export function startAutoGate(ev) {
  const key = String(ev?.session_id || "");
  if (!key) return { status: "skip", reason: "no-session" };
  const job = { startedAt: Date.now(), done: false, result: null };
  jobs.set(key, job);
  generateAcceptanceGate(ev)
    .then((result) => { job.result = result; job.done = true; })
    .catch((error) => { job.result = { command: "", reason: String(error).slice(0, 120) }; job.done = true; });
  return { status: "started" };
}

export async function claimAutoGate({ session_id, waitMs = 5000 }) {
  const key = String(session_id || "");
  const job = jobs.get(key);
  if (!job) return { status: "none" };
  if (!job.done && waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (!job.done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!job.done) return { status: "pending" };
  jobs.delete(key);
  if (job.result?.command) {
    return { status: "ready", command: job.result.command, beforeExit: job.result.beforeExit };
  }
  return { status: "empty", reason: job.result?.reason || "unknown" };
}

export function dropAutoGate(ev) {
  jobs.delete(String(ev?.session_id || ""));
}
