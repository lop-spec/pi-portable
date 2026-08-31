import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const contractData = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-contract-"));
process.env.PI_PORTABLE_HOME = root;
process.env.PI_PORTABLE_DATA = contractData;
process.env.LOP_MEMORY_HOME = path.join(contractData, "memory");
process.env.LOP_MEMORY_DISABLE_PI_DISCOVERY = "1";
process.env.PI_CHAIN_SKIP_STARTUP_SCAN = "1";
process.env.PI_CHAIN_METRICS = path.join(contractData, "metrics.jsonl");
process.env.PI_CHAIN_LOG = path.join(contractData, "chain.log");
process.on("exit", () => fs.rmSync(contractData, { recursive: true, force: true }));
const sourcePath = process.env.LOP_CHAIN_SOURCE || path.join(root, "src", "lop-chain.ts");
const policy = await import(pathToFileURL(sourcePath).href + `?contract=${Date.now()}`);
const {
  default: lopChainExtension,
  auditRuleRouting,
  checklistGateDecision,
  completionGuardAlreadyQueued,
  completionGuardDecision,
  createChecklistGoalState,
  expandPrompt,
  firstChecklistForLatestUser,
  formatChecklistGateContinuation,
  freezeChecklistGoalContract,
  goalGateVerdict,
  historyUsageDecision,
  isContextDependentHistoryPrompt,
  latestChecklistGoalState,
  parseAcceptanceChecklist,
  parseGoalGateDirective,
  runtimeVersionFromSource,
  s6BlockDisposition,
  scopeLopChainContext,
  stripAcceptanceChecklist,
} = policy;

// S6 打回处置(修法四 2026-08-31):预审没见过执行轨迹的 block 属盲判,降级;
// db 案实录:已 read 目标文件仍被"未读取便猜测"打回,冤枉重跑 ~20s。
assert.equal(s6BlockDisposition({ status: "block", runHadTool: true, delivered: false }), "missed-window");
assert.equal(s6BlockDisposition({ status: "block", runHadTool: true, delivered: true }), "redeliver");
assert.equal(s6BlockDisposition({ status: "block", runHadTool: false, delivered: false }), "redeliver");
assert.equal(s6BlockDisposition({ status: "pass", runHadTool: true, delivered: false }), "none");
assert.equal(s6BlockDisposition({}), "none");

assert.equal(isContextDependentHistoryPrompt("继续"), true);
assert.equal(isContextDependentHistoryPrompt("确认一下"), true);
assert.equal(isContextDependentHistoryPrompt("具体怎么改，说明白"), true);
assert.equal(isContextDependentHistoryPrompt("不做1，其余的都做，也改到异机"), true);
assert.equal(isContextDependentHistoryPrompt("继续修复 8794 的 history 快路"), false);
assert.equal(isContextDependentHistoryPrompt("确认 30141 端口是否监听"), false);

const expanded = expandPrompt("检查 SSH 互通历史规则");
assert.ok(expanded.charRatio >= 3, JSON.stringify(expanded));
assert.ok([...expanded.forHistory].length >= [..."检查 SSH 互通历史规则"].length * 3);
assert.match(expanded.forHistory, /SSH[\s\S]*双向/iu);
assert.match(expanded.forRules, /规则语料|命中全集|oracle/u);

const fixtureRules = [
  { id: "ssh", trigger: "SSH", text: "ssh", alwaysOn: [] },
  { id: "remote", trigger: "远端", text: "remote", alwaysOn: [] },
  { id: "always", trigger: ".*", text: "always", alwaysOn: ["codex"] },
];
const fixtureRegistry = {
  matchRules(rules, input) {
    return rules.filter((rule) => new RegExp(rule.trigger, "i").test(input))
      .map((rule) => ({ rule, h: 1, len: 1 }));
  },
};
const routed = auditRuleRouting(fixtureRegistry, fixtureRules, "检查 SSH", "检查 SSH 远端");
assert.equal(routed.pass, true);
assert.deepEqual(routed.actualIds, ["remote", "ssh"]);
assert.deepEqual(routed.oracleIds, ["remote", "ssh"]);
assert.deepEqual(routed.fromExpansion.map((hit) => hit.rule.id), ["remote"]);
assert.equal(auditRuleRouting({ matchRules: () => [] }, fixtureRules, "检查 SSH", "检查 SSH 远端").pass, false);

