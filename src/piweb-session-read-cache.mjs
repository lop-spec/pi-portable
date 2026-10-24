// 会话详情读取分流 + 指纹缓存（piweb-ui-proxy 使用）。
// GET /api/sessions/<id> 与 /context 对空闲会话改由只读读取进程（piweb-session-reader.cjs）计算，
// 结果按会话文件指纹（size:mtimeMs:ctimeMs）缓存在内存并落盘；文件一变即失效。运行中的会话、
// 未知会话、读取进程异常或非 2xx 一律回退 pi-web 原链路，保证结果正确优先于命中率。
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SESSION_READ_CACHE_VERSION = "piweb-session-read-v2";
const READER_SCRIPT = fileURLToPath(new URL("./piweb-session-reader.cjs", import.meta.url));
const DETAIL_RE = /^\/api\/sessions\/([^/]+)$/u;
const CONTEXT_RE = /^\/api\/sessions\/([^/]+)\/context$/u;
// What the page sends when it opens a conversation (force is dropped from cache keys, see normalizeSearch).
export const DEFAULT_DETAIL_SEARCH = "?deferThinking=1&deferMedia=1&tree=summary&view=chat&tail=50&force=1";

const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const normalizeError = (value) => String(value || "unknown").replace(/\s+/gu, " ").slice(0, 500);

export function matchSessionRead(method, pathname) {
  if (method !== "GET") return null;
  let match = DETAIL_RE.exec(pathname);
  if (match) return { route: "detail", encodedId: match[1] };
  match = CONTEXT_RE.exec(pathname);
  if (match) return { route: "context", encodedId: match[1] };
  return null;
}

// `force=1` asks pi-web to re-check the disk; a fingerprint-validated entry is the disk state, so it is not part of the key.
export function normalizeSearch(searchParams) {
  const entries = [...searchParams.entries()].filter(([name]) => name !== "force");
  entries.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  return new URLSearchParams(entries).toString();
}

export async function fileFingerprint(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? { fp: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, bytes: stat.size } : null;
  } catch { return null; }
}

// One child process; requests are answered strictly in order. Spawned on first use, recycled when idle and large.
export class SessionReader {
  constructor({ name, packageRoot, env, log, script = READER_SCRIPT, requestTimeoutMs = 90_000, idleRecycleMs = 60_000, recycleRssBytes = 300 * 1024 * 1024, exitWhenIdleMs = 0 }) {
    Object.assign(this, { name, packageRoot, env, log, script, requestTimeoutMs, idleRecycleMs, recycleRssBytes, exitWhenIdleMs });
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.lastRss = 0;
    this.idleTimer = null;
    this.failures = 0;
    this.disabledUntil = 0;
    this.closed = false;
  }

  get busy() { return this.pending.size > 0; }

