import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchPrefilterKey, searchSessionContents } from "./session-search.ts";

function fixture(t, entries, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { id: "session", path, cwd: dir, created: "2026-01-01", modified: "2026-01-01", firstMessage: "first", messageCount: entries.length, ...overrides };
}

function message(role, content) {
  return { type: "message", message: { role, content } };
}

test("finds one literal, case-insensitive snippet per session, newest first", async (t) => {
  const older = fixture(t, [{ ...message("user", "before NEEDLE after"), id: "matched-entry" }, message("user", "needle again")], { id: "older" });
  const newer = fixture(t, [message("assistant", [{ type: "text", text: "another needle" }])], { id: "newer", modified: "2026-02-01" });
  const result = await searchSessionContents([older, newer], " needle ");
  assert.deepEqual(result.results.map(({ session }) => session.id), ["newer", "older"]);
  assert.deepEqual(result.results[1], { session: older, entryId: "matched-entry", blockIndex: 0, before: "before ", match: "NEEDLE", after: " after" });
  assert.equal(result.truncated, false);

  const literal = fixture(t, [message("user", "a".repeat(40) + "!"), message("user", "literal (a+)+$ and [test].*")]);
  assert.equal((await searchSessionContents([literal], "(a+)+$")).results[0].match, "(a+)+$");
  assert.equal((await searchSessionContents([literal], "[test].*")).results[0].match, "[test].*");
});

test("identifies the matching text block across thinking, tools and multiple text blocks", async (t) => {
  const session = fixture(t, [message("assistant", [
    { type: "thinking", thinking: "pi-cwd-spark" },
    { type: "text", text: "earlier text" },
    { type: "toolCall", name: "read", arguments: {} },
    { type: "text", text: "正文 pi-cwd-spark" },
    { type: "text", text: "later text" },
  ])]);
  assert.equal((await searchSessionContents([session], "pi-cwd-spark")).results[0].blockIndex, 3);
  assert.equal((await searchSessionContents([session], "earlier text")).results[0].blockIndex, 1);
  assert.equal((await searchSessionContents([session], "later text")).results[0].blockIndex, 4);
  assert.equal((await searchSessionContents([session], "spark\nlater")).results[0].blockIndex, 3);
});

test("searches historical text, excluding tools, thinking, images, summaries and transient sessions", async (t) => {
  const hidden = fixture(t, [
    message("toolResult", "needle"),
    message("assistant", [{ type: "thinking", thinking: "needle" }, { type: "toolCall", arguments: { text: "needle" } }, { type: "image", data: "needle" }]),
    { type: "compaction", summary: "needle" },
    { type: "custom", data: "needle" },
    message("user", null),
    null,
  ]);
  assert.deepEqual((await searchSessionContents([hidden], "needle")).results, []);
  const history = fixture(t, [message("user", "needle before compaction"), { type: "compaction", summary: "summary" }, message("user", "current")]);
  assert.equal((await searchSessionContents([history], "needle")).results.length, 1);
  assert.deepEqual((await searchSessionContents([{ ...history, transient: true }], "needle")).results, []);
});

test("keeps Unicode offsets correct and bounds snippets around the actual match", async (t) => {
  const session = fixture(t, [message("user", `${"x".repeat(200)}\n\u0130 中文 NEEDLE \n${"y".repeat(200)}`)]);
  const result = await searchSessionContents([session], "needle");
  assert.equal(result.results[0].match, "NEEDLE");
  assert.ok(result.results[0].before.startsWith("..."));
  assert.ok(result.results[0].after.endsWith("..."));
  assert.ok(result.results[0].before.length <= 83);
  assert.doesNotMatch(result.results[0].before, /\n/);
  assert.equal((await searchSessionContents([session], "中文")).results[0].match, "中文");
});

test("skips malformed lines and reports unreadable or oversized content as incomplete", async (t) => {
  const session = fixture(t, [message("user", "x".repeat(1024 * 1024 + 1)), message("user", "needle")]);
  const missing = { ...session, id: "missing", path: join(session.cwd, "missing.jsonl") };
  const result = await searchSessionContents([missing, session], "needle");
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, true);
  writeFileSync(session.path, `invalid\n${JSON.stringify(message("user", "needle"))}\n{"type":`);
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
});