const resolvedHistory = {
  hit: true,
  usageToken: "h_contract",
  summary20: "SSH双向免密已完成",
  full: "两台机器的 SSH 公钥认证与双向连接均通过。",
};
assert.equal(historyUsageDecision(
  resolvedHistory,
  "SSH 双向连接已经通过。\n<!-- history-used:h_contract -->",
).pass, true);
assert.equal(historyUsageDecision(
  resolvedHistory,
  "已完成。\n<!-- history-used:h_contract -->",
).pass, false);
assert.equal(historyUsageDecision(
  resolvedHistory,
  "当前证据与历史不一致，已明确说明冲突。\n<!-- history-conflict:h_contract -->",
).pass, true);
assert.equal(stripAcceptanceChecklist([
  "【验收清单】",
  "- [x] 只读检查文件",
  "- [~] 可选项：用户取消",
  "tools/sync.mjs 为 32039 字节。",
].join("\n")), "tools/sync.mjs 为 32039 字节。");

const oldChain = { role: "custom", customType: "lop-chain", content: "old" };
const oldGuard = { role: "custom", customType: "lop-completion-guard", content: "old guard" };
const oldGate = { role: "custom", customType: "lop-goal-gate", content: "old gate" };
const oldHistoryGuard = { role: "custom", customType: "lop-history-disposition-guard", content: "old history guard" };
const oldAdversary = { role: "custom", customType: "lop-adversary-redelivery", content: "old adversary" };
const currentChain = { role: "custom", customType: "lop-chain", content: "current" };
const unrelated = { role: "custom", customType: "other-extension", content: "keep" };
const oldSummary = {
  role: "compactionSummary",
  summary: "保留正文\n<history-resolved mode=\"exact\" relevance=\"1\">旧动态历史</history-resolved>\n继续保留",
};
const scoped = scopeLopChainContext([
  { role: "user", content: "first" },
  oldChain,
  oldGuard,
  oldGate,
  oldHistoryGuard,
  oldAdversary,
  unrelated,
  oldSummary,
  { role: "assistant", content: [] },
  { role: "user", content: "second" },
  currentChain,
  { role: "assistant", content: [] },
]);
assert.equal(scoped.includes(oldChain), false);
assert.equal(scoped.includes(oldGuard), false);
assert.equal(scoped.includes(oldGate), false);
assert.equal(scoped.includes(oldHistoryGuard), false);
assert.equal(scoped.includes(oldAdversary), false);
assert.equal(scoped.includes(unrelated), true);
assert.equal(scoped.includes(currentChain), true);
const scopedSummary = scoped.find((message) => message.role === "compactionSummary");
assert.match(scopedSummary.summary, /保留正文[\s\S]*继续保留/u);
assert.doesNotMatch(scopedSummary.summary, /history-resolved|旧动态历史/u);

const interrupted = {
  prompt: "后面我说的默认就是异机，看下还有这个问题",
  assistantText: "接下来我会直接在异机读取日志与配置，修正为便携目录，然后用真实对话请求验证。",
  stopReason: "stop",
  runHadTool: false,
  pendingMessages: false,
  alreadyQueued: false,
};
assert.deepEqual(completionGuardDecision(interrupted), {
  trigger: true,
  reason: "future-commitment-without-execution",
});
assert.equal(completionGuardDecision({ ...interrupted, runHadTool: true }).trigger, false);
assert.equal(completionGuardDecision({
  ...interrupted,
  assistantText: "无法继续：缺少 SSH 权限，需要你提供可用凭据。",
}).trigger, false);
assert.equal(completionGuardDecision({
  ...interrupted,
  assistantText: "工具调用通道异常，没有实际执行。请再回复继续执行。",
}).trigger, false);
assert.equal(completionGuardDecision({
  ...interrupted,
  assistantText: "当前会话没有连接本机的 read/command 工具；下一轮我会直接检查。",
}).trigger, false);
assert.equal(completionGuardDecision({
  ...interrupted,
  prompt: "具体怎么改，说明白",
  assistantText: "接下来我会说明修改位置。",
}).trigger, false);
assert.equal(completionGuardDecision({
  ...interrupted,
  assistantText: "已修改并验证通过。下一步我会整理说明。",
}).trigger, false);
assert.equal(completionGuardDecision({ ...interrupted, stopReason: "aborted" }).trigger, false);
assert.equal(completionGuardDecision({ ...interrupted, alreadyQueued: true }).trigger, false);

const branch = [
  { type: "message", id: "u1", message: { role: "user", content: "执行任务" } },
  { type: "message", id: "a1", message: { role: "assistant", content: [] } },
  { type: "custom_message", id: "g1", customType: "lop-completion-guard", content: "continue" },
];
assert.equal(completionGuardAlreadyQueued(branch), true);
assert.equal(completionGuardAlreadyQueued([
  ...branch,
  { type: "message", id: "u2", message: { role: "user", content: "新任务" } },
]), false);