  start() {
    if (this.ready) return this.ready;
    if (this.closed) return Promise.reject(new Error("reader closed"));
    if (Date.now() < this.disabledUntil) return Promise.reject(new Error("reader temporarily disabled after failures"));
    const startedAt = Date.now();
    const child = fork(this.script, [], {
      env: { ...this.env, PIWEB_SESSION_READER_PACKAGE: this.packageRoot },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type === "ready") {
          this.failures = 0;
          this.log("session-reader-ready", { reader: this.name, pid: child.pid, elapsedMs: Date.now() - startedAt });
          resolve(child);
        } else if (message?.type === "fatal") {
          reject(new Error(message.error));
        } else if (message?.type === "result") {
          this.settle(message);
        }
      };
      child.on("message", onMessage);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(new Error(`reader exited before ready code=${code} signal=${signal} ${normalizeError(stderr)}`));
        this.onExit(child, code, signal, stderr);
      });
    });
    this.ready.catch((error) => {
      this.failures += 1;
      if (this.failures >= 3) this.disabledUntil = Date.now() + 5 * 60_000;
      this.log("session-reader-start-failed", { reader: this.name, failures: this.failures, reason: normalizeError(error?.message || error) });
      this.discard(child);
    });
    return this.ready;
  }

  onExit(child, code, signal, stderr) {
    if (this.child !== child) return;
    const error = new Error(`reader exited code=${code} signal=${signal}`);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    if (code !== 0 && !this.closed && !this.recycling) this.log("session-reader-exit", { reader: this.name, code, signal, stderr: normalizeError(stderr) });
    this.child = null;
    this.ready = null;
    this.recycling = false;
  }

  discard(child) {
    if (this.child === child) { this.child = null; this.ready = null; }
    try { child.kill(); } catch {}
  }

  settle(message) {
    const entry = this.pending.get(message.seq);
    if (!entry) return;
    this.pending.delete(message.seq);
    clearTimeout(entry.timer);
    this.lastRss = Number(message.rss) || 0;
    if (message.error) entry.reject(Object.assign(new Error(message.error), { blocked: message.blocked || [] }));
    else entry.resolve({ ...message, body: Buffer.isBuffer(message.body) ? message.body : Buffer.from(message.body || []) });
    this.scheduleIdle();
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.busy || !this.child) return;
    const exitIdle = this.exitWhenIdleMs > 0;
    const delay = exitIdle ? this.exitWhenIdleMs : this.idleRecycleMs;
    this.idleTimer = setTimeout(() => {
      if (this.busy || !this.child) return;
      // The upstream route keeps an LRU of parsed sessions; recycling returns that memory to the OS.
      if (exitIdle || this.lastRss > this.recycleRssBytes) {
        this.log("session-reader-recycle", { reader: this.name, rssMb: Math.round(this.lastRss / 1048576), reason: exitIdle ? "idle-exit" : "idle-rss" });
        this.recycling = true;
        const child = this.child;
        this.child = null;
        this.ready = null;
        try { child.kill(); } catch {}
        if (!exitIdle && !this.closed) this.start().catch(() => {});
      }
    }, delay);
    this.idleTimer.unref?.();
  }

  async read(route, id, search) {
    clearTimeout(this.idleTimer);
    const child = await this.start();
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        this.log("session-reader-timeout", { reader: this.name, route, id, timeoutMs: this.requestTimeoutMs });
        this.discard(child);
        reject(new Error("reader timeout"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(seq, { resolve, reject, timer });
      try { child.send({ type: "read", seq, route, id, search }); }
      catch (error) { clearTimeout(timer); this.pending.delete(seq); reject(error); }
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.child) { try { this.child.kill(); } catch {} }
    this.child = null;
    this.ready = null;
  }
}

// Response bytes keyed by route+id+query, valid while the session file fingerprint is unchanged.
export class SessionReadCache {
  constructor({ dir, log, memoryBytes = 96 * 1024 * 1024, diskBytes = 512 * 1024 * 1024 }) {
    Object.assign(this, { dir, log, memoryBytes, diskBytes });
    this.memory = new Map();
    this.memoryUsed = 0;
    this.diskChecked = false;
    this.pruning = null;
  }

  static key(route, id, search) { return `${route}\n${id}\n${search}`; }

  fileFor(key) { return path.join(this.dir, `${sha1(key)}.bin`); }

  remember(key, entry) {
    const previous = this.memory.get(key);
    if (previous) { this.memory.delete(key); this.memoryUsed -= previous.body.length; }
    this.memory.set(key, entry);
    this.memoryUsed += entry.body.length;
    for (const [oldKey, old] of this.memory) {
      if (this.memoryUsed <= this.memoryBytes || this.memory.size <= 1) break;
      this.memory.delete(oldKey);
      this.memoryUsed -= old.body.length;
    }
  }

  async get(key, fp) {
    const hot = this.memory.get(key);
    if (hot) {
      if (hot.fp === fp) { this.memory.delete(key); this.memory.set(key, hot); return { entry: hot, source: "memory" }; }
      this.memory.delete(key);
      this.memoryUsed -= hot.body.length;
    }
    let raw;
    try { raw = await fs.promises.readFile(this.fileFor(key)); } catch { return null; }
    const newline = raw.indexOf(10);
    if (newline < 0) return null;
    let meta;
    try { meta = JSON.parse(raw.subarray(0, newline).toString("utf8")); } catch { return null; }
    if (meta?.version !== SESSION_READ_CACHE_VERSION || meta.key !== key || meta.fp !== fp) return null;
    const body = raw.subarray(newline + 1);
    if (body.length !== meta.bytes) return null;
    const entry = { fp, status: meta.status, headers: meta.headers, body, encoded: new Map() };
    this.remember(key, entry);
    // Touch so pruning keeps recently used entries.
    const now = new Date();
    fs.promises.utimes(this.fileFor(key), now, now).catch(() => {});
    return { entry, source: "disk" };
  }

