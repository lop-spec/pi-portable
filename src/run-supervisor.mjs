// Pi Web durable run supervisor.
// Watches append-only session journals plus the live running registry, persists run intent,
// and resumes abnormal leaves through the existing Pi Web prompt API. It never replays tools.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_SUPERVISOR_VERSION = "run-supervisor-v1";
export const RECOVERY_PREFIX = "[lop-run-supervisor recovery]";
export const RUN_CONTROL_TYPE = "lop-run-control";
const GOAL_STATE_TYPE = "lop-checklist-goal-state";
const DEFAULT_BACKOFF_MS = Object.freeze([2000, 5000, 15000]);
const DEFAULT_POLL_MS = 500;
const DEFAULT_GRACE_MS = 1500;
const SAME_FAILURE_LIMIT = 3;
const TOTAL_RECOVERY_LIMIT = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (value = Date.now()) => new Date(value).toISOString();
const normalizeError = (value) => String(value || "unknown")
  .replace(/\s+/gu, " ").trim().toLocaleLowerCase().slice(0, 240);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("\n");
}

function promptText(message) {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    if (typeof message.text === "string") return message.text;
    try { return JSON.stringify(message); } catch {}
  }
  return String(message || "");
}

function simplifyEntry(raw) {
  const base = {
    id: String(raw?.id || ""),
    parentId: raw?.parentId == null ? null : String(raw.parentId),
    type: String(raw?.type || ""),
    timestamp: String(raw?.timestamp || ""),
  };
  if (raw?.type === "custom") {
    return { ...base, customType: String(raw.customType || ""), data: raw.data && typeof raw.data === "object" ? raw.data : null };
  }
  if (raw?.type !== "message") return base;
  const message = raw.message || {};
  const role = String(message.role || "");
  const result = {
    ...base,
    role,
    stopReason: message.stopReason == null ? "" : String(message.stopReason),
    errorMessage: message.errorMessage == null ? "" : String(message.errorMessage),
    text: textFromContent(message.content).slice(0, 8000),
    toolCallId: message.toolCallId == null ? "" : String(message.toolCallId),
    toolName: message.toolName == null ? "" : String(message.toolName),
    toolCalls: [],
  };
  if (role === "assistant" && Array.isArray(message.content)) {
    result.toolCalls = message.content.filter((part) => part?.type === "toolCall").map((part) => ({
      id: String(part.id || ""),
      name: String(part.name || ""),
      // Kept only for local risk classification. Recovery prompts never include it.
      argumentsPreview: JSON.stringify(part.arguments ?? {}).slice(0, 2000),
    }));
  }
  return result;
}

function isRecoveryUser(entry) {
  return entry?.role === "user" && String(entry.text || "").startsWith(RECOVERY_PREFIX);
}

function isExplicitCancellationText(value) {
  const text = String(value || "").normalize("NFKC").trim();
  return /^(?:\/lop-goal-cancel|取消(?:当前)?目标|放弃(?:当前)?目标|停止自动续跑|不要再继续(?:这个|该)?任务)[。.!！\s]*$/u.test(text);
}

function activePath(entries, leafId) {
  const result = [];
  const seen = new Set();
  let id = leafId;
  while (id && entries.has(id) && !seen.has(id)) {
    seen.add(id);
    const current = entries.get(id);
    result.push(current);
    id = current.parentId;
  }
  return result.reverse();
}

function makeSnapshot(sessionId, filePath, entries, leafId, parseErrors) {
  const branch = activePath(entries, leafId);
  const messages = branch.filter((item) => item.type === "message" && item.role);
  const realUsers = messages.filter((item) => item.role === "user" && !isRecoveryUser(item));
  const rootUser = realUsers.at(-1) || null;
  const lastMessage = messages.at(-1) || null;
  const goalEntry = branch.filter((item) => item.type === "custom" && item.customType === GOAL_STATE_TYPE).at(-1) || null;
  const controlEntry = branch.filter((item) => item.type === "custom" && item.customType === RUN_CONTROL_TYPE).at(-1) || null;
  const cancelAt = controlEntry?.data?.action === "cancel" ? Date.parse(controlEntry.timestamp || "") : 0;
  const rootAt = Date.parse(rootUser?.timestamp || "") || 0;
  // before_agent_start may append the durable control immediately before Pi persists the
  // cancelling user message, so branch order/text is authoritative when timestamps invert.
  const cancelled = Boolean(cancelAt && (!rootAt || cancelAt >= rootAt || isExplicitCancellationText(rootUser?.text)));
  const goalState = goalEntry?.data && typeof goalEntry.data === "object" ? goalEntry.data : null;
  const blocked = goalState?.status === "blocked";

  const pendingTools = new Map();
  for (const item of messages) {
    if (item.role === "assistant") for (const call of item.toolCalls || []) if (call.id) pendingTools.set(call.id, call);
    if (item.role === "toolResult" && item.toolCallId) pendingTools.delete(item.toolCallId);
  }

  return {
    sessionId,
    filePath,
    leafId,
    rootUserEntryId: rootUser?.id || "",
    rootUserAt: rootUser?.timestamp || "",
    lastMessage,
    goalState,
    goalEntryId: goalEntry?.id || "",
    cancelled,
    blocked,
    control: controlEntry?.data || null,
    unresolvedToolCalls: [...pendingTools.values()],
    parseErrors,
    branchLength: branch.length,
  };
}