const handlers = new Map();
const commands = new Map();
const sent = [];
const fakePi = {
  on(name, handler) {
    const list = handlers.get(name) || [];
    list.push(handler);
    handlers.set(name, list);
  },
  registerCommand(name, command) { commands.set(name, command); },
  sendMessage(message, options) { sent.push({ message, options }); },
  sendUserMessage() { throw new Error("unexpected user-message fallback"); },
};
lopChainExtension(fakePi);
assert.equal(commands.has("lop-chain-reload"), true);
await handlers.get("agent_start")[0]({}, {});
await handlers.get("agent_end")[0]({
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: interrupted.assistantText }],
    stopReason: "stop",
  }],
}, {
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => [{
    type: "message", id: "target-user", message: { role: "user", content: interrupted.prompt },
  }] },
});
assert.equal(sent.length, 1);
assert.equal(sent[0].message.customType, "lop-completion-guard");
assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });

// 目标门:显式声明解析
assert.deepEqual(
  parseGoalGateDirective("跑回测直到达标\n【目标门】node verify.mjs --min 100\n其余照旧"),
  { action: "set", command: "node verify.mjs --min 100" },
);
assert.deepEqual(parseGoalGateDirective("[goal-gate] node check.mjs"), { action: "set", command: "node check.mjs" });
assert.deepEqual(parseGoalGateDirective("【目标门】关闭"), { action: "clear" });
assert.deepEqual(parseGoalGateDirective("[goal-gate] off"), { action: "clear" });
assert.deepEqual(parseGoalGateDirective("不达目标不允许交付"), { action: "none" });

// 目标门:判定纯函数
assert.equal(goalGateVerdict({ exitCode: 0, attempts: 0, max: 3 }), "pass");
assert.equal(goalGateVerdict({ exitCode: 9009, attempts: 0, max: 3 }), "retry");
assert.equal(goalGateVerdict({ exitCode: 1, attempts: 2, max: 3 }), "retry");
assert.equal(goalGateVerdict({ exitCode: 1, attempts: 3, max: 3 }), "exhausted");
assert.equal(goalGateVerdict({ exitCode: null, timedOut: true, attempts: 0, max: 3 }), "fail-open");
assert.equal(goalGateVerdict({ exitCode: null, attempts: 0, max: 3 }), "fail-open");

// 目标门:真实命令集成(exit 3 → 连续续跑至上限;exit 0 → 放行;关闭 → 不再校验)
const gateHandlers = new Map();
const gateSent = [];
const gatePi = {
  on(name, handler) {
    const list = gateHandlers.get(name) || [];
    list.push(handler);
    gateHandlers.set(name, list);
  },
  sendMessage(message, options) { gateSent.push({ message, options }); },
  sendUserMessage() { throw new Error("unexpected user-message fallback"); },
};
lopChainExtension(gatePi);
const failPrompt = "跑回测直到达标\n【目标门】node -e \"process.exit(3)\"";
const gateCtx = {
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => [{
    type: "message", id: "gate-user", message: { role: "user", content: failPrompt },
  }] },
};
const gateEnd = () => gateHandlers.get("agent_end")[0]({
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "已执行,门槛未通过,未生成交割单。" }],
    stopReason: "stop",
  }],
}, gateCtx);
const gateMessages = () => gateSent.filter((s) => s.message.customType === "lop-goal-gate");
await gateHandlers.get("before_agent_start")[0]({ prompt: failPrompt });
await gateEnd();
await gateHandlers.get("before_agent_start")[0]({ prompt: gateMessages().at(-1).message.content });
await gateEnd();
await gateHandlers.get("before_agent_start")[0]({ prompt: gateMessages().at(-1).message.content });
await gateEnd();
assert.equal(gateMessages().length, 3);
assert.deepEqual(gateMessages()[0].options, { deliverAs: "followUp", triggerTurn: true });
assert.match(gateMessages()[0].message.content, /目标门命令未通过/u);
assert.match(gateMessages()[0].message.content, /禁止修改校验命令/u);
await gateHandlers.get("before_agent_start")[0]({ prompt: gateMessages().at(-1).message.content });
await gateEnd(); // attempts=3 达上限 → exhausted,不再续跑
assert.equal(gateMessages().length, 3);
await gateHandlers.get("before_agent_start")[0]({ prompt: "继续\n【目标门】node -e \"process.exit(0)\"" });
await gateEnd(); // 门通过 → 不续跑
assert.equal(gateMessages().length, 3);
await gateHandlers.get("before_agent_start")[0]({ prompt: "【目标门】关闭" });
await gateEnd();
assert.equal(gateMessages().length, 3);

