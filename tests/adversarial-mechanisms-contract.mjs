// 对抗审查四机制合同测试(plan-first-gate-v15):
// P1 Best-of-N(指令解析/胜者选择/正交提示/CLI探测/结果渲染)
// P2 auto-gate(安全白名单/生成解析/双红判定)
// P3+P4 三路盲聚合+验证器投票(票型矩阵/lane解析)
// 以及 lop-chain.ts 源级接线钉。全部纯函数,零网络零子进程。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const bon = await import(pathToFileURL(path.join(root, "src", "chain", "best-of-n.mjs")).href);
const auto = await import(pathToFileURL(path.join(root, "src", "chain", "auto-gate.mjs")).href);
const adv = await import(pathToFileURL(path.join(root, "src", "chain", "portable-adversary.mjs")).href);

// ---- P1 指令解析 ----
assert.deepEqual(bon.parseBestOfNDirective("修复它\n【多候选】\n谢谢"), { n: 2 });
assert.deepEqual(bon.parseBestOfNDirective("【多候选】3"), { n: 3 });
assert.deepEqual(bon.parseBestOfNDirective("【多候选】9"), { n: 4 }); // 上限 4
assert.deepEqual(bon.parseBestOfNDirective("[best-of-n] 2"), { n: 2 });
assert.equal(bon.parseBestOfNDirective("普通消息,提到多候选概念但没有指令行"), null);
assert.equal(bon.parseBestOfNDirective(""), null);

// ---- P1 胜者选择:通过者取 diff 最小,平手取序号小,无通过者 null ----
assert.equal(bon.pickWinner([]), null);
assert.equal(bon.pickWinner([{ index: 0, gateExit: 1, diffLines: 5 }]), null);
assert.equal(bon.pickWinner([
  { index: 0, gateExit: 0, diffLines: 30 },
  { index: 1, gateExit: 0, diffLines: 8 },
  { index: 2, gateExit: 1, diffLines: 1 },
]).index, 1);
assert.equal(bon.pickWinner([
  { index: 0, gateExit: 0, diffLines: 8 },
  { index: 1, gateExit: 0, diffLines: 8 },
]).index, 0);

// ---- P1 正交提示:不同候选拿到不同策略约束,共享门命令与禁忌证据 ----
const p0 = bon.renderFanoutPrompt({ taskPrompt: "修复 X", gateCommand: "node v.mjs", bannedSummary: "- 第1轮 指纹=abc", index: 0, total: 2 });
const p1 = bon.renderFanoutPrompt({ taskPrompt: "修复 X", gateCommand: "node v.mjs", bannedSummary: "- 第1轮 指纹=abc", index: 1, total: 2 });
assert.notEqual(p0, p1);
for (const p of [p0, p1]) {
  assert.ok(p.includes("node v.mjs"));
  assert.ok(p.includes("指纹=abc"));
  assert.ok(p.includes("策略约束"));
  assert.ok(p.includes("禁止 git commit/push"));
}

// ---- P1 CLI 探测:env 覆盖优先,不存在则 null ----
const fakeCli = path.join(os.tmpdir(), `fake-pi-cli-${Date.now()}.js`);
fs.writeFileSync(fakeCli, "// fake", "utf8");
assert.equal(bon.detectPiCli({ PI_BESTOFN_CLI: fakeCli }), fakeCli);
assert.equal(bon.detectPiCli({ PI_BESTOFN_CLI: fakeCli + ".missing", APPDATA: os.tmpdir() }), null);
fs.unlinkSync(fakeCli);

// ---- P1 结果渲染 ----
const okOutcome = bon.renderBestOfNOutcome({
  ok: true, winner: { index: 1, diffLines: 8 },
  results: [{ index: 0, exit: 0, gateExit: 1, diffLines: 30, tail: "fail" }, { index: 1, exit: 0, gateExit: 0, diffLines: 8 }],
});
assert.ok(okOutcome.includes("候选2"));
assert.ok(okOutcome.includes("复验 exit=0"));
const failOutcome = bon.renderBestOfNOutcome({ ok: false, reason: "no-candidate-passed", results: [] });
assert.ok(failOutcome.includes("未产生通过者"));