test("handles empty, oversized and cancelled queries without reading a session", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  assert.deepEqual(await searchSessionContents([session], "  "), { results: [], truncated: false });
  await assert.rejects(searchSessionContents([session], "x".repeat(201)), RangeError);
  assert.deepEqual(await searchSessionContents([session], "needle", AbortSignal.abort()), { results: [], truncated: true });
});

test("searches whole files and reports only lines too long to parse as incomplete", async (t) => {
  const session = fixture(t, []);
  // The old 16MB-per-file bound is gone: a match after it is found.
  writeFileSync(session.path, " ".repeat(16 * 1024 * 1024) + "\n" + JSON.stringify(message("user", "needle")));
  const found = await searchSessionContents([session], "needle");
  assert.equal(found.results.length, 1);
  assert.equal(found.truncated, false);
  // A single line longer than 16MB is skipped and makes the search incomplete.
  writeFileSync(session.path, "x".repeat(17 * 1024 * 1024) + "\n" + JSON.stringify(message("user", "needle")));
  const skipped = await searchSessionContents([session], "needle");
  assert.equal(skipped.results.length, 1);
  assert.equal(skipped.truncated, true);
});

test("stops at the time budget and reports the search as incomplete", async (t) => {
  const session = fixture(t, [message("user", "no match"), message("user", "needle")]);
  let ticks = 0;
  t.mock.method(Date, "now", () => ++ticks <= 1 ? 0 : 9000);
  assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
});

test("searches every catalogued file and caps results at 30 in catalogue order", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  const sessions = Array.from({ length: 501 }, (_, index) => ({ ...session, id: String(index) }));
  // A miss reads every file instead of stopping after 500 files or 3 seconds.
  const noMatches = await searchSessionContents(sessions, "absent");
  assert.deepEqual(noMatches, { results: [], truncated: false });
  const capped = await searchSessionContents(sessions, "needle");
  assert.equal(capped.results.length, 30);
  assert.deepEqual(capped.results.map((result) => result.session.id), Array.from({ length: 30 }, (_, index) => String(index)));
  assert.equal(capped.truncated, true);
  assert.equal((await searchSessionContents(sessions.slice(0, 30), "needle")).truncated, false);
});

test("prefilter key is the longest case-safe run, JSON-escaped", () => {
  assert.equal(searchPrefilterKey("Pi-Web"), "Pi-Web");
  assert.equal(searchPrefilterKey('say "Hi"'), 'say \\"Hi\\"');
  assert.equal(searchPrefilterKey("C:\\Users"), "C:\\\\Users");
  assert.equal(searchPrefilterKey("Äpfel"), "pfel");
  assert.equal(searchPrefilterKey("spark\nlater"), "spark");
  assert.equal(searchPrefilterKey("Ä"), "");
  assert.equal(searchPrefilterKey("中文"), "中文");
});

test("finds escaped, mixed-case and non-ASCII-cased text through the byte prefilter", async (t) => {
  const session = fixture(t, [
    message("toolResult", 'C:\\Users\\Demo "Quoted" ÄPFEL'),
    { ...message("user", 'open C:\\Users\\Demo and the "Quoted" ÄPFEL\twith tab'), id: "u1" },
  ]);
  for (const [query, match] of [["c:\\users\\demo", "C:\\Users\\Demo"], ['"quoted"', '"Quoted"'], ["äpfel", "ÄPFEL"], ["ÄPFEL\twith", "ÄPFEL with"], ["ä", "Ä"]]) {
    const result = await searchSessionContents([session], query);
    assert.equal(result.results.length, 1, query);
    assert.equal(result.results[0].entryId, "u1", query);
    assert.equal(result.results[0].match, match, query);
  }
});

test("finds a match on a line that spans read chunks", async (t) => {
  const session = fixture(t, [
    message("assistant", "y".repeat(3 * 1024 * 1024)),
    { ...message("user", `${"z".repeat(1024 * 1024 + 7)} needle`), id: "late" },
  ]);
  const result = await searchSessionContents([session], "NEEDLE");
  assert.equal(result.results[0]?.entryId, "late");
  assert.equal(result.truncated, false);
});