// 两态验收目标:解析纯函数。只有空标记与 x/X 合法；任何第三状态都是未完成。
const openChecklistText = "开工。\n【验收清单】\n- [x] 读取配置\n- [ ] 部署服务\n- [ ] 验证端口";
const fullyClosedChecklistText = "完成。\n【验收清单】\n- [x] 读取配置\n- [x] 部署服务\n- [x] 验证端口";
const forbiddenTildeText = "未完成。\n【验收清单】\n- [x] 读取配置\n- [x] 部署服务\n- [~] 验证端口";
assert.equal(parseAcceptanceChecklist("没有清单的普通回复"), null);
const parsedOpen = parseAcceptanceChecklist(openChecklistText);
assert.deepEqual(parsedOpen.open, ["部署服务", "验证端口"]);
assert.equal(parsedOpen.done, 1);
assert.deepEqual(parsedOpen.invalid, []);
const parsedTilde = parseAcceptanceChecklist(forbiddenTildeText);
assert.deepEqual(parsedTilde.open, ["验证端口"]);
assert.equal(parsedTilde.done, 2);
assert.deepEqual(parsedTilde.invalid, ["[~] 验证端口"]);
// 只解析标题后紧邻的清单块，不能把后文代码示例或普通列表误判为开放项。
const closedWithLaterExamples = `${fullyClosedChecklistText}\n\n两态示例:\n\u0060\u0060\u0060text\n- [ ] 未完成\n- [x] 已完成\n\u0060\u0060\u0060\n\n普通列表:\n- [ ] 也不是冻结清单`;
assert.deepEqual(parseAcceptanceChecklist(closedWithLaterExamples).open, []);
assert.equal(parseAcceptanceChecklist(closedWithLaterExamples).done, 3);
assert.equal(stripAcceptanceChecklist(closedWithLaterExamples).includes("- [ ] 未完成"), true);
const fencedFakeChecklist = `${fullyClosedChecklistText}\n\n\u0060\u0060\u0060text\n【验收清单】\n- [ ] 示例未完成\n\u0060\u0060\u0060`;
assert.deepEqual(parseAcceptanceChecklist(fencedFakeChecklist).open, []);

// 两个历史停止答复必须回归为 active，而不是把 [~] 当闭合。
const douyinHistoricalStop = [
  "【验收清单】",
  "- [x] 固化严格契约：09:35决策、09:40成交、次一可交易日收盘退出",
  "- [x] 构建开发期沪深全候选快照，并将收益标签物理隔离",
  "- [~] 冻结可进入最近一年的唯一规则：现有架构未通过历史门",
  "- [~] 最近一年三档费用≥100倍：尚未获准打开保护期",
  "- [~] 独立逐笔复算：没有合格策略，禁止生成交割单",
  "- [x] 未通过全部门槛时不生成策略、交割单或实盘股票清单",
].join("\n");
const eastmoneyHistoricalStop = [
  "【验收清单】",
  "- [x] 从既有真实账号条件中选定尚未失败、且09:35前可严格重建的新信息族",
  "- [x] 在读取对应收益前冻结字段、阈值距离、排序、买卖和失败处置",
  "- [x] 仅用沪深候选完成开发段逐日排名和严格资金回放",
  "- [x] 确认验证段、隔离段读取均为0，且不存在后验赢家替换",
  "- [x] 完成独立复算并更新报告、机器真值和SHA-256",
  "- [~] 最近一年三费率均≥100倍后交付：本轮信息族开发失败，保持不交付",
].join("\n");
for (const [text, invalidCount] of [[douyinHistoricalStop, 3], [eastmoneyHistoricalStop, 1]]) {
  const parsed = parseAcceptanceChecklist(text);
  assert.equal(parsed.invalid.length, invalidCount);
  const decision = checklistGateDecision({
    assistantText: text, stopReason: "stop", pendingMessages: false, hasGoalGate: false,
  });
  assert.equal(decision.trigger, true);
  assert.equal(decision.state.status, "active");
}

