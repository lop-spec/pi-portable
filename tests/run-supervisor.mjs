import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUN_SUPERVISOR_VERSION,
  RECOVERY_PREFIX,
  DurableRunStore,
  RunSupervisor,
  SessionFileIndex,
  buildRecoveryPrompt,
  buildTransientRecoveryPrompt,
  decideRunAction,
  failureFingerprint,
  isFastFailureSnapshot,
  noteFailure,
  recoveryDelayMs,
  recoveryHoldReason,
  shouldClearFailureStreak,
  FILE_QUIET_MS,
  FILE_QUIET_FAST_MS,
  MIN_RECOVERY_INTERVAL_FAST_MS,
} from "../src/run-supervisor.mjs";

const header = (id = "01a05769-3ff4-779a-b9c6-f5364d206206") => ({
  type: "session", version: 3, id, timestamp: "2026-08-31T10:00:00.000Z", cwd: "C:/work",
});
const entry = (id, parentId, value) => ({ id, parentId, timestamp: value.timestamp || "2026-08-31T10:00:01.000Z", ...value });
const message = (id, parentId, role, extra = {}) => entry(id, parentId, {
  type: "message",
  message: { role, content: extra.content || [{ type: "text", text: extra.text || "" }], ...extra.message },
  timestamp: extra.timestamp,
});
const custom = (id, parentId, customType, data, timestamp) => entry(id, parentId, {
  type: "custom", customType, data, timestamp,
});
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

function fixture(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-supervisor-test-"));
  const file = path.join(root, "session.jsonl");
  writeRows(file, rows);
  return { root, file };
}

test("session index follows the active branch and exposes active goal plus pending tool result", () => {
  const rows = [
    header(),
    message("u1", null, "user", { text: "实施并验证", timestamp: "2026-08-31T10:00:01.000Z" }),
    custom("g1", "u1", "lop-checklist-goal-state", {
      version: 1, status: "active", objective: "实施并验证", taskUserEntryId: "u1", items: [{ text: "完成", key: "完成" }],
    }, "2026-08-31T10:00:02.000Z"),
    message("a1", "g1", "assistant", {
      message: { stopReason: "toolUse" },
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "curl -X DELETE https://example.invalid/item/1" } }],
      timestamp: "2026-08-31T10:00:03.000Z",
    }),
    entry("t1", "a1", { type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }] }, timestamp: "2026-08-31T10:00:04.000Z" }),
  ];
  const { file } = fixture(rows);
  const index = new SessionFileIndex(file);
  const snapshot = index.refresh();
  assert.equal(snapshot.sessionId, header().id);
  assert.equal(snapshot.leafId, "t1");
  assert.equal(snapshot.lastMessage.role, "toolResult");
  assert.equal(snapshot.goalState.status, "active");
  assert.equal(snapshot.rootUserEntryId, "u1");
  assert.deepEqual(snapshot.unresolvedToolCalls, []);
  assert.equal(index.parseErrors, 0);
});

test("incremental index resolves a previously incomplete tool without reparsing old rows", () => {
  const rows = [
    header(),
    message("u1", null, "user", { text: "执行" }),
    message("a1", "u1", "assistant", {
      message: { stopReason: "toolUse" },
      content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "C:/tmp/a", content: "x" } }],
    }),
  ];
  const { file } = fixture(rows);
  const index = new SessionFileIndex(file);
  let snapshot = index.refresh();
  assert.equal(snapshot.unresolvedToolCalls.length, 1);
  const beforeCount = index.entryCount;
  fs.appendFileSync(file, JSON.stringify(entry("t1", "a1", {
    type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }] },
  })) + "\n");
  snapshot = index.refresh();
  assert.equal(index.entryCount, beforeCount + 1);
  assert.deepEqual(snapshot.unresolvedToolCalls, []);
});