  async has(key, fp) {
    if (this.memory.get(key)?.fp === fp) return true;
    try {
      const handle = await fs.promises.open(this.fileFor(key), "r");
      try {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const newline = head.subarray(0, bytesRead).indexOf(10);
        if (newline < 0) return false;
        const meta = JSON.parse(head.subarray(0, newline).toString("utf8"));
        return meta?.version === SESSION_READ_CACHE_VERSION && meta.key === key && meta.fp === fp;
      } finally { await handle.close(); }
    } catch { return false; }
  }

  async put(key, fp, status, headers, body) {
    const entry = { fp, status, headers, body, encoded: new Map() };
    this.remember(key, entry);
    const meta = Buffer.from(`${JSON.stringify({ version: SESSION_READ_CACHE_VERSION, key, fp, status, headers, bytes: body.length })}\n`);
    const target = this.fileFor(key);
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(temporary, Buffer.concat([meta, body]), { flag: "wx" });
      await fs.promises.rename(temporary, target);
    } catch (error) {
      this.log("session-read-cache-write-failed", { reason: normalizeError(error?.message || error) });
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
    this.schedulePrune();
    return entry;
  }

  schedulePrune() {
    if (this.pruning) return;
    this.pruning = (async () => {
      try {
        const names = (await fs.promises.readdir(this.dir)).filter((name) => name.endsWith(".bin"));
        const files = [];
        let total = 0;
        for (const name of names) {
          try {
            const stat = await fs.promises.stat(path.join(this.dir, name));
            files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
            total += stat.size;
          } catch {}
        }
        if (total <= this.diskBytes) return;
        files.sort((a, b) => a.mtimeMs - b.mtimeMs);
        let removed = 0;
        for (const file of files) {
          if (total <= this.diskBytes * 0.8) break;
          await fs.promises.rm(path.join(this.dir, file.name), { force: true }).catch(() => {});
          total -= file.size;
          removed += 1;
        }
        this.log("session-read-cache-pruned", { removed, remainingMb: Math.round(total / 1048576) });
      } catch (error) {
        if (error?.code !== "ENOENT") this.log("session-read-cache-prune-failed", { reason: normalizeError(error?.message || error) });
      } finally {
        setTimeout(() => { this.pruning = null; }, 60_000).unref?.();
      }
    })();
  }
}

// Ties reader + cache to the proxy: resolves the session file, validates the fingerprint, de-duplicates
// concurrent identical reads and warms recent conversations in a second, short-lived reader.
export class SessionReadOffload {
  constructor({ dataRoot, sessionRoot, packageRoot, env, log, readerScript, warmLimit = 0, warmMaxFileBytes = 64 * 1024 * 1024 }) {
    this.sessionRoot = path.resolve(sessionRoot);
    this.log = log;
    this.enabled = Boolean(packageRoot) && fs.existsSync(path.join(packageRoot, ".next", "server", "app", "api", "sessions", "[id]", "route.js"));
    if (!this.enabled) log("session-read-offload-disabled", { reason: "pi-web package routes not found", packageRoot: packageRoot || null });
    const readerOptions = { packageRoot, env, log, ...(readerScript ? { script: readerScript } : {}) };
    this.reader = new SessionReader({ ...readerOptions, name: "interactive" });
    this.warmReader = new SessionReader({ ...readerOptions, name: "warm", exitWhenIdleMs: 15_000 });
    this.cache = new SessionReadCache({ dir: path.join(dataRoot, "piweb-session-read-cache", "v2"), log });
    this.inflight = new Map();
    this.catalogue = null;
    this.pathById = new Map();
    this.warmLimit = warmLimit;
    this.warmMaxFileBytes = warmMaxFileBytes;
    this.warming = null;
    this.warmAgain = false;
    this.warmCandidates = null;
    this.closed = false;
    this.stats = { memory: 0, disk: 0, reader: 0, fallback: 0 };
  }

  setCatalogue(catalogue) {
    if (!Array.isArray(catalogue) || catalogue === this.catalogue) return;
    this.catalogue = catalogue;
    const next = new Map();
    for (const session of catalogue) {
      const id = String(session?.id || "");
      const file = typeof session?.path === "string" ? path.resolve(session.path) : "";
      if (id && file && file.toLowerCase().endsWith(".jsonl")) next.set(id, file);
    }
    this.pathById = next;
  }

