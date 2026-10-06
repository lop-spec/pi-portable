import assert from "node:assert/strict";
import test from "node:test";

const subject = () => import("./message-display.ts");

test("parses provider errors into code, Chinese title and original text", async () => {
  const { parseAssistantError } = await subject();
  const rate = parseAssistantError("CHATGPT_RATE_LIMIT: conversation HTTP 429; cooldownUntil=2026-09-30T07:55:07.627Z; source=local");
  assert.equal(rate.code, "CHATGPT_RATE_LIMIT");
  assert.equal(rate.title, "对话被限流");
  assert.match(rate.hint, /^冷却至 \d{2}:\d{2}/);
  assert.equal(rate.detail.startsWith("conversation HTTP 429"), true);

  const json = parseAssistantError("CHATGPT_TOOL_BATCH_INVALID_JSON: Expected ',' at 12 (transient transport failure; you can retry your request)");
  assert.equal(json.title, "工具批次解析失败");
  assert.equal(json.transient, true);
  assert.equal(json.detail, "Expected ',' at 12");

  const http = parseAssistantError("OpenAI API error (403): <html>request forbidden</html>");
  assert.equal(http.code, "HTTP 403");
  assert.equal(http.title, "鉴权失败");

  const unknown = parseAssistantError("Connection closed");
  assert.equal(unknown.code, null);
  assert.equal(unknown.title, "回复失败");
  assert.equal(unknown.hint, null);
  assert.equal(parseAssistantError("This operation was aborted").title, "回复中断");
});

test("formats the turn footer usage compactly with exact numbers for the tooltip", async () => {
  const { formatUsageCompact, formatTokenCount } = await subject();
  assert.deepEqual(formatUsageCompact({ input: 1288, output: 759, cacheRead: 49664, cacheWrite: 0, cost: { total: 0 } }), {
    text: "入 1,288 · 出 759 · 缓存 49.7k",
    title: "输入 1,288 · 输出 759 · 缓存读 49,664",
  });
  assert.equal(formatUsageCompact({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }), null);
  assert.equal(formatTokenCount(107648), "107.6k");
  assert.equal(formatTokenCount(23_700_000), "23.7M");
  assert.equal(formatTokenCount(10_000), "10k");
});

test("shortens model names and formats durations in Chinese", async () => {
  const { shortModelName, modelNameWithoutNote, formatDuration, formatClock } = await subject();
  assert.equal(shortModelName("GPT-5.6 Sol · 网页（max = Sol Pro）"), "GPT-5.6 Sol");
  assert.equal(shortModelName("openai-codex/gpt-6-sol"), "gpt-6-sol");
  assert.equal(modelNameWithoutNote("Gemini 3.8 Flash · AI Studio 网页（默认）"), "Gemini 3.8 Flash · AI Studio 网页");
  assert.equal(formatDuration(38_000), "38 秒");
  assert.equal(formatDuration(34 * 60_000 + 12_000), "34 分 12 秒");
  assert.equal(formatDuration(72 * 60_000), "1 小时 12 分");
  assert.equal(formatClock(42_000), "0:42");
});

test("previews reasoning with Chinese headings and drops English-only headings", async () => {
  const { thinkingHeadline, thinkingParagraphs, plainThinkingText } = await subject();
  assert.equal(thinkingHeadline("**更新启动测试**\n\n内容\n\n**比对构建版本**\n\n更多"), "比对构建版本");
  assert.equal(thinkingHeadline("**Clarifying User Intentions**\n\n确认用户要的是直接生效。"), "确认用户要的是直接生效。");
  assert.equal(thinkingHeadline("I quote \"率先态\" here.\n\n这一段主要是中文说明。"), "这一段主要是中文说明。");
  assert.deepEqual(thinkingParagraphs("**Planning**\n\n先核对版本。"), ["先核对版本。"]);
  assert.equal(plainThinkingText("**Planning**\n\n**核对**\n\n先核对版本。"), "核对 先核对版本。");
});

test("reasoning is shown only when Chinese makes up at least 30% of the reading units", async () => {
  const { chineseShare, isEmptyThinkingBlock } = await subject();
  const block = thinking => ({ type: "thinking", thinking });
  // Chinese prose with many identifiers stays visible.
  assert.equal(isEmptyThinkingBlock(block("核对 pi-web 的 launcher.mjs 与 run-supervisor.mjs")), false);
  assert.equal(isEmptyThinkingBlock(block("我先读取 package.json，再用 tsc --noEmit 检查类型。")), false);
  // English reasoning that only quotes a few Chinese words is hidden (Gemini style).
  const english = "I should first check how the session list is cached, then compare the resumable scan with a full rescan. The user wrote \"率先态\" which is unclear, so I will keep both readings in mind while verifying the index format and the header hash.";
  assert.equal(isEmptyThinkingBlock(block(english)), true);
  assert.ok(chineseShare(english) < 0.1);
  // Empty, whitespace and punctuation-only blocks are hidden; plain English headings too.
  for (const text of ["", "   \n", "…", "**Planning**", "Clarifying User Intentions"]) assert.equal(isEmptyThinkingBlock(block(text)), true, JSON.stringify(text));
  // A Chinese heading above a short English line stays; above a long English body it does not.
  assert.equal(isEmptyThinkingBlock(block("**更新启动测试**\n\nChecking the launcher.")), false);
  assert.equal(isEmptyThinkingBlock(block("更新\n\nChecking the launcher, the session index, the proxy cache and the model menu refresh path.")), true);
  // Non-thinking blocks are never "empty thinking".
  assert.equal(isEmptyThinkingBlock({ type: "text", text: "hello" }), false);
});