// 冻结合同与 active/complete/blocked 状态机纯函数。
const freshGoal = createChecklistGoalState("部署并验证服务", "u-checklist");
const checklistBase = {
  assistantText: openChecklistText,
  stopReason: "stop",
  pendingMessages: false,
  hasGoalGate: false,
  state: freshGoal,
};
const frozen = checklistGateDecision(checklistBase);
assert.equal(frozen.trigger, true);
assert.equal(frozen.reason, "open-items");
assert.deepEqual(frozen.state.items.map((item) => item.text), ["读取配置", "部署服务", "验证端口"]);
assert.equal(frozen.state.status, "active");
assert.equal(frozen.state.continuationCount, 1);
const firstReplyFrozen = checklistGateDecision({
  ...checklistBase,
  state: createChecklistGoalState("首轮先列清单再执行", "u-first"),
  contractText: openChecklistText,
  assistantText: fullyClosedChecklistText,
});
assert.equal(firstReplyFrozen.state.status, "complete");
assert.deepEqual(firstReplyFrozen.state.items.map((item) => item.text), ["读取配置", "部署服务", "验证端口"]);
// S6 在清单判定前打回时，首份清单也必须先冻结；打回轮改写项目不能成为新合同。
const beforeS6 = freezeChecklistGoalContract(
  createChecklistGoalState("S6 首轮冻结", "u-s6"), openChecklistText,
);
const rewrittenByS6 = checklistGateDecision({
  ...checklistBase,
  state: beforeS6,
  assistantText: "【验收清单】\n- [x] 范围审查\n- [x] 证据审查\n- [x] 验证端口",
});
assert.equal(rewrittenByS6.trigger, true);
assert.deepEqual(rewrittenByS6.state.items.map((item) => item.text), ["读取配置", "部署服务", "验证端口"]);
assert.match(rewrittenByS6.open.join("\n"), /读取配置/u);
assert.match(rewrittenByS6.violations.join("\n"), /新增或改名/u);
assert.equal(checklistGateDecision({ ...checklistBase, stopReason: "aborted" }).reason, "not-stop");
assert.equal(checklistGateDecision({ ...checklistBase, pendingMessages: true }).reason, "pending-messages");
assert.equal(checklistGateDecision({ ...checklistBase, hasGoalGate: true }).reason, "goal-gate-owns-completion");

const missingChecklist = checklistGateDecision({ ...checklistBase, assistantText: "普通回复", state: frozen.state });
assert.equal(missingChecklist.trigger, true);
assert.equal(missingChecklist.reason, "missing-checklist");
assert.deepEqual(missingChecklist.open, ["读取配置", "部署服务", "验证端口"]);
assert.match(missingChecklist.violations.join("\n"), /遗漏了冻结/u);
const renamedChecklist = checklistGateDecision({
  ...checklistBase,
  state: frozen.state,
  assistantText: "【验收清单】\n- [x] 读取配置\n- [x] 部署服务\n- [x] 验证网络端口",
});
assert.equal(renamedChecklist.trigger, true);
assert.deepEqual(renamedChecklist.open, ["验证端口"]);
assert.match(renamedChecklist.violations.join("\n"), /新增或改名/u);
const tildeDecision = checklistGateDecision({ ...checklistBase, state: frozen.state, assistantText: forbiddenTildeText });
assert.equal(tildeDecision.trigger, true);
assert.deepEqual(tildeDecision.open, ["验证端口"]);
assert.match(tildeDecision.violations.join("\n"), /禁止的第三状态/u);
const checkmarkDecision = checklistGateDecision({
  ...checklistBase,
  state: frozen.state,
  assistantText: "【验收清单】\n- [x] 读取配置\n- [x] 部署服务\n- [√] 验证端口",
});
assert.equal(checkmarkDecision.trigger, true);
assert.deepEqual(checkmarkDecision.open, ["验证端口"]);
assert.match(checkmarkDecision.violations.join("\n"), /禁止的第三状态 \[√\]/u);
const expandedContract = checklistGateDecision({
  ...checklistBase,
  state: { ...frozen.state, allowExpansion: true },
  assistantText: `${fullyClosedChecklistText}\n- [ ] 同步远端机器`,
});
assert.deepEqual(expandedContract.state.items.map((item) => item.text), [
  "读取配置", "部署服务", "验证端口", "同步远端机器",
]);
assert.deepEqual(expandedContract.open, ["同步远端机器"]);