  sessionFile(id) {
    const file = this.pathById.get(id);
    if (!file) return null;
    const relative = path.relative(this.sessionRoot, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return file;
  }

  // Resolves to { status, headers, body, encoded, source } or null (caller falls back to pi-web).
  async read(route, id, searchParams) {
    if (!this.enabled) return null;
    const file = this.sessionFile(id);
    if (!file) return null;
    const before = await fileFingerprint(file);
    if (!before) return null;
    const normalized = normalizeSearch(searchParams);
    const key = SessionReadCache.key(route, id, normalized);
    const cached = await this.cache.get(key, before.fp);
    if (cached) { this.stats[cached.source] += 1; return { ...cached.entry, source: cached.source }; }
    const flightKey = `${key}\n${before.fp}`;
    let flight = this.inflight.get(flightKey);
    if (!flight) {
      flight = this.compute(this.reader, route, id, normalized, key, file, before).finally(() => this.inflight.delete(flightKey));
      this.inflight.set(flightKey, flight);
    }
    const result = await flight;
    if (result) this.stats.reader += 1;
    return result;
  }

  async compute(reader, route, id, normalized, key, file, before) {
    let result;
    try { result = await reader.read(route, id, normalized ? `?${normalized}` : ""); }
    catch (error) {
      this.log("session-read-offload-error", { reader: reader.name, route, id, reason: normalizeError(error?.message || error), blocked: error?.blocked || [] });
      return null;
    }
    const otherWrites = (result.blocked || []).filter((name) => name !== "appendFileSync");
    if (otherWrites.length) {
      this.log("session-read-offload-write-blocked", { reader: reader.name, route, id, blocked: otherWrites });
      return null;
    }
    if (result.status < 200 || result.status >= 300) return null;
    const after = await fileFingerprint(file);
    const stable = after?.fp === before.fp && !(result.blocked || []).includes("appendFileSync");
    if (result.ms > 500) this.log("session-read-offload-slow", { reader: reader.name, route, id, ms: Math.round(result.ms), fileMb: +(before.bytes / 1048576).toFixed(1), cached: stable });
    if (!stable) return { status: result.status, headers: result.headers, body: result.body, encoded: new Map(), source: "reader-uncached" };
    const entry = await this.cache.put(key, before.fp, result.status, result.headers, result.body);
    return { ...entry, source: "reader" };
  }

  // Precompute the default conversation view for recent idle sessions so the first click is a cache hit.
  // `candidates()` returns { sessions, runningIds } at the moment a warm pass starts (active, non-archived rows).
  scheduleWarm(candidates) {
    // Seek pages make speculative whole-session warming unnecessary.
    if (!this.enabled || this.closed || this.warmLimit <= 0) return;
    this.warmCandidates = candidates;
    if (this.warming) { this.warmAgain = true; return; }
    this.warming = (async () => {
      const startedAt = Date.now();
      let warmed = 0, skipped = 0;
      try {
        const { sessions: rows = [], runningIds = new Set() } = this.warmCandidates() || {};
        const sessions = rows
          .filter((session) => session?.id && !runningIds.has(String(session.id)))
          .sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")))
          .slice(0, this.warmLimit);
        const search = new URL(`http://x/${DEFAULT_DETAIL_SEARCH}`).searchParams;
        const normalized = normalizeSearch(search);
        for (const session of sessions) {
          if (this.closed) break;
          const id = String(session.id);
          const file = this.sessionFile(id);
          if (!file) continue;
          const before = await fileFingerprint(file);
          if (!before || before.bytes > this.warmMaxFileBytes) { skipped += 1; continue; }
          const key = SessionReadCache.key("detail", id, normalized);
          if (await this.cache.has(key, before.fp)) continue;
          const flightKey = `${key}\n${before.fp}`;
          if (this.inflight.has(flightKey)) continue;
          const flight = this.compute(this.warmReader, "detail", id, normalized, key, file, before).finally(() => this.inflight.delete(flightKey));
          this.inflight.set(flightKey, flight);
          if (await flight) warmed += 1;
        }
      } catch (error) {
        this.log("session-read-warm-failed", { reason: normalizeError(error?.message || error) });
      } finally {
        if (warmed || skipped) this.log("session-read-warmed", { warmed, skippedLarge: skipped, elapsedMs: Date.now() - startedAt });
        this.warming = null;
        if (this.warmAgain && !this.closed) { this.warmAgain = false; this.scheduleWarm(this.warmCandidates); }
      }
    })();
  }

  close() {
    this.closed = true;
    this.reader.close();
    this.warmReader.close();
  }
}
