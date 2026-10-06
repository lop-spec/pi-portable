import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { PortableProcessTimeline, buildTimelineItems, summarizeTimelineItems } = await jiti.import("./PortableProcessTimeline.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

function assistant(content, extra = {}) {
  return { role: "assistant", provider: "openai-codex", model: "gpt-6-sol", content, ...extra };
}

function render(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(PortableProcessTimeline, { toolResults: new Map(), ...props })));
}

test("renders a finished turn's process expanded under a summary header, commands hidden", () => {
  const html = render({
    entries: [
      { kind: "assistant", key: "a1", entryId: "e1", message: assistant([
        { type: "thinking", thinking: "**核对构建版本**\n\n先比对 30140 与独立实例的构建产物，再决定是否需要重新部署。" },
        { type: "text", text: "当前判断：先核对运行版本。" },
        { type: "toolCall", toolCallId: "c1", toolName: "bash", input: { command: "git status --short" } },
      ]) },
    ],
    startedAt: 1_000,
    end: { status: "done", at: 1_000 + 34 * 60_000 + 12_000 },
  });
  assert.match(html, /class="pw-proc-head" aria-expanded="true"/);
  assert.match(html, /1 段叙述/);
  assert.match(html, />思考</);
  assert.match(html, /当前判断：先核对运行版本。/);
  assert.match(html, /完成 · 用时 34 分 12 秒/);
  assert.doesNotMatch(html, /git status/);
});

test("counts only Chinese reasoning and inlines a short group", () => {
  const items = buildTimelineItems([
    { kind: "assistant", key: "a1", message: assistant([{ type: "thinking", thinking: "**Planning** English only" }]) },
    { kind: "assistant", key: "a2", message: assistant([{ type: "thinking", thinking: "更新启动测试" }]) },
  ]);
  assert.deepEqual(summarizeTimelineItems(items), { narration: 0, thinking: 1, failures: 0 });
  const html = render({ entries: [{ kind: "assistant", key: "a2", message: assistant([{ type: "thinking", thinking: "更新启动测试" }]) }] });
  assert.match(html, /class="pw-think-inline"/);
  assert.match(html, /更新启动测试/);
  assert.doesNotMatch(html, /Planning/);
});

test("merges reasoning across hidden tool calls and compaction, and labels the count", () => {
  const long = "这是一段比较长的中文推理内容，用来确认超过四十个字时会折叠成一行，而不是直接全部展示出来。";
  const items = buildTimelineItems([
    { kind: "assistant", key: "a1", message: assistant([{ type: "thinking", thinking: long }, { type: "toolCall", toolCallId: "c1", toolName: "read", input: {} }]) },
    { kind: "compaction", key: "k1", entryId: "k1" },
    { kind: "assistant", key: "a2", message: assistant([{ type: "thinking", thinking: `**最新要点**\n\n${long}` }]) },
  ]);
  assert.deepEqual(items.map(item => item.type), ["thinking", "compaction"]);
  assert.equal(items[0].blocks.length, 2);
  const html = render({ entries: [
    { kind: "assistant", key: "a1", message: assistant([{ type: "thinking", thinking: long }]) },
    { kind: "compaction", key: "k1", entryId: "k1" },
    { kind: "assistant", key: "a2", message: assistant([{ type: "thinking", thinking: `**最新要点**\n\n${long}` }]) },
  ] });
  assert.match(html, /思考 2 处/);
  assert.match(html, /最新要点/);
  assert.match(html, /上下文已自动压缩/);
});

test("merges consecutive failures with the same code and marks a model switch", () => {
  const failure = (id, ts) => ({ kind: "failure", key: id, entryId: id, message: assistant([], { stopReason: "error", timestamp: ts, errorMessage: "CHATGPT_RATE_LIMIT: conversation HTTP 429; cooldownUntil=2026-09-30T07:55:07.627Z" }) });
  const items = buildTimelineItems([
    failure("f1", 1_000),
    failure("f2", 2_000),
    { kind: "assistant", key: "a3", message: assistant([{ type: "text", text: "改用备用模型继续。" }], { provider: "pi-gemini-web", model: "gemini-web-3.8-flash" }) },
  ], () => false, { "pi-gemini-web:gemini-web-3.8-flash": "Gemini 3.8 Flash · AI Studio 网页（默认）" });
  assert.deepEqual(items.map(item => item.type), ["failure", "switch", "text"]);
  assert.equal(items[0].failures.length, 2);
  assert.equal(items[1].model, "Gemini 3.8 Flash · AI Studio 网页");
  const html = render({ entries: [failure("f1", 1_000), failure("f2", 2_000)] });
  assert.match(html, /对话被限流 ×2/);
  assert.match(html, /CHATGPT_RATE_LIMIT/);
  assert.match(html, /2 次失败/);
});

test("streams through the same timeline with a live end node instead of native tool cards", () => {
  const html = render({
    live: true,
    entries: [{ kind: "assistant", key: "streaming", streaming: true, message: assistant([
      { type: "text", text: "正在核对" },
      { type: "toolCall", toolCallId: "c9", toolName: "bash", input: { command: "rm -rf build" } },
    ]) }],
    phase: "正在等待模型...",
    startedAt: Date.now() - 42_000,
  });
  assert.match(html, /class="pw-proc-end is-live"/);
  assert.match(html, /正在等待模型 · 已用 0:4\d/);
  assert.doesNotMatch(html, /rm -rf/);
  assert.doesNotMatch(html, /aria-expanded="false"[^>]*>[^<]*过程/);
});

test("compaction no longer anchors a turn and the duplicate scroll button is gone", () => {
  assert.doesNotMatch(source, /<PortableScrollBottom/);
  assert.match(source, /isCompactionMessage\(item\)/);
  assert.match(source, /className=\{`chat-scroll-to-bottom/);
});