test("a terminal answer with a completed goal is not poisoned forever by a historical interrupted tool call", () => {
  const rows = [
    header(),
    message("u1", null, "user", { text: "实施并验证" }),
    custom("g1", "u1", "lop-checklist-goal-state", {
      version: 1, status: "active", taskUserEntryId: "u1", items: [{ text: "完成", key: "完成", done: false }],
    }),
    message("a1", "g1", "assistant", {
      message: { stopReason: "toolUse" },
      content: [{ type: "toolCall", id: "call-interrupted", name: "write", arguments: { path: "C:/tmp/a", content: "x" } }],
    }),
    message("r1", "a1", "user", { text: `${RECOVERY_PREFIX} run=r1 attempt=1` }),
    custom("g2", "r1", "lop-checklist-goal-state", {
      version: 1, status: "complete", taskUserEntryId: "u1", items: [{ text: "完成", key: "完成", done: true }],
    }),
    message("a2", "g2", "assistant", { message: { stopReason: "stop" }, text: "【验收清单】1/1 全部完成" }),
  ];
  const { file } = fixture(rows);
  const snapshot = new SessionFileIndex(file).refresh();
  assert.equal(snapshot.unresolvedToolCalls.length, 1, "journal truth keeps the interrupted call available for recovery safety");
  assert.equal(snapshot.goalState.status, "complete");
  assert.deepEqual(decideRunAction({ snapshot, running: false }), { action: "complete", reason: "terminal-assistant" });
});

test("durable cancellation wins even when before_agent_start writes it before the user entry", () => {
  const rows = [
    header(),
    message("u1", null, "user", { text: "实施并验证", timestamp: "2026-08-31T10:00:01.000Z" }),
    custom("g1", "u1", "lop-checklist-goal-state", { version: 1, status: "active", taskUserEntryId: "u1", items: [] }, "2026-08-31T10:00:02.000Z"),
    custom("g2", "g1", "lop-checklist-goal-state", { version: 1, status: "inactive", taskUserEntryId: "u1", items: [] }, "2026-08-31T10:00:02.500Z"),
    custom("c1", "g2", "lop-run-control", { version: 1, action: "cancel", reason: "text" }, "2026-08-31T10:00:03.000Z"),
    message("u2", "c1", "user", { text: "取消当前目标", timestamp: "2026-08-31T10:00:04.000Z" }),
  ];
  const { file } = fixture(rows);
  const index = new SessionFileIndex(file);
  let snapshot = index.refresh();
  assert.equal(snapshot.cancelled, true);
  fs.appendFileSync(file, JSON.stringify(message("u3", "u2", "user", { text: "开始一个新任务", timestamp: "2026-08-31T10:00:05.000Z" })) + "\n");
  snapshot = index.refresh();
  assert.equal(snapshot.cancelled, false, "a later real user prompt starts a new run rather than inheriting cancellation");
});

test("decision recovers abnormal leaves and active goals, but completes ordinary terminal answers", () => {
  const base = { sessionId: "s", rootUserEntryId: "u1", leafId: "t1", cancelled: false, blocked: false };
  assert.equal(decideRunAction({ snapshot: { ...base, lastMessage: { role: "toolResult" }, goalState: null }, running: false }).action, "recover");
  assert.equal(decideRunAction({ snapshot: { ...base, lastMessage: { role: "assistant", stopReason: "error", errorMessage: "terminated" }, goalState: null }, running: false }).action, "recover");
  assert.equal(decideRunAction({ snapshot: { ...base, lastMessage: { role: "assistant", stopReason: "stop" }, goalState: { status: "active" } }, running: false }).action, "recover");
  assert.equal(decideRunAction({ snapshot: { ...base, lastMessage: { role: "assistant", stopReason: "stop" }, goalState: null }, running: false }).action, "complete");
  assert.equal(decideRunAction({ snapshot: { ...base, cancelled: true, lastMessage: { role: "toolResult" }, goalState: { status: "active" } }, running: false }).action, "cancel");
  assert.equal(decideRunAction({ snapshot: { ...base, blocked: true, lastMessage: { role: "toolResult" }, goalState: { status: "blocked" } }, running: false }).action, "block");
  assert.equal(decideRunAction({ snapshot: { ...base, lastMessage: { role: "toolResult" }, goalState: null }, running: true }).action, "wait");
});