/** Incrementally indexes an append-only Pi session JSONL file. */
export class SessionFileIndex {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.sessionId = "";
    this.entries = new Map();
    this.leafId = "";
    this.offset = 0;
    this.parseErrors = 0;
    this.lastSnapshot = null;
  }

  get entryCount() { return this.entries.size; }

  reset() {
    this.sessionId = "";
    this.entries.clear();
    this.leafId = "";
    this.offset = 0;
    this.parseErrors = 0;
    this.lastSnapshot = null;
  }

  refresh() {
    const stat = fs.statSync(this.filePath);
    if (stat.size < this.offset) this.reset();
    if (stat.size === this.offset && this.lastSnapshot) return this.lastSnapshot;
    const length = stat.size - this.offset;
    if (length <= 0) return this.lastSnapshot;
    const fd = fs.openSync(this.filePath, "r");
    let bytes;
    try {
      bytes = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, bytes, 0, length, this.offset);
      bytes = bytes.subarray(0, read);
    } finally { fs.closeSync(fd); }
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return this.lastSnapshot;
    const complete = bytes.subarray(0, lastNewline + 1).toString("utf8");
    this.offset += lastNewline + 1;
    for (const rawLine of complete.split(/\n/u)) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); }
      catch { this.parseErrors += 1; continue; }
      if (raw?.type === "session") {
        this.sessionId = String(raw.id || this.sessionId);
        continue;
      }
      const value = simplifyEntry(raw);
      if (!value.id) { this.parseErrors += 1; continue; }
      this.entries.set(value.id, value);
      this.leafId = value.id;
    }
    this.lastSnapshot = makeSnapshot(this.sessionId, this.filePath, this.entries, this.leafId, this.parseErrors);
    return this.lastSnapshot;
  }
}

export function recoveryDelayMs(attempt) {
  const value = Math.max(1, Math.trunc(Number(attempt) || 1));
  return DEFAULT_BACKOFF_MS[Math.min(DEFAULT_BACKOFF_MS.length - 1, value - 1)];
}

export function failureFingerprint(snapshot) {
  const last = snapshot?.lastMessage || {};
  if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    return `${last.stopReason}:${normalizeError(last.errorMessage || "no-message")}`;
  }
  if (snapshot?.unresolvedToolCalls?.length) {
    const tools = [...new Set(snapshot.unresolvedToolCalls.map((call) => String(call.name || "unknown")))].sort();
    return `unresolved-tool:${tools.join(",")}`;
  }
  if (isRecoveryUser(last)) return "orphan:recovery-user";
  return `orphan:${String(last.role || "none")}:${String(last.stopReason || "none")}`;
}

export function noteFailure(record, fingerprint) {
  const same = record.sameFailureFingerprint === fingerprint;
  const sameFailureCount = same ? Number(record.sameFailureCount || 0) + 1 : 1;
  const totalRecoveries = Number(record.totalRecoveries || 0) + 1;
  const blocked = sameFailureCount >= SAME_FAILURE_LIMIT || totalRecoveries >= TOTAL_RECOVERY_LIMIT;
  return {
    ...record,
    status: blocked ? "blocked" : "recovering",
    sameFailureFingerprint: fingerprint,
    sameFailureCount,
    totalRecoveries,
    recoveryAttempt: totalRecoveries,
    blockReason: blocked ? (sameFailureCount >= SAME_FAILURE_LIMIT ? "same-failure-limit" : "total-recovery-limit") : "",
  };
}

export function decideRunAction({ snapshot, running }) {
  if (!snapshot) return { action: "wait", reason: "no-snapshot" };
  if (snapshot.cancelled) return { action: "cancel", reason: "explicit-user-cancel" };
  if (snapshot.blocked || snapshot.goalState?.status === "blocked") return { action: "block", reason: "goal-blocked" };
  if (running) return { action: "wait", reason: "runner-active" };
  const last = snapshot.lastMessage;
  if (!last) return { action: "wait", reason: "no-message" };
  if (last.role === "assistant") {
    if (last.stopReason === "error" || last.stopReason === "aborted") return { action: "recover", reason: `assistant-${last.stopReason}` };
    if (last.stopReason === "toolUse" || snapshot.unresolvedToolCalls?.length) return { action: "recover", reason: "tool-call-unsettled" };
    if (last.stopReason === "stop") {
      if (snapshot.goalState?.status === "active") return { action: "recover", reason: "active-goal-stopped" };
      return { action: "complete", reason: "terminal-assistant" };
    }
    return { action: "recover", reason: "assistant-without-terminal-reason" };
  }
  if (last.role === "user") return { action: "recover", reason: isRecoveryUser(last) ? "recovery-prompt-unanswered" : "user-prompt-unanswered" };
  if (last.role === "toolResult") return { action: "recover", reason: "tool-result-unanswered" };
  return { action: "recover", reason: `nonterminal-${last.role || "unknown"}` };
}

export function buildTransientRecoveryPrompt(record = {}) {
  return `${RECOVERY_PREFIX} run=${String(record.runId || "unknown")} attempt=${Number(record.recoveryAttempt || 1)} transient=1\n` +
    "Pi Web 在首个 assistant 消息落盘前异常退出；下面是宿主在转发前持久化的原始请求。\n" +
    "此阶段尚未产生或执行任何工具调用。继续完成请求，不要只解释故障。\n\n" +
    `原始请求：\n${String(record.rootPrompt || "").slice(0, 262144)}`;
}