// ---- P2 安全白名单:只读观测放行,写盘/状态/网络/进程全拒 ----
for (const good of [
  'node -e "process.exit(require(\'fs\').readFileSync(\'x.md\',\'utf8\').includes(\'y\')?0:1)"',
  // 引号内 ;/&&/> 属参数负载,不得误判为外层串接/重定向(E2 实测误拒样本)
  "node -e \"const s=require('fs').readFileSync('README.md','utf8');process.exit(s.includes('1.0.1')&&!s.includes('1.0.0')?0:1)\"",
  "node -e \"process.exit(require('fs').statSync('a.txt').size>10?0:1)\"",
  "grep -Fq '1.0.1' README.md && ! grep -Fq '1.0.0' README.md",
  "git status",
  "git diff --stat",
  "grep -r 'TODO' src",
  "node verify.mjs && git diff --stat",
  "test -f package.json",
  "cat README.md | grep 1.0.1",
]) assert.equal(auto.isSafeReadOnlyCommand(good), true, `should allow: ${good}`);
for (const bad of [
  "rm -rf /",
  "node -e \"require('fs').writeFileSync('x','y')\"",
  "git push origin main",
  "git checkout .",
  "echo hi > f.txt",
  "node check.mjs > out.txt",
  "curl -X POST http://x",
  "npm install left-pad",
  "powershell Remove-Item x",
  "node -e \"require('child_process').execSync('rm x')\"",
  "node -e \"process.kill(1)\"",
  "schtasks /create /tn x",
  "wget http://evil",
  "node -e \"fetch('http://x')\"",
  "taskkill /f /im node.exe",
  "多行\nnode -e 1",
  "node -e 1 `whoami`",
  "node -e 1 $(rm x)",
  "node ok.mjs < input.txt",
  "",
]) assert.equal(auto.isSafeReadOnlyCommand(bad), false, `should deny: ${bad}`);

// ---- P2 生成解析:JSON/围栏/垃圾 ----
assert.deepEqual(auto.parseGeneratedGate('{"commands":["git status","node v.mjs"]}').commands, ["git status", "node v.mjs"]);
assert.deepEqual(auto.parseGeneratedGate('```json\n{"commands":["git status"]}\n```').commands, ["git status"]);
assert.deepEqual(auto.parseGeneratedGate("这不是JSON").commands, []);
assert.deepEqual(auto.parseGeneratedGate('{"commands":[]}').commands, []);

// ---- P2 双红判定:改前必须红且红得干净(命令自身坏掉不算门) ----
assert.equal(auto.probeVerdict({ exitCode: 0, output: "" }), "green-before");
assert.equal(auto.probeVerdict({ exitCode: 1, output: "assertion failed: version still 1.0.0" }), "red");
assert.equal(auto.probeVerdict({ exitCode: 1, output: "SyntaxError: Unexpected token" }), "broken");
assert.equal(auto.probeVerdict({ exitCode: 1, output: "'nodee' is not recognized as an internal or external command" }), "broken");
assert.equal(auto.probeVerdict({ exitCode: null, output: "" }), "broken");
assert.equal(auto.probeVerdict({ exitCode: 1, output: "x", timedOut: true }), "broken");

// ---- P3+P4 票型矩阵:≥2/3 非空才 block;1 票 warn;完成路<2 fail-open ----
const lane = (done, ok, finding) => ({ done, ok, finding });
assert.equal(adv.aggregateVotes([lane(true, true, "a"), lane(true, true, "b"), lane(true, true, "c")]).decision, "block");
assert.equal(adv.aggregateVotes([lane(true, true, "a"), lane(true, true, "b"), lane(true, true, "")]).decision, "block");
assert.equal(adv.aggregateVotes([lane(true, true, "a"), lane(true, true, ""), lane(true, true, "")]).decision, "warn");
assert.equal(adv.aggregateVotes([lane(true, true, ""), lane(true, true, ""), lane(true, true, "")]).decision, "pass");
assert.equal(adv.aggregateVotes([lane(true, true, "a"), lane(true, false, ""), lane(false, false, "")]).decision, "fail-open");
assert.equal(adv.aggregateVotes([lane(false, false, ""), lane(false, false, ""), lane(false, false, "")]).decision, "fail-open");
assert.equal(adv.aggregateVotes([lane(true, true, "a"), lane(true, true, "b"), lane(false, false, "")]).decision, "block");
assert.equal(adv.aggregateVotes([lane(true, true, "a"), lane(true, true, ""), lane(false, false, "")]).decision, "warn");
assert.equal(adv.aggregateVotes([lane(true, true, "  "), lane(true, true, ""), lane(true, true, "")]).decision, "pass"); // 空白不算票
assert.equal(adv.aggregateVotes([]).decision, "fail-open");