test("storm guards: file activity vetoes recovery, min-interval holds, streak survives flapping progress", () => {
  const base = { sessionId: "s", rootUserEntryId: "u1", leafId: "t1", cancelled: false, blocked: false };
  // 2026-09-01 实录:running 注册表假阴性把活会话连注 14 次恢复;文件仍在追加即必须 wait。
  const unsettled = { ...base, lastMessage: { role: "assistant", stopReason: "toolUse" }, goalState: null };
  assert.deepEqual(decideRunAction({ snapshot: unsettled, running: false, fileActive: true }), { action: "wait", reason: "file-activity" });
  assert.equal(decideRunAction({ snapshot: unsettled, running: false, fileActive: false }).action, "recover");
  // fileActive 不得压制终态/取消/拉黑判定。
  assert.equal(decideRunAction({ snapshot: { ...base, lastMessage: { role: "assistant", stopReason: "stop" }, goalState: null }, running: false, fileActive: true }).action, "complete");
  assert.equal(decideRunAction({ snapshot: { ...base, cancelled: true, lastMessage: { role: "toolResult" }, goalState: null }, running: false, fileActive: true }).action, "cancel");
  // 同一 run 两次恢复注入的硬下限。
  const now = Date.parse("2026-09-01T12:10:00.000Z");
  assert.equal(recoveryHoldReason({ lastRecoveryAt: "2026-09-01T12:05:00.000Z" }, now), "min-recovery-interval");
  assert.equal(recoveryHoldReason({ lastRecoveryAt: "2026-09-01T11:55:00.000Z" }, now), "");
  assert.equal(recoveryHoldReason({}, now), "");
  // 恢复后未满稳定窗口的"进展"不许清同失败计数(否则熔断被翻抖绕过)。
  const streak = { sameFailureCount: 2, lastRecoveryAt: "2026-09-01T12:08:00.000Z" };
  assert.equal(shouldClearFailureStreak(streak, now), false);
  assert.equal(shouldClearFailureStreak(streak, now + 9 * 60 * 1000), true);
  assert.equal(shouldClearFailureStreak({ sameFailureCount: 0 }, now), false);
  assert.equal(shouldClearFailureStreak({ sameFailureCount: 1 }, now), true);
});

// 2026-09-04:一次上游 503 曾要等满 10 分钟判活窗口才恢复。确定死亡信号走快窗口,模糊信号不动。
test("fast lane: only assistant/error shortens the quiet and min-interval windows", () => {
  const base = { sessionId: "s", rootUserEntryId: "u1", leafId: "t1", cancelled: false, blocked: false, goalState: null };
  assert.equal(isFastFailureSnapshot({ ...base, lastMessage: { role: "assistant", stopReason: "error", errorMessage: "upstream 503" } }), true);
  // 模糊信号一律留在 10 分钟窗口:未闭合工具、人为中止、孤儿用户轮。
  assert.equal(isFastFailureSnapshot({ ...base, lastMessage: { role: "assistant", stopReason: "toolUse" } }), false);
  assert.equal(isFastFailureSnapshot({ ...base, lastMessage: { role: "assistant", stopReason: "aborted" } }), false);
  assert.equal(isFastFailureSnapshot({ ...base, lastMessage: { role: "user" } }), false);
  assert.equal(isFastFailureSnapshot(null), false);

  assert.ok(FILE_QUIET_FAST_MS <= 2 * 60 * 1000, "快窗口必须落在 1-2 分钟内");
  assert.ok(FILE_QUIET_FAST_MS < FILE_QUIET_MS);

  // 快间隔下 5 分钟前的上一次恢复不再压制;默认间隔仍压制(见上一个用例)。
  const now = Date.parse("2026-09-01T12:10:00.000Z");
  assert.equal(recoveryHoldReason({ lastRecoveryAt: "2026-09-01T12:05:00.000Z" }, now, { minIntervalMs: MIN_RECOVERY_INTERVAL_FAST_MS }), "");
  assert.equal(recoveryHoldReason({ lastRecoveryAt: "2026-09-01T12:09:30.000Z" }, now, { minIntervalMs: MIN_RECOVERY_INTERVAL_FAST_MS }), "min-recovery-interval");

  // 硬门:快通道不得放宽熔断。同一失败第 3 次仍必须 blocked。
  let record = { totalRecoveries: 0 };
  for (let i = 0; i < 3; i += 1) record = noteFailure(record, "error:upstream 503");
  assert.equal(record.status, "blocked");
  assert.equal(record.blockReason, "same-failure-limit");
});

