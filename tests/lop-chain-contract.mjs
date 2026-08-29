import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const sourcePath = process.env.LOP_CHAIN_SOURCE || path.join(root, "src", "lop-chain.ts");
const policy = await import(pathToFileURL(sourcePath).href + `?contract=${Date.now()}`);
const {
  default: lopChainExtension,
  completionGuardAlreadyQueued,
  completionGuardDecision,
  isContextDependentHistoryPrompt,
  scopeLopChainContext,
} = policy;

assert.equal(isContextDependentHistoryPrompt("继续"), true);
assert.equal(isContextDependentHistoryPrompt("确认一下"), true);
assert.equal(isContextDependentHistoryPrompt("具体怎么改，说明白"), true);
assert.equal(isContextDependentHistoryPrompt("不做1，其余的都做，也改到异机"), true);
assert.equal(isContextDependentHistoryPrompt("继续修复 8794 的 history 快路"), false);
assert.equal(isContextDependentHistoryPrompt("确认 30141 端口是否监听"), false);

const oldChain = { role: "custom", customType: "lop-chain", content: "old" };
const oldGuard = { role: "custom", customType: "lop-completion-guard", content: "old guard" };
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
  unrelated,
  oldSummary,
  { role: "assistant", content: [] },
  { role: "user", content: "second" },
  currentChain,
  { role: "assistant", content: [] },
]);
assert.equal(scoped.includes(oldChain), false);
assert.equal(scoped.includes(oldGuard), false);
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

const source = fs.readFileSync(sourcePath, "utf8");
assert.match(source, /deliverAs:\s*"followUp",\s*triggerTurn:\s*true/u);
assert.match(source, /COMPLETION_GUARD retry=1\/1/u);
assert.match(source, /context-dependent-prompt/u);

console.log("PASS lop-chain turn scope/history gate/completion guard contract");
