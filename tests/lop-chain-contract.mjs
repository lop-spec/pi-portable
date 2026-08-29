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
  completionGuardAlreadyQueued,
  completionGuardDecision,
  expandPrompt,
  goalGateVerdict,
  historyUsageDecision,
  isContextDependentHistoryPrompt,
  parseGoalGateDirective,
  scopeLopChainContext,
} = policy;

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
const sent = [];
const fakePi = {
  on(name, handler) {
    const list = handlers.get(name) || [];
    list.push(handler);
    handlers.set(name, list);
  },
  sendMessage(message, options) { sent.push({ message, options }); },
  sendUserMessage() { throw new Error("unexpected user-message fallback"); },
};
lopChainExtension(fakePi);
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

const source = fs.readFileSync(sourcePath, "utf8");
assert.match(source, /deliverAs:\s*"followUp",\s*triggerTurn:\s*true/u);
assert.match(source, /COMPLETION_GUARD retry=1\/1/u);
assert.match(source, /context-dependent-prompt/u);
assert.match(source, /GOAL_GATE SET/u);
assert.match(source, /windowsHide:\s*true/u);
const adversary = await import(pathToFileURL(path.join(root, "src", "chain", "portable-adversary.mjs")).href);
adversary.shutdownBackgroundReviews();

console.log("PASS lop-chain S2/S3/S4 hard gates, turn scope, completion and goal gates contract");
