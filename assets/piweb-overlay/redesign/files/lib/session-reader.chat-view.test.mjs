// ?view=chat (opt-in timeline payload) and the per-session derived-value memo.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionContext, memoizeSessionDerived } = await jiti.import("./session-reader.ts");

const timestamp = "2026-01-01T00:00:00.000Z";
let seq = 0;
function entry(message) {
  seq += 1;
  return { type: "message", id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, timestamp, message };
}

function fixture() {
  seq = 0;
  const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+export const x = 1;\n*** End Patch";
  return [
    entry({ role: "user", content: "改一下", timestamp: 1 }),
    entry({
      role: "assistant",
      content: [
        { type: "text", text: "我先看看文件。" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts", offset: 10 } },
        { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm test ".repeat(50) } },
        { type: "toolCall", id: "patch-1", name: "apply_patch", arguments: { input: patch } },
      ],
      timestamp: 2,
    }),
    entry({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "x".repeat(5000) }], isError: false, timestamp: 3 }),
    entry({ role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: "boom" }, { type: "image", data: "aGk=", mimeType: "image/png" }], isError: true, timestamp: 4 }),
    entry({ role: "toolResult", toolCallId: "patch-1", toolName: "apply_patch", content: [{ type: "text", text: "applied" }], details: { result: { appliedFiles: ["src/new.ts"] } }, timestamp: 5 }),
    entry({ role: "assistant", content: [{ type: "text", text: "改好了。" }], timestamp: 6 }),
  ];
}

test("the default context shape is unchanged when view is not requested", () => {
  const entries = fixture();
  const plain = buildSessionContext(entries, "e6", { tail: 50 });
  assert.equal(plain.messages[2].content[0].text.length, 5000);
  assert.deepEqual(plain.messages[1].content[1].input, { path: "src/a.ts", offset: 10 });
  assert.equal(plain.messages[1].content[1].chatView, undefined);
});

test("view=chat keeps tool metadata and previews, and precomputes failures and written files", () => {
  const entries = fixture();
  const plain = buildSessionContext(entries, "e6", { tail: 50 });
  const chat = buildSessionContext(entries, "e6", { tail: 50, view: "chat", cwd: "C:\\repo" });

  assert.deepEqual(chat.entryIds, plain.entryIds);
  assert.deepEqual(chat.messages[0], plain.messages[0], "user messages are untouched");
  assert.deepEqual(chat.messages[5], plain.messages[5], "assistant text is untouched");

  const [text, read, bash, patch] = chat.messages[1].content;
  assert.deepEqual(text, plain.messages[1].content[0]);
  assert.deepEqual(read.input, { path: "src/a.ts" });
  assert.equal(read.chatView.failed, false);
  assert.deepEqual(bash.input, {});
  assert.equal(bash.chatView.failed, true);
  assert.ok(bash.chatView.inputBytes > 400);
  assert.deepEqual(patch.input, {});
  assert.deepEqual(patch.chatView.writtenPaths, ["C:/repo/src/new.ts"]);

  const [readResult, bashResult, patchResult] = chat.messages.slice(2, 5);
  assert.equal(readResult.content[0].text.length, 200);
  assert.equal(readResult.chatView.truncated, true);
  assert.ok(readResult.chatView.bytes > 5000);
  assert.equal(readResult.timestamp, 3);
  assert.equal(bashResult.isError, true);
  assert.equal(bashResult.chatView.images, 1);
  assert.equal(bashResult.content.length, 1);
  assert.equal(bashResult.details, undefined);
  assert.deepEqual(patchResult.details, { result: { appliedFiles: ["src/new.ts"] } }, "apply_patch keeps details for failure/written-file logic");

  assert.ok(JSON.stringify(chat).length < JSON.stringify(plain).length / 3);
});

test("derived values are memoized per session manager until its version changes", () => {
  const sm = {};
  let computed = 0;
  const compute = () => ++computed;
  assert.equal(memoizeSessionDerived(sm, "3:e3:e3", "stats", compute), 1);
  assert.equal(memoizeSessionDerived(sm, "3:e3:e3", "stats", compute), 1);
  assert.equal(memoizeSessionDerived(sm, "3:e3:e3", "tree", compute), 2);
  assert.equal(memoizeSessionDerived(sm, "4:e4:e4", "stats", compute), 3, "an appended entry invalidates");
  assert.equal(memoizeSessionDerived({}, "4:e4:e4", "stats", compute), 4, "memo is per session manager");
});