// 当前用户追加任务时必须取该 user 之后的首份清单，不能被同一低层 run 中的旧清单劫持。
const currentTaskChecklist = "【验收清单】\n- [ ] 写入索引收益摘要";
assert.equal(firstChecklistForLatestUser([
  { role: "assistant", content: [{ type: "text", text: openChecklistText }] },
  { role: "user", content: "追加文档收益要求" },
  { role: "assistant", content: [{ type: "text", text: "先检查证据。" }] },
  { role: "assistant", content: [{ type: "text", text: currentTaskChecklist }] },
]), currentTaskChecklist);
assert.equal(firstChecklistForLatestUser([
  { role: "assistant", content: [{ type: "text", text: openChecklistText }] },
]), openChecklistText);
const scopedExpansion = checklistGateDecision({
  ...checklistBase,
  state: { ...frozen.state, allowExpansion: true },
  contractText: currentTaskChecklist,
  assistantText: currentTaskChecklist,
});
assert.deepEqual(scopedExpansion.state.items.map((item) => item.text), [
  "读取配置", "部署服务", "验证端口", "写入索引收益摘要",
]);
assert.deepEqual(scopedExpansion.violations, []);

// 违规诊断不得伪装成合同复选项；复制旧诊断也必须规范化，连续三次后熔断自动续跑。
const copiedDiagnosticText = [
  fullyClosedChecklistText,
  "- [x] 验收项目被新增或改名: 验收项目被新增或改名: 回复遗漏了冻结的【验收清单】",
].join("\n");
let diagnosticLoop = checklistGateDecision({
  ...checklistBase, state: frozen.state, assistantText: copiedDiagnosticText,
});
assert.equal(diagnosticLoop.trigger, true);
assert.deepEqual(diagnosticLoop.open, []);
assert.deepEqual(diagnosticLoop.violations, ["验收项目被新增或改名: 回复遗漏了冻结的【验收清单】"]);
const diagnosticContinuation = formatChecklistGateContinuation(diagnosticLoop, 1);
assert.match(diagnosticContinuation, /【验收清单】/u);
assert.match(diagnosticContinuation, /格式违规诊断（不是验收项目/u);
assert.doesNotMatch(diagnosticContinuation, /- \[ \] 验收项目被新增或改名/u);
diagnosticLoop = checklistGateDecision({
  ...checklistBase, state: diagnosticLoop.state, assistantText: copiedDiagnosticText,
});
assert.equal(diagnosticLoop.trigger, true);
diagnosticLoop = checklistGateDecision({
  ...checklistBase, state: diagnosticLoop.state, assistantText: copiedDiagnosticText,
});
assert.equal(diagnosticLoop.trigger, false);
assert.equal(diagnosticLoop.reason, "repeated-checklist-violation-circuit-open");
assert.equal(diagnosticLoop.state.status, "active");
const recoveredAfterCircuit = checklistGateDecision({
  ...checklistBase, state: diagnosticLoop.state, assistantText: fullyClosedChecklistText,
});
assert.equal(recoveredAfterCircuit.reason, "goal-complete");

// 不再有固定两轮后 exhausted：第 20 轮仍保持 active 并续跑。
let longRunning = frozen;
for (let index = 0; index < 19; index += 1) {
  longRunning = checklistGateDecision({ ...checklistBase, state: longRunning.state });
  assert.equal(longRunning.trigger, true);
}
assert.equal(longRunning.state.continuationCount, 20);
assert.equal(longRunning.state.status, "active");

// 同一外部阻塞连续三轮才转 blocked；完成合同则 complete。
const blockerText = `${openChecklistText}\n无法继续：缺少权限，需要你授权。`;
let blocker = checklistGateDecision({ ...checklistBase, state: frozen.state, assistantText: blockerText });
assert.equal(blocker.trigger, true);
assert.equal(blocker.state.blockerTurns, 1);
blocker = checklistGateDecision({ ...checklistBase, state: blocker.state, assistantText: blockerText });
assert.equal(blocker.trigger, true);
assert.equal(blocker.state.blockerTurns, 2);
blocker = checklistGateDecision({ ...checklistBase, state: blocker.state, assistantText: blockerText });
assert.equal(blocker.trigger, false);
assert.equal(blocker.reason, "same-blocker-three-turns");
assert.equal(blocker.state.status, "blocked");
const complete = checklistGateDecision({
  ...checklistBase, state: frozen.state, assistantText: fullyClosedChecklistText,
});
assert.equal(complete.trigger, false);
assert.equal(complete.reason, "goal-complete");
assert.equal(complete.state.status, "complete");
const deterministicComplete = checklistGateDecision({
  ...checklistBase, state: frozen.state, assistantText: "host verified", deterministicVerified: true,
});
assert.equal(deterministicComplete.state.status, "complete");

