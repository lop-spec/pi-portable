import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { buildTurnModel, resolveTurnWindow, tailTurnWindow, windowGapHeight, MAX_MOUNTED_TURNS } = await jiti.import("./turn-model.ts");
const { splitStreamingMarkdown } = await jiti.import("../../lib/markdown.ts");
const { mergeLoadedWindow } = await jiti.import("../../hooks/useAgentSession.ts");

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content, extra = {}) => ({ role: "assistant", content, timestamp: 2, ...extra });
const result = (id) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [], timestamp: 3 });

test("groups turns and reuses unchanged descriptors when a turn grows", () => {
  const messages = [
    user("一"), assistant([{ type: "toolCall", toolCallId: "c1", toolName: "bash", input: {} }]), result("c1"), assistant([{ type: "text", text: "答一" }]),
    user("二"), assistant([{ type: "text", text: "答二" }]),
  ];
  const ids = ["u1", "a1", "r1", "a2", "u2", "a3"];
  const tools = new Map([["c1", messages[2]]]);
  const first = buildTurnModel(messages, ids, { busy: false, streaming: false }, tools, new Map());
  assert.deepEqual(first.turns.map((turn) => turn.key), ["turn:u1", "turn:u2"]);
  assert.equal(first.turns[0].toolResults.get("c1"), messages[2]);
  assert.equal(first.turnOfEntry.get("r1"), "turn:u1");
  const cache = new Map(first.turns.map((turn) => [turn.key, turn]));
  const grown = [...messages, assistant([{ type: "text", text: "补充" }])];
  const second = buildTurnModel(grown, [...ids, "a4"], { busy: true, streaming: false }, tools, cache);
  assert.equal(second.turns[0], first.turns[0], "finished turn keeps its descriptor");
  assert.notEqual(second.turns[1], first.turns[1]);
  assert.equal(second.turns[1].live, true);
  assert.equal(second.hasLiveTurn, true);
});

test("a window that starts mid-turn yields a partial turn", () => {
  const model = buildTurnModel([assistant([{ type: "text", text: "x" }]), user("q")], ["a0", "u1"], { busy: false, streaming: false }, new Map(), new Map());
  assert.deepEqual(model.turns.map((turn) => [turn.key, turn.partial]), [["partial-end:a0", true], ["turn:u1", false]]);
});

test("render window: keys survive prepends and a jump target is always mounted", () => {
  const turns = Array.from({ length: 40 }, (_, index) => ({ key: `turn:${index}` }));
  assert.deepEqual(resolveTurnWindow(turns, { top: "turn:10", bottom: "turn:20" }), { topIndex: 10, bottomIndex: 20 });
  assert.deepEqual(resolveTurnWindow(turns, { top: "gone", bottom: null }), { topIndex: 0, bottomIndex: 40 });
  const forced = resolveTurnWindow(turns, { top: "turn:30", bottom: null }, "turn:2");
  assert.ok(forced.topIndex <= 2 && forced.bottomIndex > 2);
  assert.equal(windowGapHeight(turns, 0, 2, new Map([["turn:0", 100]])), 100 + 480);
});

test("a send re-mounts a window pinned above the tail, so the appended turn is rendered", () => {
  const turns = Array.from({ length: 40 }, (_, index) => ({ key: `turn:${index}` }));
  const appended = [...turns, { key: "turn:40" }];
  // The reader scrolled far up and the tail was unmounted: the window ends at turn:26 and
  // the turn a send appends lies outside it (what used to hide the new message and reply).
  const pinned = { top: "turn:10", bottom: "turn:26" };
  assert.equal(resolveTurnWindow(appended, pinned).bottomIndex, 26);
  // The send restores the tail first, counting the turn it is about to append.
  const restored = tailTurnWindow(turns, 1);
  assert.equal(restored.bottom, null);
  const { topIndex, bottomIndex } = resolveTurnWindow(appended, restored);
  assert.equal(bottomIndex, appended.length, "the appended turn is mounted");
  assert.equal(bottomIndex - topIndex, MAX_MOUNTED_TURNS, "the window keeps its size cap");
  assert.equal(appended[topIndex].key, "turn:25");
  assert.equal(tailTurnWindow(turns).top, "turn:24", "scroll-to-latest ends at the last existing turn");
  assert.deepEqual(tailTurnWindow(turns.slice(0, 3), 1), { top: null, bottom: null }, "short sessions mount everything");
});

test("the last turn is live only while the agent runs, so a finished turn keeps its answer out of the process", () => {
  const messages = [user("q"), assistant([{ type: "text", text: "a" }], { stopReason: "stop" })];
  const finished = buildTurnModel(messages, ["u1", "a1"], { busy: false, streaming: false }, new Map(), new Map());
  assert.equal(finished.turns[0].live, false);
  assert.equal(finished.hasLiveTurn, false);
  const running = buildTurnModel(messages, ["u1", "a1"], { busy: true, streaming: false }, new Map(), new Map());
  assert.equal(running.turns[0].live, true);
});

test("streaming split keeps fences, lists and quotes together and waits for a complete next line", () => {
  const para = "这是一段比较长的中文段落，用来让文本超过拆分门槛。".repeat(8);
  const markdown = `${para}\n\n\`\`\`js\nconst a = 1;\n\nconst b = 2;\n\`\`\`\n\n1. one\n\n2. two\n\n${para}\n\n${para}`;
  const split = splitStreamingMarkdown(markdown);
  assert.ok(split);
  assert.equal(split.stable.join("\n") + "\n" + split.tail, markdown);
  assert.ok(split.stable.some((block) => block.includes("const a = 1;\n\nconst b = 2;")), "fence is not split");
  assert.ok(split.stable.some((block) => block.includes("1. one\n\n2. two")), "loose list is not split");
  assert.equal(splitStreamingMarkdown(`${para}\n\n[^1]: note\n\n${para}`), null, "footnotes disable splitting");
  assert.equal(splitStreamingMarkdown(`${para}\n\n${para}\n\nabc`), null, "an incomplete next line is not a split point");
});

test("turn-end reload merges into loaded history and keeps message objects", () => {
  const m = (id) => ({ role: "assistant", content: [{ type: "text", text: id }], id });
  const loaded = { messages: [m("a"), m("b"), m("c")], entryIds: ["a", "b", "c"], oldestEntryId: "a", hasMore: true };
  const fresh = { messages: [m("b"), m("c"), m("d")], entryIds: ["b", "c", "d"], oldestEntryId: "b", hasMore: true };
  const merged = mergeLoadedWindow(loaded, fresh);
  assert.deepEqual(merged.entryIds, ["a", "b", "c", "d"]);
  assert.equal(merged.messages[1], loaded.messages[1], "existing entries keep their objects");
  assert.equal(merged.messages[3], fresh.messages[2]);
  assert.equal(merged.oldestEntryId, "a");
  assert.equal(mergeLoadedWindow(loaded, { ...fresh, entryIds: ["b", "x", "d"] }), null, "diverged branch replaces");
  assert.equal(mergeLoadedWindow(loaded, { ...fresh, entryIds: ["q", "r", "s"] }), null, "no overlap replaces");
});
