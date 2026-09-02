// 换向器合同:纯函数判定、git 指纹稳定性、经 lop-chain 目标门的真实集成
// (normal→evidence→tabu 阶梯 + 耗尽落账本)。跑法: node --test tests/goal-redirector-contract.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const contractData = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redirector-contract-"));
process.env.PI_PORTABLE_HOME = root;
process.env.PI_PORTABLE_DATA = contractData;
process.env.LOP_MEMORY_HOME = path.join(contractData, "memory");
process.env.LOP_MEMORY_DISABLE_PI_DISCOVERY = "1";
process.env.PI_CHAIN_SKIP_STARTUP_SCAN = "1";
// 合同测试禁止打真桥(S6 三路预审每条 prompt 3 个上游请求)。
process.env.PI_ADVERSARY_DISABLE = "1";
process.env.LOP_AUTO_GATE = "0"; // auto-gate 生成器同样经真桥出请求
process.env.PI_CHAIN_METRICS = path.join(contractData, "metrics.jsonl");
process.env.PI_CHAIN_LOG = path.join(contractData, "chain.log");
process.on("exit", () => fs.rmSync(contractData, { recursive: true, force: true }));

const redirector = await import(pathToFileURL(path.join(root, "src", "chain", "goal-redirector.mjs")).href);
const {
  normalizeVolatile, failureFingerprint, normalizeDiff, diffFingerprint,
  decideRedirect, captureWorkspace, evaluateGoalRound, renderChecklistRedirect, writeGoalLedger,
} = redirector;

// --- 归一化与指纹:易变数字不改变指纹,不同失败改变指纹 ---
assert.equal(normalizeVolatile("耗时 123ms  x=45%"), "耗时 # x=#");
assert.equal(
  failureFingerprint("FAIL case-a took 120ms\nok others"),
  failureFingerprint("FAIL case-a took 987ms\nok others"),
);
assert.notEqual(
  failureFingerprint("FAIL case-a"),
  failureFingerprint("FAIL case-b"),
);
// hunk 位置漂移不改变 diff 指纹
const hunkA = "diff --git a/x.js b/x.js\nindex 111..222 100644\n--- a/x.js\n+++ b/x.js\n@@ -10,3 +10,4 @@\n+const y = 1;";
const hunkB = "diff --git a/x.js b/x.js\nindex 333..444 100644\n--- a/x.js\n+++ b/x.js\n@@ -50,3 +50,4 @@\n+const y = 1;";
assert.equal(normalizeDiff(hunkA), normalizeDiff(hunkB));
assert.equal(diffFingerprint(hunkA, " M x.js"), diffFingerprint(hunkB, " M x.js"));

// --- 跳闸判定纯函数 ---
const r = (failFp, diffFp) => ({ failFp, diffFp });
assert.deepEqual(decideRedirect({ rounds: [r("f1", "d1")], prevLevel: 0 }).mode, "normal");
// 失败集停滞 → evidence
let d = decideRedirect({ rounds: [r("f1", "d1"), r("f1", "d2")], prevLevel: 0 });
assert.equal(d.mode, "evidence");
assert.deepEqual(d.tripped, ["failure-stagnant"]);
// 改动指纹命中历史任一轮(振荡回旧状态) → 跳闸
d = decideRedirect({ rounds: [r("f1", "d1"), r("f2", "d2"), r("f3", "d1")], prevLevel: 0 });
assert.deepEqual(d.tripped, ["diff-repeat"]);
// 已在 1 级再跳 → tabu;级别单调、封顶 2
d = decideRedirect({ rounds: [r("f1", "d1"), r("f1", "d1")], prevLevel: 1 });
assert.equal(d.mode, "tabu");
assert.equal(decideRedirect({ rounds: [r("f1", "d1"), r("f1", "d1")], prevLevel: 2 }).level, 2);
// 有进展(新失败集+新指纹)不跳闸,级别保持
d = decideRedirect({ rounds: [r("f1", "d1"), r("f2", "d2")], prevLevel: 1 });
assert.equal(d.mode, "normal");
assert.equal(d.level, 1);
// diffFp 为 null(非 git 仓)时只剩失败集信号,null 不参与重复判定
d = decideRedirect({ rounds: [r("f1", null), r("f2", null)], prevLevel: 0 });
assert.equal(d.mode, "normal");

// --- git 工作区指纹 ---
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redirector-repo-"));
const g = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
g("init", "-q");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.js"), "const a = 1;\n");
g("add", "-A"); g("commit", "-qm", "init");
fs.appendFileSync(path.join(repo, "a.js"), "const b = 2;\n");
const ws1 = await captureWorkspace(repo);
const ws2 = await captureWorkspace(repo);
assert.ok(ws1 && ws1.fingerprint);
assert.equal(ws1.fingerprint, ws2.fingerprint); // 同状态指纹稳定
assert.deepEqual(ws1.files, ["a.js"]);
fs.appendFileSync(path.join(repo, "a.js"), "const c = 3;\n");
const ws3 = await captureWorkspace(repo);
assert.notEqual(ws1.fingerprint, ws3.fingerprint); // 不同改动指纹不同
assert.equal(await captureWorkspace(path.join(os.tmpdir())), null); // 非 git 仓 → null
fs.rmSync(repo, { recursive: true, force: true });

