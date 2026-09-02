// 目标门换向器:同路无进展时不停跑,强制换方向。T1 证据轮(禁补丁,先产新证据)、
// T2 禁忌换路(封死已证伪路径)、预算耗尽落失败账本(已试路径+已排除假设,供人裁决或新会话蒸馏重启)。
// 全部判定为确定性指纹比对(diff/失败集归一化哈希),零模型参与。
// 调用方(lop-chain.ts 目标门 retry 分支)必须 fail-open:本模块任何异常都回落原始续跑文案。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const sha16 = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

// 归一化:去 ANSI/时间戳/耗时/计数等易变数字与多余空白,让"同样的失败"跨轮指纹稳定。
export function normalizeVolatile(text) {
  return String(text || "")
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\d+(?:\.\d+)?(?:ms|s|%)?/g, "#")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim();
}

const FAIL_LINE_RE = /fail|error|err!|✖|×|exception|assert|失败|不符|未通过|缺失|超时|拒绝|expected|missing|cannot|unable|denied/iu;

export function failureFingerprint(output) {
  const norm = normalizeVolatile(output);
  const lines = norm.split("\n").filter((line) => FAIL_LINE_RE.test(line));
  return sha16(lines.length ? lines.join("\n") : norm.slice(-2000));
}

// diff 归一化:去 hunk 位置/index/±++ 头,只留改动内容与上下文 → 行号漂移不改变指纹。
export function normalizeDiff(diffText) {
  return String(diffText || "").split("\n")
    .filter((line) => !/^(index |@@ |--- |\+\+\+ )/.test(line))
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n").trim();
}

export function diffFingerprint(diffText, statusText) {
  return sha16(`${normalizeDiff(diffText)}\n===\n${normalizeVolatile(statusText)}`);
}

function git(cwd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "-c", "core.quotepath=false", ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : String(stdout || "")));
  });
}

// 工作区改动指纹。非 git 仓/无 cwd → null(S1/S3 信号不可用,只剩失败集停滞信号)。
export async function captureWorkspace(cwd) {
  if (!cwd || typeof cwd !== "string" || !fs.existsSync(cwd)) return null;
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status === null) return null;
  const diff = (await git(cwd, ["diff", "HEAD"])) ?? "";
  const files = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).slice(0, 40);
  return { fingerprint: diffFingerprint(diff, status), files };
}

// 跳闸判定(纯函数)。信号:S1/S3 改动指纹命中历史任一轮(同路补丁或振荡回到旧状态);
// S2 失败集与上一轮完全相同(无新进展)。跳闸即升一级,级别单调不降。
export function decideRedirect({ rounds, prevLevel = 0 }) {
  const cur = rounds[rounds.length - 1];
  const prior = rounds.slice(0, -1);
  const tripped = [];
  if (cur?.diffFp && prior.some((r) => r.diffFp === cur.diffFp)) tripped.push("diff-repeat");
  const prev = prior[prior.length - 1];
  if (prev && cur && prev.failFp === cur.failFp) tripped.push("failure-stagnant");
  if (!tripped.length) return { level: prevLevel, mode: "normal", tripped };
  const level = Math.min(prevLevel + 1, 2);
  return { level, mode: level === 1 ? "evidence" : "tabu", tripped };
}

const TRIP_LABEL = { "diff-repeat": "改动指纹重复(同路补丁)", "failure-stagnant": "失败集停滞(无新进展)" };
const HARD_CLAUSE = "禁止修改校验命令、其判定逻辑或伪造其输入数据。若有证据表明目标在当前约束下不可达,停止尝试并给出量化差距与原因,由用户决定是否放宽。";

function firstFailLine(output) {
  const lines = String(output || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => FAIL_LINE_RE.test(l)) || lines[lines.length - 1] || "").slice(0, 160);
}

function renderEvidence({ exitCode, attempts, max, tail, tripped }) {
  const why = tripped.map((t) => TRIP_LABEL[t] || t).join("、");
  return `目标门命令未通过(exit=${exitCode},自动续跑 ${attempts}/${max}),换向器判定:${why}。` +
    `本轮禁止再直接修改业务代码——先产出新证据:三选一,(1)写最小复现脚本并运行 (2)在失败路径加日志埋点并重跑目标门命令 (3)读取此前未读过的相关文件/配置。` +
    `拿到新证据后重新陈述根因假设,下一轮再改代码。命令输出尾部:\n${tail}\n\n` +
    `继续执行原始任务,直到目标门命令通过。${HARD_CLAUSE}`;
}

function renderTabu({ exitCode, attempts, max, tail, rounds, tripped }) {
  const why = tripped.map((t) => TRIP_LABEL[t] || t).join("、");
  const banned = rounds
    .filter((r) => r.diffFp || r.outputHead)
    .map((r) => `- 第${r.attempt}轮 exit=${r.exitCode}${r.diffFp ? ` 改动指纹=${r.diffFp}` : ""}${r.files?.length ? ` 涉及:${r.files.slice(0, 6).join(", ")}` : ""}${r.outputHead ? ` 失败:${r.outputHead}` : ""}`)
    .join("\n");
  return `目标门命令未通过(exit=${exitCode},自动续跑 ${attempts}/${max}),换向器进入禁忌换路:${why}。` +
    `以下路径已被实测证伪,禁止再提交等价改动:\n${banned}\n` +
    `换一个假设——换模块、换层次或换根因方向重新推进;动手前先用一句话说明新假设与旧路径的本质区别。` +
    `若所有可行假设都已排除,停止尝试并给出量化差距与已排除假设清单,由用户决定。命令输出尾部:\n${tail}\n\n${HARD_CLAUSE}`;
}