// ---- P3 信息型请求分级:block 降 warn 的分类器(冻结种子集全对) ----
assert.equal(adv.isInfoOnlyRequest("查看当前目录有哪些 js 文件"), true);
assert.equal(adv.isInfoOnlyRequest("解释一下这个仓库的构建流程"), true);
assert.equal(adv.isInfoOnlyRequest("把 README.md 里的版本号从 1.0.0 改成 1.0.1"), false);
assert.equal(adv.isInfoOnlyRequest("优化一下这个项目的性能"), false);
assert.equal(adv.isInfoOnlyRequest("写一个日志轮转脚本"), false);
assert.equal(adv.isInfoOnlyRequest("为什么服务挂了?修好它"), false);
assert.equal(adv.isInfoOnlyRequest("分析下这个报错是什么"), true);

// ---- P3 lane 输出解析 ----
assert.deepEqual(adv.parseLaneFinding('{"finding":"只改一处即可"}'), { ok: true, finding: "只改一处即可" });
assert.deepEqual(adv.parseLaneFinding('```json\n{"finding":""}\n```'), { ok: true, finding: "" });
assert.equal(adv.parseLaneFinding("不是JSON").ok, false);

// ---- 方案先行(plan-first,v15):跳闸轮先作答再实施,作答轮不占预算 ----
const gr = await import(pathToFileURL(path.join(root, "src", "chain", "goal-redirector.mjs")).href);
assert.equal(gr.shouldInsertPlanRound({ mode: "normal", level: 0, planLevels: [] }), false);
assert.equal(gr.shouldInsertPlanRound({ mode: "evidence", level: 1, planLevels: [] }), true);
assert.equal(gr.shouldInsertPlanRound({ mode: "evidence", level: 1, planLevels: [1] }), false);
assert.equal(gr.shouldInsertPlanRound({ mode: "tabu", level: 2, planLevels: [1] }), true);
assert.equal(gr.shouldInsertPlanRound({ mode: "tabu", level: 2, planLevels: [1, 2] }), false);
assert.equal(gr.shouldInsertPlanRound({ mode: "", level: 0 }), false);
const planText = gr.renderPlanRound({ mode: "tabu", exitCode: 1, attempts: 1, max: 3, tail: "boom", bannedSummary: "- 第1轮 指纹=abc" });
assert.ok(planText.includes("只作答"));
assert.ok(planText.includes("禁止动手"));
assert.ok(planText.includes("已被实测证伪"));
assert.ok(planText.includes("延伸实施"));
const planNoBanned = gr.renderPlanRound({ mode: "evidence", exitCode: 1, attempts: 1, max: 3, tail: "boom", bannedSummary: "" });
assert.ok(!planNoBanned.includes("已被实测证伪"));
assert.ok(planNoBanned.includes("证据轮"));

// ---- lop-chain.ts 源级接线钉 ----
const source = fs.readFileSync(path.join(root, "src", "lop-chain.ts"), "utf8");
assert.match(source, /LOP_CHAIN_RUNTIME_VERSION = "s9-memory-direction-frontier-v21-sidecar-marker"/u);
assert.match(source, /LOP_CHAIN_DISABLE/u);
assert.match(source, /auto-gate\.mjs/u);
assert.match(source, /best-of-n\.mjs/u);
assert.match(source, /startBackgroundReview\(\{ session_id: sessionId, prompt, cwd: taskCwd \}\)/u);
assert.match(source, /AUTO_GATE DEMOTE/u);
assert.match(source, /BESTOFN START/u);
assert.match(source, /lop-best-of-n/u);
// v15 方案先行接线钉:分轮状态机+两段式默认文案+作答轮不占预算+fan-out 让位
assert.match(source, /GOAL_GATE PLAN_ROUND queued/u);
assert.match(source, /GOAL_GATE PLAN_CAPTURED/u);
assert.match(source, /planPending/u);
assert.match(source, /先基于已有数据作答/u);
assert.match(source, /按你上一条回复给出的方案延伸实施/u);
assert.match(source, /gate\.attempts -= 1/u);
assert.match(source, /!gate\.planPending && \(/u);
// 母本与仓副本逐字节一致(单一真源纪律)
const mother = "C:/Users/lop/.pi/agent/extensions/lop-chain.ts";
if (fs.existsSync(mother)) {
  assert.equal(fs.readFileSync(mother, "utf8").replace(/\r\n/g, "\n"), source.replace(/\r\n/g, "\n"), "母本与仓 src/lop-chain.ts 不一致");
}

console.log("adversarial-mechanisms-contract: ALL PASS");