// --- evaluateGoalRound: 文案分档 ---
let ev = await evaluateGoalRound({ cwd: "", output: "FAIL x", exitCode: 3, attempts: 1, max: 3, prevRounds: [], prevLevel: 0 });
assert.equal(ev.mode, "normal");
assert.equal(ev.content, null);
ev = await evaluateGoalRound({ cwd: "", output: "FAIL x", exitCode: 3, attempts: 2, max: 3, prevRounds: ev.rounds, prevLevel: ev.level });
assert.equal(ev.mode, "evidence");
assert.match(ev.content, /禁止再直接修改业务代码/u);
assert.match(ev.content, /禁止修改校验命令/u);
ev = await evaluateGoalRound({ cwd: "", output: "FAIL x", exitCode: 3, attempts: 3, max: 3, prevRounds: ev.rounds, prevLevel: ev.level });
assert.equal(ev.mode, "tabu");
assert.match(ev.content, /禁忌换路/u);
assert.match(ev.content, /已被实测证伪/u);
assert.match(renderChecklistRedirect({ mode: "evidence", tripped: ["failure-stagnant"], rounds: ev.rounds, open: ["终态"] }), /证据轮/u);
assert.match(renderChecklistRedirect({ mode: "tabu", tripped: ["failure-stagnant"], rounds: ev.rounds, open: ["终态"] }), /禁忌换路/u);
assert.equal(renderChecklistRedirect({ mode: "normal", rounds: ev.rounds, open: ["终态"] }), "");

// --- 账本落盘 ---
const ledgerFile = writeGoalLedger({
  dir: path.join(contractData, "goal-gate-ledger"), sessionId: "t-1", command: "node x.mjs", rounds: ev.rounds,
});
assert.ok(ledgerFile && fs.existsSync(ledgerFile));
const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
assert.equal(ledger.attempts, 3);
assert.ok(ledger.distilled);
assert.equal(ledger.rounds.length, 3);

// --- 集成:经 lop-chain 目标门走完 normal→evidence→tabu→exhausted 账本 ---
const sourcePath = path.join(root, "src", "lop-chain.ts");
const policy = await import(pathToFileURL(sourcePath).href + `?redirector=${Date.now()}`);
const handlers = new Map();
const sent = [];
const mockPi = {
  on(name, handler) {
    const list = handlers.get(name) || [];
    list.push(handler);
    handlers.set(name, list);
  },
  sendMessage(message, options) { sent.push({ message, options }); },
  sendUserMessage() { throw new Error("unexpected user-message fallback"); },
};
policy.default(mockPi);
const failPrompt = "跑回测直到达标\n【目标门】node -e \"console.error('assert failed: gap 3/10'); process.exit(3)\"";
const ctx = {
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => [{
    type: "message", id: "rd-user", message: { role: "user", content: failPrompt },
  }] },
};
const agentEnd = () => handlers.get("agent_end")[0]({
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "已执行,仍未达标。" }],
    stopReason: "stop",
  }],
}, ctx);
const gateMsgs = () => sent.filter((s) => s.message.customType === "lop-goal-gate");
await handlers.get("before_agent_start")[0]({ prompt: failPrompt });
await agentEnd();
await handlers.get("before_agent_start")[0]({ prompt: gateMsgs().at(-1).message.content });
await agentEnd();
await handlers.get("before_agent_start")[0]({ prompt: gateMsgs().at(-1).message.content });
await agentEnd();
// v15 方案先行:跳闸轮先"只作答"收敛方案(不占 attempts 预算),下一轮注入实施轮;
// planLevels 每 level 一次,封顶后回落 evidence/tabu 原文案。
assert.equal(gateMsgs().length, 3);
assert.equal(gateMsgs()[0].message.details.redirect, "normal");
assert.match(gateMsgs()[0].message.content, /目标门命令未通过/u);
assert.equal(gateMsgs()[1].message.details.redirect, "evidence");
assert.match(gateMsgs()[1].message.content, /只作答,禁止动手/u);
assert.equal(gateMsgs()[2].message.details.phase, "implement-after-plan");
assert.match(gateMsgs()[2].message.content, /延伸实施/u);
for (let round = 0; round < 4; round += 1) {
  await handlers.get("before_agent_start")[0]({ prompt: gateMsgs().at(-1).message.content });
  await agentEnd(); // tabu 方案轮→实施轮→tabu 原文案×2(attempts 2→3)
}
assert.equal(gateMsgs().length, 7);
assert.equal(gateMsgs()[3].message.details.redirect, "tabu");
assert.match(gateMsgs()[3].message.content, /只作答,禁止动手/u);
assert.match(gateMsgs()[5].message.content, /已被实测证伪/u);
assert.match(gateMsgs()[6].message.content, /禁忌换路/u);
await handlers.get("before_agent_start")[0]({ prompt: gateMsgs().at(-1).message.content });
await agentEnd(); // attempts=3 达上限 → exhausted,不再续跑,账本落盘
assert.equal(gateMsgs().length, 7);
const ledgerDir = path.join(contractData, "goal-gate-ledger");
const ledgers = fs.readdirSync(ledgerDir).filter((f) => f.endsWith(".json"));
assert.ok(ledgers.length >= 1, "耗尽后应有失败账本落盘");
const finalLedger = JSON.parse(fs.readFileSync(path.join(ledgerDir, ledgers.at(-1)), "utf8"));
// evaluate 只在真实跑门失败轮调用:轮1/2/4/6/7 + exhausted 终局=6(方案/实施轮不跑门)
assert.equal(finalLedger.rounds.length, 6);
assert.ok(finalLedger.distilled.trippedRounds >= 2);

console.log("goal-redirector contract: ALL PASS");