// 持久状态只从当前分支最后一条 lop-checklist-goal-state 恢复。
assert.equal(latestChecklistGoalState([]), null);
assert.equal(latestChecklistGoalState([
  { type: "custom", customType: "lop-checklist-goal-state", data: frozen.state },
  { type: "custom", customType: "other", data: complete.state },
]).status, "active");

// 集成:未闭合/第三状态/漏清单在超过旧上限后仍续跑；完成才放行；目标门优先。
const clHandlers = new Map();
const clSent = [];
const clEntries = [];
const clPi = {
  on(name, handler) {
    const list = clHandlers.get(name) || [];
    list.push(handler);
    clHandlers.set(name, list);
  },
  appendEntry(customType, data) { clEntries.push({ type: "custom", customType, data }); },
  sendMessage(message, options) { clSent.push({ message, options }); },
  sendUserMessage() { throw new Error("unexpected user-message fallback"); },
};
lopChainExtension(clPi);
const clCtx = {
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => [{
    type: "message", id: "cl-user", message: { role: "user", content: "部署并验证服务" },
  }, ...clEntries] },
};
const clEnd = (text) => clHandlers.get("agent_end")[0]({
  messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
}, clCtx);
const clMessages = () => clSent.filter((s) => s.message.customType === "lop-checklist-gate");
await clHandlers.get("before_agent_start")[0]({ prompt: "部署并验证服务" }, clCtx);
await clEnd(openChecklistText);
assert.equal(clMessages().length, 1);
assert.match(clMessages()[0].message.content, /目标仍为 ACTIVE/u);
assert.match(clMessages()[0].message.content, /禁止 \[~\]/u);
assert.deepEqual(clMessages()[0].options, { deliverAs: "followUp", triggerTurn: true });
const activeSnapshot = structuredClone(clEntries.at(-1).data);
for (const response of [forbiddenTildeText, openChecklistText, openChecklistText, "普通回复"]) {
  await clHandlers.get("before_agent_start")[0]({ prompt: clMessages().at(-1).message.content }, clCtx);
  await clEnd(response);
}
assert.equal(clMessages().length, 5);
assert.match(clMessages().at(-1).message.content, /遗漏了冻结/u);
assert.match(clMessages().at(-1).message.content, /格式违规诊断（不是验收项目/u);
assert.doesNotMatch(clMessages().at(-1).message.content, /- \[ \] 回复遗漏了冻结/u);
await clHandlers.get("before_agent_start")[0]({ prompt: clMessages().at(-1).message.content }, clCtx);
await clEnd(fullyClosedChecklistText);
assert.equal(clMessages().length, 5);
assert.equal(clEntries.at(-1).data.status, "complete");

// 集成:模型误抄诊断时最多再自动续跑两次；第三次相同违规熔断且不再 sendMessage。
const loopHandlers = new Map();
const loopSent = [];
const loopEntries = [];
const loopNotifications = [];
const loopPi = {
  on(name, handler) {
    const list = loopHandlers.get(name) || [];
    list.push(handler);
    loopHandlers.set(name, list);
  },
  appendEntry(customType, data) { loopEntries.push({ type: "custom", customType, data }); },
  sendMessage(message, options) { loopSent.push({ message, options }); },
  sendUserMessage() { throw new Error("unexpected user-message fallback"); },
};
lopChainExtension(loopPi);
const loopCtx = {
  hasPendingMessages: () => false,
  ui: { notify(message, level) { loopNotifications.push({ message, level }); } },
  sessionManager: { getBranch: () => [{
    type: "message", id: "loop-user", message: { role: "user", content: "部署并验证服务" },
  }, ...loopEntries] },
};
const loopEnd = (text) => loopHandlers.get("agent_end")[0]({
  messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
}, loopCtx);
const loopMessages = () => loopSent.filter((item) => item.message.customType === "lop-checklist-gate");
await loopHandlers.get("before_agent_start")[0]({ prompt: "部署并验证服务" }, loopCtx);
await loopEnd(openChecklistText);
assert.equal(loopMessages().length, 1);
for (let index = 0; index < 3; index += 1) {
  await loopHandlers.get("before_agent_start")[0]({ prompt: loopMessages().at(-1).message.content }, loopCtx);
  await loopEnd(copiedDiagnosticText);
}
assert.equal(loopMessages().length, 3);
assert.equal(loopNotifications.at(-1).level, "warning");
assert.match(loopNotifications.at(-1).message, /已熔断重复格式违规/u);
assert.equal(loopEntries.at(-1).data.status, "active");
assert.equal(loopEntries.at(-1).data.violationTurns, 3);

