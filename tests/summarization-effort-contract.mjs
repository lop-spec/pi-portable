import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_SUMMARIZATION_PROMPT_PREFIX,
  SUMMARIZATION_BODY_SIGNATURE,
  applySummarizationEffort,
  isPiSummarizationRequest,
  resolveSummaryEffort,
} from "../src/bridge/summarization-effort.mjs";
import { rewriteCodexRequestBody } from "../src/bridge/codex-cache-policy.mjs";

// 与 pi-coding-agent dist/core/compaction/utils.js 的 SUMMARIZATION_SYSTEM_PROMPT 逐字一致（前两句）。
const PI_PROMPT = `${PI_SUMMARIZATION_PROMPT_PREFIX} Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation.`;

const summaryPayload = (role = "developer", effort = "max") => ({
  model: "gpt-5.6-sol",
  stream: true,
  store: false,
  reasoning: { effort, summary: "auto" },
  input: [
    { role, content: PI_PROMPT },
    { role: "user", content: [{ type: "input_text", text: "<conversation>...</conversation>\n\nThe messages above are a conversation to summarize." }] },
  ],
});

const normalPayload = () => ({
  model: "gpt-5.6-sol",
  stream: true,
  reasoning: { effort: "max" },
  input: [
    { role: "developer", content: "# lop 全局规则（Pi 原生）\n..." },
    { role: "user", content: [{ type: "input_text", text: "继续" }] },
  ],
});

test("pi 摘要请求：developer 字符串正文命中，effort max→low，其余字段不动", () => {
  const payload = summaryPayload();
  const outcome = applySummarizationEffort(payload, { effort: "low" });
  assert.deepEqual(outcome, { applied: true, reason: "summarization", from: "max", to: "low" });
  assert.equal(payload.reasoning.effort, "low");
  assert.equal(payload.reasoning.summary, "auto");
  assert.equal(payload.input[0].content, PI_PROMPT);
});

test("system 角色与 input_text 块形态同样命中", () => {
  assert.equal(isPiSummarizationRequest(summaryPayload("system")), true);
  const blocks = summaryPayload();
  blocks.input[0] = { role: "developer", content: [{ type: "input_text", text: PI_PROMPT }] };
  assert.equal(applySummarizationEffort(blocks).applied, true);
  assert.equal(blocks.reasoning.effort, "low");
});

test("普通轮次：系统提示不是摘要提示，原样不动", () => {
  const payload = normalPayload();
  const before = JSON.stringify(payload);
  const outcome = applySummarizationEffort(payload);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "not-summarization");
  assert.equal(JSON.stringify(payload), before);
});

test("摘要提示文本出现在 user/工具结果里（模型在读 pi 源码）不算摘要请求", () => {
  const payload = normalPayload();
  payload.input.push({ role: "user", content: [{ type: "input_text", text: `tool output:\n${PI_PROMPT}` }] });
  assert.equal(isPiSummarizationRequest(payload), false);
  assert.equal(applySummarizationEffort(payload).applied, false);
  assert.equal(payload.reasoning.effort, "max");
});

test("摘要提示不在 input[0] 而在后面的 developer 项，同样不命中", () => {
  const payload = normalPayload();
  payload.input.splice(1, 0, { role: "developer", content: PI_PROMPT });
  assert.equal(isPiSummarizationRequest(payload), false);
});

test("thinking off（无 reasoning 字段）不添加 reasoning；已是目标档位不重复改", () => {
  const off = summaryPayload();
  delete off.reasoning;
  assert.deepEqual(applySummarizationEffort(off), { applied: false, reason: "no-reasoning-field" });
  assert.equal("reasoning" in off, false);
  const already = summaryPayload("developer", "low");
  assert.equal(applySummarizationEffort(already).applied, false);
  assert.equal(applySummarizationEffort(already).reason, "already");
});

test("开关：off 完全旁路；非法值回落 low；合法档位透传", () => {
  assert.equal(resolveSummaryEffort("off"), "off");
  assert.equal(resolveSummaryEffort(undefined), "low");
  assert.equal(resolveSummaryEffort("bogus"), "low");
  assert.equal(resolveSummaryEffort("MEDIUM"), "medium");
  const payload = summaryPayload();
  assert.equal(applySummarizationEffort(payload, { effort: "off" }).applied, false);
  assert.equal(payload.reasoning.effort, "max");
});

test("与 cache 策略串联：先注入 cache key 再改 effort，key 与普通轮次互不影响", () => {
  const body = Buffer.from(JSON.stringify(summaryPayload()), "utf8");
  const rewritten = rewriteCodexRequestBody(body, { "content-type": "application/json" }, { explicitBreakpoint: false });
  assert.equal(rewritten.meta.parseFailed, false);
  const payload = JSON.parse(rewritten.body.toString("utf8"));
  assert.equal(rewritten.body.includes(SUMMARIZATION_BODY_SIGNATURE), true);
  const outcome = applySummarizationEffort(payload);
  assert.equal(outcome.applied, true);
  assert.equal(payload.reasoning.effort, "low");
  const normal = Buffer.from(JSON.stringify(normalPayload()), "utf8");
  assert.equal(normal.includes(SUMMARIZATION_BODY_SIGNATURE), false);
});