test("recovery prompt continues from the leaf and never embeds or replays tool arguments", () => {
  const dangerous = "curl -X DELETE https://example.invalid/items/42";
  const prompt = buildRecoveryPrompt({
    sessionId: "s", leafId: "a1", lastMessage: { role: "assistant", stopReason: "toolUse" },
    unresolvedToolCalls: [{ id: "call-1", name: "bash", argumentsPreview: dangerous }],
  }, { runId: "r1", recoveryAttempt: 1 });
  assert.match(prompt, new RegExp(`^${RECOVERY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(prompt, /先只读核对副作用是否已经发生/);
  assert.match(prompt, /bash/);
  assert.doesNotMatch(prompt, /example\.invalid|DELETE|items\/42/);
});

test("same-leaf dispatch is single-flight and the third identical failure becomes blocked", () => {
  assert.deepEqual([1, 2, 3].map(recoveryDelayMs), [2000, 5000, 15000]);
  const fp = failureFingerprint({ lastMessage: { role: "assistant", stopReason: "error", errorMessage: "terminated" } });
  let record = { status: "running", sameFailureFingerprint: "", sameFailureCount: 0, totalRecoveries: 0 };
  record = noteFailure(record, fp);
  assert.equal(record.status, "recovering");
  record = noteFailure(record, fp);
  assert.equal(record.status, "recovering");
  record = noteFailure(record, fp);
  assert.equal(record.status, "blocked");
  assert.equal(record.sameFailureCount, 3);
  assert.equal(record.blockReason, "same-failure-limit");
});

test("durable store writes atomically and preserves cancellation and blocked records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-store-test-"));
  const file = path.join(root, "run-supervisor", "state.json");
  const store = new DurableRunStore(file, { now: () => Date.parse("2026-08-31T10:00:00.000Z") });
  const state = store.load();
  state.sessions.s1 = { status: "cancelled", runId: "r1" };
  state.sessions.s2 = { status: "blocked", runId: "r2", sameFailureCount: 3 };
  store.save(state);
  const readback = new DurableRunStore(file).load();
  assert.equal(readback.version, 1);
  assert.equal(readback.sessions.s1.status, "cancelled");
  assert.equal(readback.sessions.s2.sameFailureCount, 3);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-")).length, 0);
});

test("public proxy journals prompt intent before forwarding and an explicit abort wins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-intent-test-"));
  const supervisor = new RunSupervisor({ dataRoot: root, sessionRoot: path.join(root, "sessions"), webPort: 39981, now: () => Date.parse("2026-08-31T10:00:00.000Z") });
  const record = supervisor.captureKnownPromptIntent("s1", {
    cwd: "C:/work", message: "原始请求", images: [{ type: "image", data: "base64-payload", mimeType: "image/png" }],
  });
  assert.equal(record.capturedBeforeForward, true);
  assert.equal(record.rootPrompt, "原始请求");
  assert.equal(record.imageCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(record.intentFile, "utf8")).images[0].data, "base64-payload");
  let persisted = JSON.parse(fs.readFileSync(path.join(root, "run-supervisor", "state.json"), "utf8"));
  assert.equal(persisted.sessions.s1.status, "forwarding");
  supervisor.cancelKnownRun("s1", "public-api-abort");
  persisted = JSON.parse(fs.readFileSync(path.join(root, "run-supervisor", "state.json"), "utf8"));
  assert.equal(persisted.sessions.s1.status, "cancelled");
  assert.equal(persisted.sessions.s1.explicitUserAbort, true);
  const transientPrompt = buildTransientRecoveryPrompt({ runId: "r1", recoveryAttempt: 1, rootPrompt: "原始请求" });
  assert.match(transientPrompt, /^\[lop-run-supervisor recovery\]/u);
  assert.match(transientPrompt, /原始请求/u);
  assert.match(transientPrompt, /尚未产生或执行任何工具调用/u);
});

test("new-session intent binds to the real id only after the upstream accepts it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-new-intent-test-"));
  const supervisor = new RunSupervisor({ dataRoot: root, sessionRoot: path.join(root, "sessions"), webPort: 39971, now: () => Date.parse("2026-08-31T10:00:00.000Z") });
  const intentId = supervisor.capturePendingNewIntent({ cwd: "C:/work", message: "首轮请求" });
  let persisted = JSON.parse(fs.readFileSync(path.join(root, "run-supervisor", "state.json"), "utf8"));
  assert.equal(persisted.pendingIntents[intentId].rootPrompt, "首轮请求");
  assert.equal(persisted.sessions.s2, undefined);
  supervisor.finalizePendingNewIntent(intentId, "s2", true);
  persisted = JSON.parse(fs.readFileSync(path.join(root, "run-supervisor", "state.json"), "utf8"));
  assert.equal(persisted.pendingIntents[intentId], undefined);
  assert.equal(persisted.sessions.s2.rootPrompt, "首轮请求");
  assert.equal(persisted.sessions.s2.status, "running");
});

test("transparent public proxy persists prompt and abort intent before upstream receives them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-proxy-test-"));
  const stateFile = path.join(root, "run-supervisor", "state.json");
  const observations = [];
  const upstream = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/agent/running") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ runningSessionIds: [] }));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      observations.push({ url: request.url, type: body.type, state });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/agent/new" ? { sessionId: "s2", accepted: true } : { data: null }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const reserve = async () => {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  };
  const publicPort = await reserve();
  let healthPort = await reserve();
  while (healthPort === publicPort) healthPort = await reserve();
  const supervisor = new RunSupervisor({ dataRoot: root, sessionRoot: path.join(root, "sessions"), webPort: upstreamPort, publicWebPort: publicPort, healthPort, pollMs: 10000 });
  await supervisor.start();
  await fetch(`http://127.0.0.1:${publicPort}/api/agent/s1`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", cwd: "C:/work", message: "先持久化" }),
  });
  assert.equal(observations[0].state.sessions.s1.status, "forwarding");
  assert.equal(observations[0].state.sessions.s1.rootPrompt, "先持久化");
  await fetch(`http://127.0.0.1:${publicPort}/api/agent/s1`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "abort" }),
  });
  assert.equal(observations[1].state.sessions.s1.status, "cancelled");
  await fetch(`http://127.0.0.1:${publicPort}/api/agent/new`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", cwd: "C:/work", message: "首轮也先持久化" }),
  });
  assert.equal(Object.keys(observations[2].state.pendingIntents).length, 1);
  const finalState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(finalState.sessions.s2.rootPrompt, "首轮也先持久化");
  await supervisor.close();
  await new Promise((resolve) => upstream.close(resolve));
});

