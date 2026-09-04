import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");

function createHarness(payload, options = {}) {
  const errors = [];
  const nativeCalls = [];
  const location = new URL("http://127.0.0.1:30141/");
  const window = {
    location,
    fetch: async (input, init) => {
      nativeCalls.push({ input: String(input), init });
      if (options.networkError) throw options.networkError;
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return new Response(body, {
        status: options.status ?? 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "content-encoding": "gzip",
        },
      });
    },
  };
  const document = {
    readyState: "loading",
    documentElement: { dataset: {}, lang: "zh-CN" },
    body: null,
    head: { appendChild() {} },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { dataset: {}, style: {}, setAttribute() {}, appendChild() {} }; },
  };
  class MutationObserver {
    observe() {}
  }
  vm.runInNewContext(source, {
    window,
    document,
    sessionStorage: { getItem() { return null; } },
    MutationObserver,
    Request,
    Response,
    Headers,
    URL,
    Set,
    WeakSet,
    Element: class Element {},
    MouseEvent: class MouseEvent {},
    console: { error: (...args) => errors.push(args.map(String).join(" ")) },
    setTimeout,
    clearTimeout,
    requestAnimationFrame() { return 0; },
    performance,
  });
  return { window, errors, nativeCalls };
}

const projectRoot = "C:\\Users\\lop\\Documents\\claude";
const main = { path: projectRoot, branch: "main", isMain: true };
const history = {
  path: "C:\\Users\\lop\\Documents\\claude-worktrees\\历史对话",
  branch: "历史对话",
  isMain: false,
};
const userCategory = {
  path: "c:/users/lop/documents/CLAUDE-worktrees/项目-A/",
  branch: "claude/user-named-category",
  isMain: false,
};
const claudeGenerated = {
  path: "C:\\Users\\lop\\Documents\\claude\\.claude\\worktrees\\generated-123456",
  branch: "claude/generated-123456",
  isMain: false,
};
const detachedGenerated = {
  path: "C:\\Users\\lop\\Documents\\claude\\运维\\.claude\\worktrees\\detached-123456",
  branch: null,
  isMain: false,
};
const externalManual = {
  path: "D:\\worktrees\\manual-feature",
  branch: "manual-feature",
  isMain: false,
};
const prefixCollision = {
  path: "C:\\Users\\lop\\Documents\\claude-worktrees-old\\not-a-category",
  branch: "not-a-category",
  isMain: false,
};

test("worktree selector exposes only main and Pi Web project-category worktrees", async () => {
  const harness = createHarness({
    projectRoot,
    currentWorktreePath: claudeGenerated.path,
    worktrees: [main, claudeGenerated, history, detachedGenerated, userCategory, externalManual, prefixCollision],
  });

  const response = await harness.window.fetch("/api/worktrees?cwd=C%3A%5CUsers%5Clop%5CDocuments%5Cclaude");
  const body = await response.json();

  assert.deepEqual(body.worktrees.map((worktree) => worktree.branch), ["main", "历史对话", "claude/user-named-category"]);
  assert.equal(body.currentWorktreePath, main.path, "a hidden active checkout must fall back to the visible main category");
  assert.equal(harness.nativeCalls.length, 1);
  assert.deepEqual(harness.errors, []);
  assert.equal(response.headers.has("content-length"), false, "rewritten JSON must not retain a stale byte length");
  assert.equal(response.headers.has("content-encoding"), false, "rewritten decoded JSON must not claim the old encoding");
});

test("a visible historical or user category remains the current worktree", async () => {
  const harness = createHarness({
    projectRoot,
    currentWorktreePath: history.path,
    worktrees: [main, history, claudeGenerated],
  });

  const body = await (await harness.window.fetch("http://127.0.0.1:30141/api/worktrees?cwd=x")).json();
  assert.equal(body.currentWorktreePath, history.path);
  assert.deepEqual(body.worktrees.map((worktree) => worktree.branch), ["main", "历史对话"]);
});

test("unexpected worktree payloads fail open with an unconditional error trace", async () => {
  const malformed = { currentWorktreePath: main.path, worktrees: [main, claudeGenerated] };
  const harness = createHarness(malformed);

  const body = await (await harness.window.fetch("/api/worktrees?cwd=x")).json();
  assert.deepEqual(body, malformed);
  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0], /\[pi-web worktrees\] visibility filter failed:/u);
});

test("worktree request failures are logged instead of silently degrading", async () => {
  const failure = new Error("offline");
  const harness = createHarness({}, { networkError: failure });

  await assert.rejects(() => harness.window.fetch("/api/worktrees?cwd=x"), /offline/u);
  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0], /\[pi-web worktrees\] list request failed:/u);
});