export function buildRecoveryPrompt(snapshot, record = {}) {
  const unresolvedNames = [...new Set((snapshot?.unresolvedToolCalls || []).map((call) => String(call.name || "unknown")))];
  const safety = unresolvedNames.length
    ? `检测到未闭合工具调用（仅工具名：${unresolvedNames.join(", ")}）。先只读核对副作用是否已经发生；未经运行态确认，不得重放创建、修改、删除、提交、上传或远端调用。`
    : "从会话当前最后叶节点继续；已有 toolResult 视为已完成，不得重复执行对应工具。";
  return `${RECOVERY_PREFIX} run=${String(record.runId || "unknown")} attempt=${Number(record.recoveryAttempt || 1)} leaf=${String(snapshot?.leafId || "unknown")}\n` +
    "上一轮在未形成可交付终态时异常中断。继续完成原目标，不要重新解释中断原因。\n" +
    `${safety}\n` +
    "保留并逐项更新原【验收清单】；只有全部获得正向运行证据后才能结束。";
}

export class DurableRunStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.now = options.now || Date.now;
  }

  fresh() {
    const at = iso(this.now());
    return { version: 1, supervisorVersion: RUN_SUPERVISOR_VERSION, initializedAt: at, updatedAt: at, sessions: {}, pendingIntents: {} };
  }

  load() {
    if (!fs.existsSync(this.filePath)) return this.fresh();
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (value?.version !== 1 || !value.sessions || typeof value.sessions !== "object") throw new Error("unsupported state schema");
      if (!value.pendingIntents || typeof value.pendingIntents !== "object") value.pendingIntents = {};
      return value;
    } catch (error) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const backup = `${this.filePath}.corrupt-${this.now()}.bak`;
      try { fs.copyFileSync(this.filePath, backup, fs.constants.COPYFILE_EXCL); } catch {}
      const value = this.fresh();
      value.loadError = normalizeError(error?.message || error);
      return value;
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const value = { ...state, version: 1, supervisorVersion: RUN_SUPERVISOR_VERSION, updatedAt: iso(this.now()) };
    const temp = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    try { fs.renameSync(temp, this.filePath); }
    finally { try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch {} }
  }
}

function listSessionFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of entries) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile() && item.name.endsWith(".jsonl")) files.push(full);
    }
  }
  return files;
}

function sessionIdFromFile(file) {
  return path.basename(file).match(/_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/iu)?.[1] || "";
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(Math.max(1, ms));
}