// 每轮失败调用一次:记录指纹→判定→给出替换文案(mode=normal 时 content=null,调用方用原文案)。
export async function evaluateGoalRound({ cwd, output, exitCode, attempts, max, prevRounds = [], prevLevel = 0 }) {
  const ws = await captureWorkspace(cwd).catch(() => null);
  const round = {
    attempt: attempts, exitCode: exitCode ?? null, at: new Date().toISOString(),
    failFp: failureFingerprint(output), diffFp: ws ? ws.fingerprint : null,
    files: ws ? ws.files : [], outputHead: firstFailLine(output),
  };
  const rounds = [...prevRounds, round];
  const decision = decideRedirect({ rounds, prevLevel });
  round.mode = decision.mode;
  round.tripped = decision.tripped;
  const tail = String(output || "").slice(-600);
  const content = decision.mode === "evidence"
    ? renderEvidence({ exitCode, attempts, max, tail, tripped: decision.tripped })
    : decision.mode === "tabu"
      ? renderTabu({ exitCode, attempts, max, tail, rounds, tripped: decision.tripped })
      : null;
  return { round, rounds, level: decision.level, mode: decision.mode, tripped: decision.tripped, content };
}

// persistent checklist 专用文案：复用同一确定性指纹和升级状态，但不把 checklist
// 伪装成可执行目标门。换向优先于延期；前台 sleep 永远不算进展。
export function renderChecklistRedirect({ mode, tripped = [], rounds = [], open = [] }) {
  if (!mode || mode === "normal") return "";
  const why = tripped.map((item) => TRIP_LABEL[item] || item).join("、") || "开放项无可辨别进展";
  const openText = [...new Set(open.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 8).map((item) => `- ${item}`).join("\n");
  if (mode === "evidence") {
    return `【Checklist 换向器：证据轮】判定:${why}。以下开放项仍无可辨别进展:\n${openText}\n` +
      `禁止重复上一方案，禁止用 sleep、轮询或超长 timeout 等待未来事件。先生成至少 2 条相互独立、尚未实测且不违反硬边界的方向 frontier；本轮立即执行信息增益/成本最高的一条并取得新证据。`;
  }
  const banned = rounds.slice(-6).map((round) =>
    `- 第${round.attempt}轮 failure=${round.failFp}${round.outputHead ? ` 证据:${round.outputHead}` : ""}`,
  ).join("\n");
  return `【Checklist 换向器：禁忌换路】判定:${why}。以下重复路径已进入 tabu，禁止等价重试:\n${banned}\n` +
    `换模块、换层次或换根因假设；动手前说明新方向与旧路径的本质区别，然后立即执行。只有所有合法方向均有耗尽证据时才允许持久化 deferred；不得保持前台等待，deferred 也不是终态完成。`;
}

// 方案先行(plan-first,2026-09-01 lop 裁决):门未通过时不再让模型直接重做——
// 换向器跳闸(同路无进展)即先强制"作答轮":基于已有数据收敛出完整通过方案(禁动手),
// 下一轮按方案延伸实施。作答不是尝试,不占 attempts 预算;每个升级 level 只插一次(有界)。
export function shouldInsertPlanRound({ mode, level, planLevels }) {
  if (!mode || mode === "normal") return false;
  return !(Array.isArray(planLevels) && planLevels.includes(level));
}

export function renderPlanRound({ mode, exitCode, attempts, max, tail, bannedSummary }) {
  const label = mode === "tabu" ? "禁忌换路" : "证据轮";
  return `目标门命令未通过(exit=${exitCode},自动续跑 ${attempts}/${max}),换向器判定同路无进展(${label})。\n` +
    `【本轮只作答,禁止动手】不要修改任何文件,也不要执行任何修复或取证命令。基于已有数据作答:\n` +
    `综合此前轮次的全部证据(下方失败输出、已证伪路径、你已读过的文件与运行结果),给出你判断能让目标门命令通过的完整方案:\n` +
    `1) 根因判断及其依据 2) 要改的具体文件与位置 3) 为何此方案能让门命令通过 4) 与已证伪路径的本质区别。\n` +
    `若已有数据确实不足以下结论,明确列出缺什么证据与最小获取方式,下一轮先取证再实施。\n` +
    (bannedSummary ? `已被实测证伪的路径(禁止等价改动):\n${bannedSummary}\n` : "") +
    `命令输出尾部:\n${tail}\n\n下一轮将按你的方案延伸实施。${HARD_CLAUSE}`;
}

// 预算耗尽:失败账本落盘。账本即交付物——已试路径、已排除假设、每轮证据,供人裁决或新会话重启。
export function writeGoalLedger({ dir, sessionId, command, rounds }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${sessionId}.json`);
    const uniqueDiff = new Set(rounds.map((r) => r.diffFp).filter(Boolean));
    fs.writeFileSync(file, JSON.stringify({
      sessionId, command, writtenAt: new Date().toISOString(), attempts: rounds.length,
      distilled: {
        uniqueChangePaths: uniqueDiff.size,
        trippedRounds: rounds.filter((r) => r.tripped?.length).length,
        excludedHypotheses: rounds.filter((r) => r.diffFp).map((r) => ({
          attempt: r.attempt, diffFp: r.diffFp, files: r.files, evidence: r.outputHead,
        })),
      },
      rounds,
    }, null, 2), "utf8");
    return file;
  } catch { return null; }
}