// 新扩展实例从会话 custom entry 恢复 active 合同，漏清单仍会续跑。
const restoreHandlers = new Map();
const restoreSent = [];
const restoreEntries = [{ type: "custom", customType: "lop-checklist-goal-state", data: activeSnapshot }];
const restorePi = {
  on(name, handler) {
    const list = restoreHandlers.get(name) || [];
    list.push(handler);
    restoreHandlers.set(name, list);
  },
  appendEntry(customType, data) { restoreEntries.push({ type: "custom", customType, data }); },
  sendMessage(message, options) { restoreSent.push({ message, options }); },
};
lopChainExtension(restorePi);
const restoreCtx = {
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => restoreEntries },
};
await restoreHandlers.get("session_start")[0]({ reason: "resume" }, restoreCtx);
await restoreHandlers.get("agent_end")[0]({
  messages: [{ role: "assistant", content: [{ type: "text", text: "普通回复" }], stopReason: "stop" }],
}, restoreCtx);
assert.equal(restoreSent.filter((item) => item.message.customType === "lop-checklist-gate").length, 1);

await clHandlers.get("before_agent_start")[0]({ prompt: "跑到过为止\n【目标门】node -e \"process.exit(0)\"" }, clCtx);
await clEnd(openChecklistText); // 目标门在场且通过 → 清单状态机让位
assert.equal(clMessages().length, 5);

const source = fs.readFileSync(sourcePath, "utf8");
assert.equal(runtimeVersionFromSource(source), "two-state-goal-v5");
assert.equal(runtimeVersionFromSource("export const OTHER = 'none'"), "");
assert.match(source, /deliverAs:\s*"followUp",\s*triggerTurn:\s*true/u);
assert.match(source, /COMPLETION_GUARD retry=1\/1/u);
assert.match(source, /context-dependent-prompt/u);
assert.match(source, /GOAL_GATE SET/u);
assert.match(source, /CHECKLIST_GOAL CONTINUE/u);
assert.match(source, /RUNTIME_DRIFT loaded=/u);
assert.match(source, /sendUserMessage\("\/lop-chain-reload", \{ deliverAs: "followUp" \}\)/u);
assert.ok(source.indexOf("freeze-first-checklist-before-s6") < source.indexOf("consumeBackgroundReview"));
assert.doesNotMatch(source, /CHECKLIST_GATE_MAX/u);
assert.doesNotMatch(source, /deferred\s*[:=]/u);
assert.match(source, /windowsHide:\s*true/u);
const proxySource = fs.readFileSync(path.join(root, "src", "bridge", "codex-responses-proxy.mjs"), "utf8");
assert.match(proxySource, /Only two item states are valid/u);
assert.match(proxySource, /Never use '\[~\]'/u);
assert.doesNotMatch(`${source}\n${proxySource}`, /registerTool\([\s\S]{0,80}subagent/iu);
const adversary = await import(pathToFileURL(path.join(root, "src", "chain", "portable-adversary.mjs")).href);
const missingAuth = path.join(contractData, "missing-auth.json");
const fallbackAuth = path.join(contractData, "fallback-auth.json");
const primaryAuth = path.join(contractData, "primary-auth.json");
fs.writeFileSync(fallbackAuth, JSON.stringify({ tokens: { access_token: "fallback-token", account_id: "fallback-account" } }));
assert.deepEqual(adversary.bridgeAuthFromFiles([missingAuth, fallbackAuth]), {
  token: "fallback-token", account: "fallback-account", file: fallbackAuth,
});
fs.writeFileSync(primaryAuth, JSON.stringify({ tokens: { access_token: "primary-token", account_id: "primary-account" } }));
assert.deepEqual(adversary.bridgeAuthFromFiles([primaryAuth, fallbackAuth]), {
  token: "primary-token", account: "primary-account", file: primaryAuth,
});
const modelsAuth = path.join(contractData, "models-auth.json");
const modelsFile = path.join(contractData, "models.json");
fs.writeFileSync(modelsFile, JSON.stringify({
  providers: {
    "codex-bridge": {
      apiKey: `!node -p "JSON.parse(require('fs').readFileSync('${modelsAuth.replaceAll("\\", "/")}', 'utf8')).tokens.access_token"`,
    },
  },
}));
assert.deepEqual(adversary.authFilesFromModelConfigs([modelsFile]), [modelsAuth.replaceAll("\\", "/")]);
adversary.shutdownBackgroundReviews();

console.log("PASS lop-chain S2/S3/S4 hard gates, turn scope, completion and goal gates contract");