export class RunSupervisor {
  constructor(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || process.env.PI_PORTABLE_DATA || path.join(process.cwd(), "data"));
    this.dataRoot = dataRoot;
    this.sessionRoot = path.resolve(options.sessionRoot || path.join(dataRoot, ".pi", "agent", "sessions"));
    // webPort is Pi Web's private upstream. publicWebPort is the user-facing transparent
    // proxy that durably journals prompt/abort intent before forwarding.
    this.webPort = Number(options.webPort || process.env.PI_WEB_PORT || 30140);
    this.publicWebPort = Number(options.publicWebPort || process.env.PI_RUN_SUPERVISOR_PUBLIC_PORT || 0);
    this.healthPort = Number(options.healthPort || process.env.PI_RUN_SUPERVISOR_PORT || (this.publicWebPort || this.webPort) + 1);
    this.pollMs = Number(options.pollMs || process.env.PI_RUN_SUPERVISOR_POLL_MS || DEFAULT_POLL_MS);
    this.graceMs = Number(options.graceMs || process.env.PI_RUN_SUPERVISOR_GRACE_MS || DEFAULT_GRACE_MS);
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.store = options.store || new DurableRunStore(path.join(dataRoot, "run-supervisor", "state.json"), { now: this.now });
    this.state = this.store.load();
    this.logFile = path.resolve(options.logFile || path.join(dataRoot, "run-supervisor.log"));
    this.indexes = new Map();
    this.filesBySession = new Map();
    this.knownFileStats = new Map();
    this.readErrors = new Map();
    this.runningIds = new Set();
    this.eventStreams = new Map();
    this.lastDiscoveryAt = 0;
    this.webReachable = false;
    this.lastTickAt = "";
    this.lastError = "";
    this.recoveryDispatches = 0;
    this.server = null;
    this.proxyServer = null;
    this.timer = null;
    this.ticking = false;
    this.closed = false;
  }

  log(event, detail = {}) {
    const row = { ts: iso(this.now()), version: RUN_SUPERVISOR_VERSION, event, ...detail };
    try { fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); fs.appendFileSync(this.logFile, JSON.stringify(row) + "\n"); } catch {}
    return row;
  }

  discover(force = false) {
    const now = this.now();
    if (!force && now - this.lastDiscoveryAt < 1000) return;
    this.lastDiscoveryAt = now;
    for (const file of listSessionFiles(this.sessionRoot)) {
      const id = sessionIdFromFile(file);
      if (!id) continue;
      this.filesBySession.set(id, file);
      try { this.knownFileStats.set(id, fs.statSync(file).mtimeMs); } catch {}
    }
  }

  indexFor(sessionId) {
    const file = this.filesBySession.get(sessionId);
    if (!file) return null;
    let index = this.indexes.get(sessionId);
    if (!index || index.filePath !== path.resolve(file)) {
      index = new SessionFileIndex(file);
      this.indexes.set(sessionId, index);
    }
    return index;
  }

  snapshotFor(sessionId) {
    try {
      const snapshot = this.indexFor(sessionId)?.refresh() || null;
      this.readErrors.delete(sessionId);
      return snapshot;
    } catch (error) {
      // 读失败通常是持续性的（会话文件被删/被移走），tick 每 500ms 跑一次，
      // 逐轮记录会把日志刷成几百 KB。同一 session 的同一错误只记一次，错误变了或恢复后再记。
      const fingerprint = normalizeError(error?.message || error);
      if (this.readErrors.get(sessionId) !== fingerprint) {
        this.readErrors.set(sessionId, fingerprint);
        this.log("session-read-error", { sessionId, error: fingerprint });
      }
      return null;
    }
  }

  newRecord(snapshot, reason) {
    const now = this.now();
    return {
      runId: crypto.randomUUID(),
      sessionId: snapshot.sessionId,
      rootUserEntryId: snapshot.rootUserEntryId,
      rootUserAt: snapshot.rootUserAt,
      sessionFile: snapshot.filePath,
      status: "running",
      startedAt: iso(now),
      lastSeenAt: iso(now),
      lastLeafId: snapshot.leafId,
      lastProgressLeafId: snapshot.lastMessage?.role === "assistant" || snapshot.lastMessage?.role === "toolResult" ? snapshot.leafId : "",
      notRunningSince: 0,
      lastRecoveryKey: "",
      lastRecoveryAt: "",
      sameFailureFingerprint: "",
      sameFailureCount: 0,
      totalRecoveries: 0,
      recoveryAttempt: 0,
      blockReason: "",
      reason,
    };
  }

  save() { this.store.save(this.state); }

  persistIntentBody(runId, body) {
    const dir = path.join(this.dataRoot, "run-supervisor", "intents");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${runId}.json`);
    const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(body) + "\n", { flag: "wx" });
    fs.renameSync(temp, target);
    return target;
  }

  loadIntentBody(record) {
    if (!record?.intentFile || !fs.existsSync(record.intentFile)) return null;
    try { return JSON.parse(fs.readFileSync(record.intentFile, "utf8")); } catch { return null; }
  }

  intentRecord(sessionId, body, reason) {
    const now = this.now();
    const existing = this.state.sessions[sessionId];
    const runId = String(body?.__runId || crypto.randomUUID());
    const intentFile = String(body?.__intentFile || this.persistIntentBody(runId, body));
    return {
      runId,
      sessionId,
      rootUserEntryId: "",
      rootUserAt: iso(now),
      rootPrompt: promptText(body?.message).slice(0, 262144),
      intentFile,
      imageCount: Array.isArray(body?.images) ? body.images.length : 0,
      cwd: typeof body?.cwd === "string" ? body.cwd : existing?.cwd || "",
      status: "forwarding",
      startedAt: iso(now),
      lastSeenAt: iso(now),
      lastLeafId: "",
      lastProgressLeafId: "",
      notRunningSince: 0,
      lastRecoveryKey: "",
      lastRecoveryAt: "",
      sameFailureFingerprint: "",
      sameFailureCount: 0,
      totalRecoveries: 0,
      recoveryAttempt: 0,
      blockReason: "",
      reason,
      capturedBeforeForward: true,
    };
  }

  captureKnownPromptIntent(sessionId, body) {
    const record = this.intentRecord(sessionId, body, "proxy-prompt");
    this.state.sessions[sessionId] = record;
    this.save();
    this.log("prompt-intent-captured", { sessionId, runId: record.runId, hasCwd: Boolean(record.cwd), chars: record.rootPrompt.length });
    return record;
  }

  capturePendingNewIntent(body) {
    const intentId = crypto.randomUUID();
    const now = this.now();
    const runId = crypto.randomUUID();
    const intentFile = this.persistIntentBody(runId, body);
    this.state.pendingIntents[intentId] = {
      intentId,
      runId,
      intentFile,
      imageCount: Array.isArray(body?.images) ? body.images.length : 0,
      cwd: String(body?.cwd || ""),
      rootPrompt: promptText(body?.message).slice(0, 262144),
      status: "forwarding",
      capturedAt: iso(now),
      recoverAfter: now + 5000,
      recoveryAttempt: 0,
      sameFailureCount: 0,
    };
    this.save();
    this.log("new-prompt-intent-captured", { intentId, hasCwd: Boolean(body?.cwd), chars: this.state.pendingIntents[intentId].rootPrompt.length });
    return intentId;
  }

  finalizePendingNewIntent(intentId, sessionId, accepted) {
    const intent = this.state.pendingIntents[intentId];
    if (!intent) return;
    if (!accepted || !sessionId) {
      intent.status = "rejected";
      intent.rejectedAt = iso(this.now());
      this.save();
      return;
    }
    const record = this.intentRecord(String(sessionId), {
      cwd: intent.cwd, message: intent.rootPrompt,
      __runId: intent.runId, __intentFile: intent.intentFile,
    }, "proxy-new-prompt");
    record.imageCount = Number(intent.imageCount || 0);
    record.status = "running";
    record.forwardAcceptedAt = iso(this.now());
    this.state.sessions[sessionId] = record;
    delete this.state.pendingIntents[intentId];
    this.save();
    this.log("new-prompt-intent-bound", { intentId, sessionId, runId: record.runId });
  }

  cancelKnownRun(sessionId, reason = "proxy-abort") {
    const record = this.state.sessions[sessionId] || {
      runId: crypto.randomUUID(), sessionId, startedAt: iso(this.now()), rootUserEntryId: "", rootPrompt: "",
    };
    Object.assign(record, {
      status: "cancelled", explicitUserAbort: true, cancelledAt: iso(this.now()), cancelReason: reason,
    });
    this.state.sessions[sessionId] = record;
    this.save();
    this.log("run-cancelled", { sessionId, runId: record.runId, reason });
  }

  async readRequestBody(request, limit = 64 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error("request body exceeds supervisor interception limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  proxyHeaders(headers, extra = {}) {
    // 必须透传客户端原始 Host。pi-web 的 CSRF 防护要求 Origin 与 Host 同源
    // (lib/request-security.ts: isApiRequestOriginAllowed)，把 Host 改写成上游端口后，
    // 浏览器发来的 Origin(:publicWebPort) 与 Host(:webPort) 不再相等，所有写类 API 一律 403
    // ——用户侧表现就是「回车后输入被吞、任务不执行」。Host 仍是 IP 字面量，上游的 Host 白名单照过。
    const result = { ...headers, ...extra };
    if (!result.host) result.host = `127.0.0.1:${this.webPort}`;
    delete result.connection;
    return result;
  }

  streamProxy(request, response) {
    const upstream = http.request({
      hostname: "127.0.0.1", port: this.webPort, method: request.method, path: request.url,
      headers: this.proxyHeaders(request.headers),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      if (!response.destroyed) response.end(JSON.stringify({ error: String(error?.message || error) }));
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  }

  async bufferedProxy(request, response, rawBody, onResult) {
    const headers = this.proxyHeaders(request.headers, {
      "accept-encoding": "identity",
      "content-length": String(rawBody.length),
    });
    const upstreamResult = await new Promise((resolve, reject) => {
      const upstream = http.request({
        hostname: "127.0.0.1", port: this.webPort, method: request.method, path: request.url, headers,
      }, (upstreamResponse) => {
        const chunks = [];
        upstreamResponse.on("data", (chunk) => chunks.push(chunk));
        upstreamResponse.on("end", () => resolve({
          status: upstreamResponse.statusCode || 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks),
        }));
      });
      upstream.on("error", reject);
      upstream.end(rawBody);
    });
    let parsed = null;
    try { parsed = JSON.parse(upstreamResult.body.toString("utf8")); } catch {}
    await onResult?.(upstreamResult.status, parsed);
    const outputHeaders = { ...upstreamResult.headers, "content-length": String(upstreamResult.body.length) };
    delete outputHeaders["content-encoding"];
    delete outputHeaders["transfer-encoding"];
    response.writeHead(upstreamResult.status, outputHeaders);
    response.end(upstreamResult.body);
  }

  async handlePublicProxy(request, response) {
    const match = /^\/api\/agent\/([^/?]+)$/u.exec(request.url || "");
    const isNewPost = request.method === "POST" && (request.url || "").split("?")[0] === "/api/agent/new";
    const isAgentPost = request.method === "POST" && Boolean(match) && !isNewPost;
    if (!isAgentPost && !isNewPost) { this.streamProxy(request, response); return; }
    let rawBody;
    let body;
    try {
      rawBody = await this.readRequestBody(request);
      body = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error?.message || error) }));
      return;
    }
    if (isAgentPost) {
      const sessionId = decodeURIComponent(match[1]);
      if (body?.type === "prompt" && !String(body?.message || "").startsWith(RECOVERY_PREFIX)) this.captureKnownPromptIntent(sessionId, body);
      if (body?.type === "abort") this.cancelKnownRun(sessionId, "public-api-abort");
      await this.bufferedProxy(request, response, rawBody, async (status, result) => {
        if (body?.type === "prompt" && (status >= 400 || result?.error || result?.accepted === false)) {
          const record = this.state.sessions[sessionId];
          if (record?.reason === "proxy-prompt") {
            record.status = "rejected";
            record.rejectedAt = iso(this.now());
            record.rejectError = normalizeError(result?.error || `HTTP ${status}`);
            this.save();
          }
        }
      });
      return;
    }
    if (body?.type !== "prompt") { await this.bufferedProxy(request, response, rawBody); return; }
    const intentId = this.capturePendingNewIntent(body);
    try {
      await this.bufferedProxy(request, response, rawBody, async (status, result) => {
        this.finalizePendingNewIntent(intentId, result?.sessionId, status < 400 && !result?.error && result?.accepted !== false);
      });
    } catch (error) {
      this.log("new-prompt-forward-error", { intentId, error: normalizeError(error?.message || error) });
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      if (!response.destroyed) response.end(JSON.stringify({ error: "Pi Web upstream unavailable after durable prompt capture", intentId }));
    }
  }

  async fetchRunning() {
    const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/running`, {
      cache: "no-store", signal: timeoutSignal(5000),
    });
    if (!response.ok) throw new Error(`running HTTP ${response.status}`);
    const body = await response.json();
    return new Set(Array.isArray(body?.runningSessionIds) ? body.runningSessionIds.map(String) : []);
  }

  async fetchRuntimeSessionInfos(sessionIds) {
    if (!sessionIds.size) return new Map();
    const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/sessions?force=1`, {
      cache: "no-store", signal: timeoutSignal(10000),
    });
    if (!response.ok) throw new Error(`sessions HTTP ${response.status}`);
    const body = await response.json();
    const result = new Map();
    for (const info of Array.isArray(body?.sessions) ? body.sessions : []) {
      const id = String(info?.id || "");
      if (sessionIds.has(id)) result.set(id, info);
    }
    return result;
  }

  ensureEventStream(sessionId) {
    if (this.eventStreams.has(sessionId) || this.closed) return;
    const controller = new AbortController();
    this.eventStreams.set(sessionId, controller);
    void this.consumeEventStream(sessionId, controller).finally(() => {
      if (this.eventStreams.get(sessionId) === controller) this.eventStreams.delete(sessionId);
    });
  }

  stopEventStream(sessionId) {
    const controller = this.eventStreams.get(sessionId);
    if (controller) controller.abort();
    this.eventStreams.delete(sessionId);
  }

  async consumeEventStream(sessionId, controller) {
    try {
      const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/${encodeURIComponent(sessionId)}/events`, {
        headers: { accept: "text/event-stream" }, cache: "no-store", signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`events HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split).replace(/\r/g, "");
          buffer = buffer.slice(split + 2);
          const payload = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!payload) continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          if (event?.type === "prompt_error") {
            const record = this.state.sessions[sessionId];
            if (record) {
              record.lastPromptError = String(event.errorMessage || "Command failed").slice(0, 1000);
              record.lastPromptErrorAt = iso(this.now());
              this.save();
            }
            this.log("prompt-error", { sessionId, error: normalizeError(event.errorMessage) });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.log("event-stream-error", { sessionId, error: normalizeError(error?.message || error) });
    }
  }

  async dispatchRecovery(sessionId, snapshot, record, reason) {
    const recoveryKey = `${record.runId}:${snapshot.leafId}`;
    if (record.lastRecoveryKey === recoveryKey) return false;
    const fingerprint = failureFingerprint(snapshot);
    const next = noteFailure(record, fingerprint);
    Object.assign(record, next, {
      lastRecoveryKey: recoveryKey,
      lastRecoveryLeafId: snapshot.leafId,
      lastRecoveryAt: iso(this.now()),
      lastRecoveryReason: reason,
      status: next.status,
    });
    if (record.status === "blocked") {
      this.save();
      this.log("run-blocked", { sessionId, runId: record.runId, reason: record.blockReason, fingerprint, count: record.sameFailureCount });
      return false;
    }
    // Persist the single-flight key before any network dispatch.
    record.status = "dispatching";
    this.save();
    const body = {
      type: "prompt",
      message: buildRecoveryPrompt(snapshot, record),
      streamingBehavior: "followUp",
    };
    try {
      const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: timeoutSignal(5000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.error) throw new Error(result?.error || `prompt HTTP ${response.status}`);
      record.status = "recovering";
      record.dispatchAcceptedAt = iso(this.now());
      this.recoveryDispatches += 1;
      this.save();
      this.log("recovery-dispatched", { sessionId, runId: record.runId, leafId: snapshot.leafId, attempt: record.recoveryAttempt, reason });
      return true;
    } catch (error) {
      // The request may have been accepted before a transport loss; keep the single-flight key.
      record.status = "recovering";
      record.dispatchError = normalizeError(error?.message || error);
      record.dispatchErrorAt = iso(this.now());
      this.save();
      this.log("recovery-dispatch-uncertain", { sessionId, runId: record.runId, leafId: snapshot.leafId, error: record.dispatchError });
      return false;
    }
  }

  async dispatchTransientRecovery(sessionId, record, reason, pendingIntentId = "") {
    const recoveryKey = `${record.runId}:transient:${sessionId || pendingIntentId || "unknown"}`;
    if (record.lastRecoveryKey === recoveryKey) return false;
    const next = noteFailure(record, "transient:no-session-file");
    Object.assign(record, next, {
      lastRecoveryKey: recoveryKey,
      lastRecoveryAt: iso(this.now()),
      lastRecoveryReason: reason,
    });
    if (record.status === "blocked") {
      this.save();
      this.log("run-blocked", { sessionId, runId: record.runId, reason: record.blockReason, fingerprint: "transient:no-session-file" });
      return false;
    }
    record.status = "dispatching";
    this.save();
    const message = buildTransientRecoveryPrompt(record);
    try {
      let alive = false;
      if (sessionId) {
        const stateResponse = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/${encodeURIComponent(sessionId)}`, {
          cache: "no-store", signal: timeoutSignal(3000),
        });
        const state = await stateResponse.json().catch(() => ({}));
        alive = stateResponse.ok && state?.running === true;
      }
      if (alive) {
        const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/${encodeURIComponent(sessionId)}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "prompt", message, streamingBehavior: "followUp" }), signal: timeoutSignal(5000),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result?.error) throw new Error(result?.error || `prompt HTTP ${response.status}`);
        record.status = "recovering";
        record.dispatchAcceptedAt = iso(this.now());
        this.recoveryDispatches += 1;
        this.save();
        this.log("transient-recovery-dispatched", { sessionId, runId: record.runId, attempt: record.recoveryAttempt, mode: "same-runtime" });
        return true;
      }
      if (!record.cwd) throw new Error("transient recovery is missing cwd");
      const originalIntent = this.loadIntentBody(record);
      const replacementBody = { cwd: record.cwd, type: "prompt", message };
      if (Array.isArray(originalIntent?.images) && originalIntent.images.length) replacementBody.images = originalIntent.images;
      const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/new`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(replacementBody), signal: timeoutSignal(10000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.error || !result?.sessionId) throw new Error(result?.error || `new prompt HTTP ${response.status}`);
      const replacementId = String(result.sessionId);
      const replacement = {
        ...record,
        sessionId: replacementId,
        priorSessionId: sessionId || "",
        status: "recovering",
        dispatchAcceptedAt: iso(this.now()),
        notRunningSince: 0,
        reason: "transient-replacement",
      };
      if (sessionId && this.state.sessions[sessionId]) {
        this.state.sessions[sessionId] = { ...record, status: "replaced", replacementSessionId: replacementId, replacedAt: iso(this.now()) };
      }
      if (pendingIntentId) delete this.state.pendingIntents[pendingIntentId];
      this.state.sessions[replacementId] = replacement;
      this.recoveryDispatches += 1;
      this.save();
      this.log("transient-recovery-dispatched", { sessionId: replacementId, priorSessionId: sessionId || "", runId: record.runId, attempt: record.recoveryAttempt, mode: "replacement" });
      return true;
    } catch (error) {
      record.status = "recovering";
      record.dispatchError = normalizeError(error?.message || error);
      record.dispatchErrorAt = iso(this.now());
      this.save();
      this.log("transient-recovery-dispatch-uncertain", { sessionId, runId: record.runId, error: record.dispatchError });
      return false;
    }
  }

  async processTransientRecord(sessionId, record, running) {
    if (!record || ["complete", "cancelled", "blocked", "rejected", "replaced"].includes(record.status)) return;
    record.lastSeenAt = iso(this.now());
    if (running) {
      record.status = "running";
      record.notRunningSince = 0;
      this.ensureEventStream(sessionId);
      this.save();
      return;
    }
    this.stopEventStream(sessionId);
    if (!record.notRunningSince) { record.notRunningSince = this.now(); this.save(); return; }
    const nextAttempt = Number(record.totalRecoveries || 0) + 1;
    if (this.now() - record.notRunningSince < Math.max(this.graceMs, recoveryDelayMs(nextAttempt))) return;
    await this.dispatchTransientRecovery(sessionId, record, "transient-runner-missing");
  }

  async processPendingIntents() {
    for (const [intentId, intent] of Object.entries(this.state.pendingIntents || {})) {
      if (intent.status !== "forwarding" || this.now() < Number(intent.recoverAfter || 0)) continue;
      await this.dispatchTransientRecovery("", intent, "new-prompt-forward-interrupted", intentId);
    }
  }

  async processSession(sessionId, running) {
    const snapshot = this.snapshotFor(sessionId);
    let record = this.state.sessions[sessionId];
    if (!snapshot?.sessionId) {
      await this.processTransientRecord(sessionId, record, running);
      return;
    }
    if (!snapshot.rootUserEntryId && !record) return;
    const initializedAt = Date.parse(this.state.initializedAt || "") || this.now();
    const rootAt = Date.parse(snapshot.rootUserAt || "") || 0;
    if (record && !record.rootUserEntryId && snapshot.rootUserEntryId) {
      record.rootUserEntryId = snapshot.rootUserEntryId;
      record.rootUserAt = snapshot.rootUserAt;
      record.sessionFile = snapshot.filePath;
      record.intentBoundAt = iso(this.now());
      this.save();
    }
    const isNewUserRun = !record || (snapshot.rootUserEntryId && snapshot.rootUserEntryId !== record.rootUserEntryId);
    if (isNewUserRun) {
      // First installation baselines old idle sessions; currently running or post-install prompts become tracked.
      if (!running && rootAt < initializedAt && !record) return;
      record = this.newRecord(snapshot, running ? "observed-running" : "new-user-prompt");
      this.state.sessions[sessionId] = record;
      this.save();
      this.log("run-tracked", { sessionId, runId: record.runId, rootUserEntryId: record.rootUserEntryId, reason: record.reason });
    }

    record.lastSeenAt = iso(this.now());
    record.lastLeafId = snapshot.leafId;
    record.sessionFile = snapshot.filePath;
    if (snapshot.parseErrors) {
      record.status = "blocked";
      record.blockReason = "session-parse-error";
      this.save();
      this.log("run-blocked", { sessionId, runId: record.runId, reason: record.blockReason, parseErrors: snapshot.parseErrors });
      return;
    }
    if (running) {
      if (snapshot.cancelled) {
        record.status = "cancelled";
        record.cancelledAt = iso(this.now());
        this.stopEventStream(sessionId);
      } else if (record.status !== "blocked") {
        record.status = "running";
        record.notRunningSince = 0;
        const last = snapshot.lastMessage;
        if (snapshot.leafId !== record.lastProgressLeafId && (last?.role === "toolResult" || (last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted"))) {
          record.lastProgressLeafId = snapshot.leafId;
          record.lastProgressAt = iso(this.now());
          record.sameFailureFingerprint = "";
          record.sameFailureCount = 0;
        }
        this.ensureEventStream(sessionId);
      }
      this.save();
      return;
    }

    this.stopEventStream(sessionId);
    const decision = decideRunAction({ snapshot, running: false });
    // 终态会话每轮都会重新判定成同一个结果；只在状态真正迁移时落盘并记日志，
    // 否则 tick 会按 500ms 的节奏重复写 state.json 和同一条日志。
    if (decision.action === "complete") {
      if (record.status === "complete") return;
      record.status = "complete";
      record.completedAt = iso(this.now());
      record.notRunningSince = 0;
      this.save();
      this.log("run-complete", { sessionId, runId: record.runId, reason: decision.reason });
      return;
    }
    if (decision.action === "cancel") {
      if (record.status === "cancelled") return;
      record.status = "cancelled";
      record.cancelledAt = iso(this.now());
      record.notRunningSince = 0;
      this.save();
      this.log("run-cancelled", { sessionId, runId: record.runId });
      return;
    }
    if (decision.action === "block") {
      record.status = "blocked";
      record.blockReason ||= decision.reason;
      this.save();
      return;
    }
    if (decision.action !== "recover" || record.status === "blocked" || record.status === "cancelled") return;
    if (!record.notRunningSince) { record.notRunningSince = this.now(); this.save(); return; }
    if (this.now() - record.notRunningSince < this.graceMs) return;
    const nextAttempt = Number(record.totalRecoveries || 0) + 1;
    if (this.now() - record.notRunningSince < recoveryDelayMs(nextAttempt)) return;
    await this.dispatchRecovery(sessionId, snapshot, record, decision.reason);
  }

  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    this.lastTickAt = iso(this.now());
    try {
      this.runningIds = await this.fetchRunning();
      this.webReachable = true;
      this.lastError = "";
      this.discover();
      const missingRuntimeMetadata = new Set([...this.runningIds].filter((id) =>
        !this.filesBySession.has(id) && (!this.state.sessions[id]?.cwd || !this.state.sessions[id]?.rootPrompt),
      ));
      if (missingRuntimeMetadata.size) {
        const infos = await this.fetchRuntimeSessionInfos(missingRuntimeMetadata);
        for (const [sessionId, info] of infos) {
          let record = this.state.sessions[sessionId];
          if (!record) {
            record = this.intentRecord(sessionId, { cwd: info.cwd, message: info.firstMessage }, "observed-transient-running");
            record.status = "running";
            this.state.sessions[sessionId] = record;
            this.log("transient-run-tracked", { sessionId, runId: record.runId, chars: record.rootPrompt.length });
          } else {
            record.cwd ||= String(info.cwd || "");
            record.rootPrompt ||= String(info.firstMessage || "");
          }
          this.save();
        }
      }
      await this.processPendingIntents();
      const candidates = new Set([...this.runningIds, ...Object.keys(this.state.sessions)]);
      const initializedAt = Date.parse(this.state.initializedAt || "") || this.now();
      for (const [id, mtime] of this.knownFileStats) if (mtime >= initializedAt) candidates.add(id);
      for (const sessionId of candidates) await this.processSession(sessionId, this.runningIds.has(sessionId));
    } catch (error) {
      this.webReachable = false;
      this.lastError = normalizeError(error?.message || error);
      this.log("tick-error", { error: this.lastError });
    } finally { this.ticking = false; }
  }

  health() {
    const records = Object.values(this.state.sessions);
    const counts = records.reduce((value, record) => {
      const key = String(record.status || "unknown");
      value[key] = (value[key] || 0) + 1;
      return value;
    }, {});
    return {
      ok: true,
      version: RUN_SUPERVISOR_VERSION,
      webPort: this.webPort,
      publicWebPort: this.publicWebPort || null,
      healthPort: this.healthPort,
      webReachable: this.webReachable,
      pollMs: this.pollMs,
      graceMs: this.graceMs,
      runningSessionIds: [...this.runningIds],
      counts,
      pendingIntents: Object.keys(this.state.pendingIntents || {}).length,
      recoveryDispatches: this.recoveryDispatches,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      stateFile: this.store.filePath,
    };
  }

  async start() {
    this.discover(true);
    if (this.publicWebPort) {
      this.proxyServer = http.createServer((request, response) => {
        void this.handlePublicProxy(request, response).catch((error) => {
          this.log("public-proxy-error", { path: request.url || "", error: normalizeError(error?.message || error) });
          if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
          if (!response.destroyed) response.end(JSON.stringify({ error: "Pi Web supervisor proxy failure" }));
        });
      });
      await new Promise((resolve, reject) => {
        this.proxyServer.once("error", reject);
        this.proxyServer.listen(this.publicWebPort, "127.0.0.1", resolve);
      });
    }
    this.server = http.createServer((request, response) => {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/")) {
        const body = Buffer.from(JSON.stringify(this.health()));
        response.writeHead(200, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
        response.end(body);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.healthPort, "127.0.0.1", resolve);
    });
    this.log("supervisor-start", { dataRoot: this.dataRoot, sessionRoot: this.sessionRoot, webPort: this.webPort, publicWebPort: this.publicWebPort || null, healthPort: this.healthPort });
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.eventStreams.values()) controller.abort();
    this.eventStreams.clear();
    if (this.proxyServer) {
      this.proxyServer.closeAllConnections?.();
      await new Promise((resolve) => this.proxyServer.close(() => resolve()));
    }
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.log("supervisor-stop");
  }
}

export async function runSupervisorMain() {
  const supervisor = new RunSupervisor();
  const stop = async () => { await supervisor.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await supervisor.start();
    // Keep the process alive even when the poll timer is unref'd.
    while (!supervisor.closed) await sleep(1 << 30);
  } catch (error) {
    if (error?.code === "EADDRINUSE") process.exit(0);
    supervisor.log("supervisor-fatal", { error: normalizeError(error?.stack || error) });
    throw error;
  }
}

// 运行面用 junction 布局时(portable\src → 仓库 src),argv[1] 是链接路径而 import.meta.url
// 已被 ESM loader 解析成真实路径,按字面比较必然不等 → 进程静默 exit 0、stderr 全空,
// launcher 只看到"监督器未就绪"就杀整棵树。判定必须两侧都过 realpath。
export function isDirectRun(argvPath, moduleUrl) {
  if (!argvPath) return false;
  const real = (target) => {
    try { return fs.realpathSync(target); } catch { return path.resolve(target); }
  };
  return real(argvPath).toLowerCase() === real(fileURLToPath(moduleUrl)).toLowerCase();
}

const isMain = isDirectRun(process.argv[1], import.meta.url);
if (isMain) runSupervisorMain().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