test("runtime dispatches one persisted recovery per leaf within the recovery target", async () => {
  const id = "01a05769-3ff4-779a-b9c6-f5364d206206";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-runtime-test-"));
  const sessions = path.join(root, ".pi", "agent", "sessions", "--C--work--");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, `2026-08-31T10-00-00-000Z_${id}.jsonl`);
  writeRows(file, [
    header(id),
    message("u1", null, "user", { text: "实施并验证", timestamp: "2026-08-31T10:00:01.000Z" }),
  ]);
  let now = Date.parse("2026-08-31T10:00:02.000Z");
  let running = true;
  const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/api/agent/running")) {
      return new Response(JSON.stringify({ runningSessionIds: running ? [id] : [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (options.method === "POST" && String(url).includes(`/api/agent/${id}`)) {
      posts.push({ at: now, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ data: null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const supervisor = new RunSupervisor({
    dataRoot: root, sessionRoot: path.join(root, ".pi", "agent", "sessions"),
    webPort: 39991, healthPort: 39992, graceMs: 1500, now: () => now, fetchImpl,
  });
  supervisor.ensureEventStream = () => {};
  // 新语义:会话文件新鲜 = 活跃,恢复被否决;把 mtime 做旧超过 FILE_QUIET_MS 模拟真死
  // (须在首次 discover 之前做旧,mtime 缓存按 tick 刷新)。
  const agedSec = (now - 11 * 60 * 1000) / 1000;
  fs.utimesSync(file, agedSec, agedSec);
  supervisor.discover(true);
  await supervisor.tick();
  assert.equal(supervisor.state.sessions[id].status, "running");
  running = false;
  await supervisor.tick();
  now += 1000;
  await supervisor.tick();
  assert.equal(posts.length, 0);
  now += 1500;
  await supervisor.tick();
  assert.equal(posts.length, 1);
  assert.ok(posts[0].at - Date.parse("2026-08-31T10:00:02.000Z") <= 5000);
  assert.equal(posts[0].body.type, "prompt");
  assert.equal(posts[0].body.streamingBehavior, "followUp");
  assert.match(posts[0].body.message, /^\[lop-run-supervisor recovery\]/u);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, "run-supervisor", "state.json"), "utf8"));
  assert.equal(persisted.sessions[id].lastRecoveryLeafId, "u1");
  await supervisor.tick();
  assert.equal(posts.length, 1, "same leaf must not dispatch twice");
});

// 快通道的运行时行为:上游 5xx 打死的 run 在 2 分钟静默后就该恢复(旧口径要等满 10 分钟),
// 而未闭合工具调用这类模糊信号在同样的 2 分钟里必须继续 wait。
test("fast lane runtime: a 5xx-killed run recovers after 2 minutes while an unsettled tool call still waits", async () => {
  const run = async (stopReason, suffix) => {
    const id = `01a05769-3ff4-779a-b9c6-f5364d2062${suffix}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-fastlane-test-"));
    const sessions = path.join(root, ".pi", "agent", "sessions", "--C--work--");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, `2026-08-31T10-00-00-000Z_${id}.jsonl`);
    writeRows(file, [
      header(id),
      message("u1", null, "user", { text: "实施并验证", timestamp: "2026-08-31T10:00:01.000Z" }),
      message("a1", "u1", "assistant", {
        message: { stopReason, errorMessage: stopReason === "error" ? "upstream 503" : "" },
        content: stopReason === "toolUse"
          ? [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }]
          : [{ type: "text", text: "" }],
        timestamp: "2026-08-31T10:00:02.000Z",
      }),
    ]);
    let now = Date.parse("2026-08-31T10:10:00.000Z");
    let running = true;
    const posts = [];
    const fetchImpl = async (url, options = {}) => {
      if (String(url).endsWith("/api/agent/running")) {
        return new Response(JSON.stringify({ runningSessionIds: running ? [id] : [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (options.method === "POST" && String(url).includes(`/api/agent/${id}`)) {
        posts.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ data: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const supervisor = new RunSupervisor({
      dataRoot: root, sessionRoot: path.join(root, ".pi", "agent", "sessions"),
      webPort: 39993, healthPort: 39994, graceMs: 1500, now: () => now, fetchImpl,
    });
    supervisor.ensureEventStream = () => {};
    // 静默 2 分钟:短于旧的 10 分钟窗口,长于新的 90 秒快窗口。
    const agedSec = (now - 2 * 60 * 1000) / 1000;
    fs.utimesSync(file, agedSec, agedSec);
    supervisor.discover(true);
    await supervisor.tick(); // runner 在册:先建立持久 run 记录
    running = false;
    await supervisor.tick(); // 记下 notRunningSince
    now += 4000;             // 越过 graceMs 与首次恢复退避
    await supervisor.tick();
    fs.rmSync(root, { recursive: true, force: true });
    return posts;
  };

  const killedByUpstream = await run("error", "11");
  assert.equal(killedByUpstream.length, 1, "stopReason=error 是确定死亡,2 分钟即可恢复");
  assert.match(killedByUpstream[0].message, /^\[lop-run-supervisor recovery\]/u);

  const unsettledTool = await run("toolUse", "12");
  assert.equal(unsettledTool.length, 0, "未闭合工具调用仍受 10 分钟判活窗口保护,不得提前重投");
});

test("live smoke prepends the selected portable node so provider apiKey shell commands resolve", () => {
  const source = fs.readFileSync(new URL("../tools/run-supervisor-live-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /PATH:\s*\[path\.dirname\(nodeExe\)/u);
  assert.match(source, /Path:\s*\[path\.dirname\(nodeExe\)/u);
});

test("runtime version and recovery markers are explicit", () => {
  assert.equal(RUN_SUPERVISOR_VERSION, "run-supervisor-v2-fast-error");
  assert.equal(RECOVERY_PREFIX, "[lop-run-supervisor recovery]");
});

test("terminal sessions log once instead of every 500ms tick", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-quiet-test-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionId = "01a05769-3ff4-779a-b9c6-f5364d206206";
  const file = path.join(sessionRoot, `2026-08-31T11-00-00-000Z_${sessionId}.jsonl`);
  writeRows(file, [
    header(sessionId),
    message("u1", null, "user", { text: "go", timestamp: "2026-08-31T11:00:00.000Z" }),
    message("a1", "u1", "assistant", { text: "done", message: { stopReason: "stop" }, timestamp: "2026-08-31T11:00:05.000Z" }),
  ]);

  // now 早于会话的 root user 时间，记录才会被 track 而不是当成安装前的旧会话基线化。
  const supervisor = new RunSupervisor({
    dataRoot: root, sessionRoot, webPort: 39961, pollMs: 10000,
    now: () => Date.parse("2026-08-31T10:00:00.000Z"),
  });
  supervisor.discover();

  for (let i = 0; i < 5; i += 1) await supervisor.processSession(sessionId, false);
  const logRows = fs.readFileSync(path.join(root, "run-supervisor.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const completes = logRows.filter((row) => row.event === "run-complete");
  assert.equal(completes.length, 1, `run-complete must be logged once, got ${completes.length}`);
  assert.equal(supervisor.state.sessions[sessionId].status, "complete");

  // 会话文件消失后同一读取错误也只记一次（删测试会话时曾把日志刷到几百 KB）。
  fs.rmSync(file);
  for (let i = 0; i < 5; i += 1) await supervisor.processSession(sessionId, false);
  const afterRows = fs.readFileSync(path.join(root, "run-supervisor.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const readErrors = afterRows.filter((row) => row.event === "session-read-error");
  assert.equal(readErrors.length, 1, `session-read-error must be logged once, got ${readErrors.length}`);
});
