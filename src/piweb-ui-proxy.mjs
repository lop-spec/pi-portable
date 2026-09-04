// Pi Web 会话归档/额度 UI 透明代理。
// 只改写 HTML、会话目录和显式归档接口；/api/agent 与其它业务请求字节流透传。
// 本进程不读取 prompt、不保存执行意图、不判断任务完成，也不注入任何消息。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PIWEB_UI_PROXY_VERSION = "piweb-ui-proxy-v1";
export const PIWEB_ARCHIVE_VERSION = "piweb-session-archive-v9";
export const PIWEB_ARCHIVE_UI_PATH = "/__pi_archive_ui.js";
export const PIWEB_ACCOUNT_USAGE_PATH = "/__pi_account_usage";
export const PIWEB_ACCOUNT_SELECT_PATH = "/__pi_account_select";
const PIWEB_ARCHIVE_UI_FILE = fileURLToPath(new URL("./piweb-archive-ui.js", import.meta.url));
const PIWEB_PAGE_CHUNK_REF_RE = /static\/chunks\/app\/(page-[a-z0-9]+\.js)/gu;

const iso = (value = Date.now()) => new Date(value).toISOString();
const normalizeError = (value) => String(value || "unknown").replace(/\s+/gu, " ").slice(0, 500);
const timeoutSignal = (ms) => AbortSignal.timeout(Math.max(1, ms));

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function boundedSessionHeader(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.indexOf("\n");
    if (end < 0) throw new Error("Pi session header exceeds 64 KiB or has no line boundary");
    return JSON.parse(text.slice(0, end).replace(/\r$/u, ""));
  } finally {
    fs.closeSync(descriptor);
  }
}

export class SessionArchiveStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.sessionRoot = path.resolve(options.sessionRoot || path.join(path.dirname(this.filePath), "sessions"));
    this.now = options.now || Date.now;
  }

  fresh() {
    return { version: 1, archiveVersion: PIWEB_ARCHIVE_VERSION, updatedAt: iso(this.now()), sessions: {} };
  }

  load() {
    if (!fs.existsSync(this.filePath)) return this.fresh();
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, "utf8")); }
    catch (error) { throw new Error(`session archive index is unreadable: ${String(error?.message || error)}`); }
    if (value?.version !== 1 || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)) {
      throw new Error("unsupported session archive index schema");
    }
    return value;
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const value = { ...state, version: 1, archiveVersion: PIWEB_ARCHIVE_VERSION, updatedAt: iso(this.now()) };
    const temporary = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    try { fs.renameSync(temporary, this.filePath); }
    finally { try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch {} }
  }

  validateSession(info) {
    const id = String(info?.id || "").trim();
    const filePath = path.resolve(String(info?.path || ""));
    if (!id || !info?.path) throw new Error("archive requires a persisted Pi session id and path");
    if (path.extname(filePath).toLowerCase() !== ".jsonl") throw new Error("archive target is not a Pi JSONL session");
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error("archive target Pi session does not exist");
    const realRoot = fs.realpathSync(this.sessionRoot);
    const realFile = fs.realpathSync(filePath);
    if (!isPathInside(realRoot, realFile)) throw new Error("archive target is outside the configured Pi sessions root");
    const header = boundedSessionHeader(realFile);
    if (header?.type !== "session" || String(header.id || "") !== id) {
      throw new Error("archive target header does not match the requested Pi session id");
    }
    const stat = fs.statSync(realFile);
    return {
      id,
      filePath,
      relativePath: path.relative(this.sessionRoot, filePath).split(path.sep).join("/"),
      cwd: String(info.cwd || ""),
      name: String(info.name || ""),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  recordMatches(record, filePath) {
    if (!record?.relativePath || !filePath) return false;
    const recorded = path.resolve(this.sessionRoot, ...String(record.relativePath).split("/"));
    return pathKey(recorded) === pathKey(filePath);
  }

  archiveMany(infos, groupId = "") {
    const validated = [...new Map((infos || []).map((info) => {
      const item = this.validateSession(info);
      return [item.id, item];
    })).values()];
    if (!validated.length) throw new Error("archive requires at least one persisted Pi session");
    const archiveGroupId = String(groupId || validated[0].id);
    const state = this.load();
    const archivedAt = iso(this.now());
    let createdCount = 0;
    const records = [];
    for (const item of validated) {
      const existing = state.sessions[item.id];
      if (existing && (!this.recordMatches(existing, item.filePath) || String(existing.groupId || existing.id) !== archiveGroupId)) {
        throw new Error(`session ${item.id} already belongs to a different archive record`);
      }
      const record = existing || {
        id: item.id,
        groupId: archiveGroupId,
        relativePath: item.relativePath,
        archivedAt,
        cwd: item.cwd,
        name: item.name,
        size: item.size,
        mtimeMs: item.mtimeMs,
      };
      if (!existing) createdCount += 1;
      state.sessions[item.id] = record;
      records.push(record);
    }
    if (createdCount) this.save(state);
    return { created: createdCount > 0, createdCount, records };
  }

  restore(id) {
    const sessionId = String(id || "");
    const state = this.load();
    const record = state.sessions[sessionId];
    if (!record) return { restored: false, sessionIds: [] };
    const groupId = String(record.groupId || record.id);
    const sessionIds = Object.values(state.sessions)
      .filter((item) => String(item.groupId || item.id) === groupId)
      .map((item) => String(item.id));
    for (const archivedId of sessionIds) delete state.sessions[archivedId];
    this.save(state);
    return { restored: true, groupId, sessionIds };
  }

  partition(sessions) {
    const state = this.load();
    const active = [];
    const archived = [];
    for (const session of Array.isArray(sessions) ? sessions : []) {
      const record = state.sessions[String(session?.id || "")];
      if (record && this.recordMatches(record, session?.path)) {
        archived.push({
          ...session,
          archived: true,
          archivedAt: String(record.archivedAt || ""),
          archiveGroupId: String(record.groupId || record.id || ""),
        });
      } else active.push(session);
    }
    return { active, archived };
  }
}

export function resolvePiWebPageChunk(packageRoot) {
  if (!packageRoot) return null;
  const manifestFile = path.join(packageRoot, ".next", "server", "app", "page_client-reference-manifest.js");
  const manifest = fs.readFileSync(manifestFile, "utf8");
  const names = [...new Set([...manifest.matchAll(PIWEB_PAGE_CHUNK_REF_RE)].map((match) => match[1]))];
  if (names.length !== 1) throw new Error(`pi-web page chunk manifest references ${names.length} assets (expected 1)`);
  const name = names[0];
  const file = path.join(packageRoot, ".next", "static", "chunks", "app", name);
  if (!fs.existsSync(file)) throw new Error(`pi-web page chunk missing: ${file}`);
  return { name, file, manifestFile };
}

export function rewritePiWebPageChunkReferences(html, currentAsset) {
  if (!currentAsset?.name) return { html: String(html), replacements: 0, staleNames: [] };
  let replacements = 0;
  const staleNames = new Set();
  const out = String(html).replace(PIWEB_PAGE_CHUNK_REF_RE, (reference, name) => {
    if (name === currentAsset.name) return reference;
    replacements += 1;
    staleNames.add(name);
    return `static/chunks/app/${currentAsset.name}`;
  });
  return { html: out, replacements, staleNames: [...staleNames] };
}

export class PiWebUiProxy {
  constructor(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || process.env.PI_PORTABLE_DATA || path.join(process.cwd(), "data"));
    this.dataRoot = dataRoot;
    this.sessionRoot = path.resolve(options.sessionRoot || path.join(dataRoot, ".pi", "agent", "sessions"));
    this.webPort = Number(options.webPort || process.env.PI_WEB_PORT || 30140);
    this.publicWebPort = Number(options.publicWebPort || process.env.PI_RUN_SUPERVISOR_PUBLIC_PORT || 0);
    this.healthPort = Number(options.healthPort || process.env.PI_RUN_SUPERVISOR_PORT || (this.publicWebPort || this.webPort) + 1);
    this.bridgePort = Number(options.bridgePort || process.env.CODEX_PROXY_PORT || 8794);
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.archiveStore = options.archiveStore || new SessionArchiveStore(
      options.archiveFile || path.join(path.dirname(this.sessionRoot), "session-archive.json"),
      { sessionRoot: this.sessionRoot, now: this.now },
    );
    this.archiveUiSource = options.archiveUiSource || fs.readFileSync(PIWEB_ARCHIVE_UI_FILE, "utf8");
    this.sessionCatalogue = [];
    this.sessionCatalogueAt = 0;
    this.runningIds = new Set();
    this.logFile = path.resolve(options.logFile || path.join(dataRoot, "piweb-ui-proxy.log"));
    const portableHome = String(process.env.PI_PORTABLE_HOME || "").trim();
    const configuredRoot = options.piWebPackageRoot || (portableHome ? path.join(portableHome, "app", "node_modules", "@agegr", "pi-web") : "");
    this.piWebPackageRoot = configuredRoot ? path.resolve(configuredRoot) : "";
    this.pageChunkAsset = null;
    this.pageChunkManifestStamp = "";
    this.pageChunkFailure = "";
    this.pageChunkRewriteKeys = new Set();
    this.pageChunkServedNames = new Set();
    this.server = null;
    this.proxyServer = null;
    this.closed = false;
  }

  log(event, detail = {}) {
    const row = { ts: iso(this.now()), version: PIWEB_UI_PROXY_VERSION, event, ...detail };
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(row) + "\n");
    } catch {}
    return row;
  }

  proxyHeaders(headers, extra = {}) {
    // 保留浏览器原 Host，使 Pi Web 的 Origin/Host 同源校验继续成立。
    const result = { ...headers, ...extra };
    if (!result.host) result.host = `127.0.0.1:${this.webPort}`;
    delete result.connection;
    return result;
  }

  streamProxy(request, response) {
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: this.webPort,
      method: request.method,
      path: request.url,
      headers: this.proxyHeaders(request.headers),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      this.log("upstream-stream-error", { path: request.url || "", reason: normalizeError(error?.message || error) });
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      if (!response.destroyed) response.end(JSON.stringify({ error: "Pi Web upstream unavailable" }));
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  }

  async fetchBufferedUpstream(request, rawBody = Buffer.alloc(0)) {
    const headers = this.proxyHeaders(request.headers, {
      "accept-encoding": "identity",
      "content-length": String(rawBody.length),
    });
    return new Promise((resolve, reject) => {
      const upstream = http.request({
        hostname: "127.0.0.1",
        port: this.webPort,
        method: request.method,
        path: request.url,
        headers,
      }, (upstreamResponse) => {
        const chunks = [];
        upstreamResponse.on("data", (chunk) => chunks.push(chunk));
        upstreamResponse.on("end", () => resolve({
          status: upstreamResponse.statusCode || 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks),
        }));
      });
      upstream.once("error", reject);
      upstream.end(rawBody);
    });
  }

  writeBuffered(response, upstreamResult, overrides = {}) {
    const body = overrides.body ?? upstreamResult.body;
    const headers = { ...upstreamResult.headers, ...overrides.headers, "content-length": String(body.length) };
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    if (overrides.changed) {
      delete headers.etag;
      delete headers["content-md5"];
    }
    response.writeHead(overrides.status || upstreamResult.status, headers);
    response.end(body);
  }

  jsonResponse(response, status, value, headers = {}) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
      ...headers,
    });
    response.end(body);
  }

  mutationOriginAllowed(request) {
    const origin = String(request.headers.origin || "");
    if (!origin) return true;
    try {
      const source = new URL(origin);
      return ["http:", "https:"].includes(source.protocol)
        && source.host.toLowerCase() === String(request.headers.host || "").toLowerCase();
    } catch { return false; }
  }

  async handleAccountUsageProxy(response, parsedUrl) {
    try {
      const refresh = parsedUrl.searchParams.get("refresh") === "1" ? "?refresh=1" : "";
      const upstream = await this.fetch(`http://127.0.0.1:${this.bridgePort}/account-usage${refresh}`, {
        cache: "no-store",
        signal: timeoutSignal(500),
      });
      const body = await upstream.json();
      if (!upstream.ok || !body || !Array.isArray(body.accounts)) throw new Error(`bridge account usage HTTP ${upstream.status}`);
      this.jsonResponse(response, 200, body);
    } catch (error) {
      const reason = normalizeError(error?.message || error);
      this.log("account-usage-proxy-error", { bridgePort: this.bridgePort, reason });
      this.jsonResponse(response, 503, {
        ok: false,
        enabled: false,
        refreshing: false,
        modelTokensConsumed: 0,
        accounts: [],
        error: "账号额度服务暂不可用",
      });
    }
  }

  async readControlJson(request, limit = 4096) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > limit) throw new Error(`control request exceeds ${limit} bytes`);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async handleAccountSelectProxy(request, response) {
    if (!this.mutationOriginAllowed(request)) {
      this.log("account-select-rejected", { reason: "cross-origin mutation" });
      this.jsonResponse(response, 403, { ok: false, error: "跨域账号切换已拒绝" });
      return;
    }
    if (!/^application\/json\b/iu.test(String(request.headers["content-type"] || ""))) {
      this.log("account-select-rejected", { reason: "content-type must be application/json" });
      this.jsonResponse(response, 415, { ok: false, error: "需要 Content-Type: application/json" });
      return;
    }
    let id = "";
    try { id = String((await this.readControlJson(request))?.id || ""); }
    catch (error) {
      const reason = normalizeError(error?.message || error);
      this.log("account-select-rejected", { reason });
      this.jsonResponse(response, 400, { ok: false, error: "账号切换请求无效" });
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(id)) {
      this.log("account-select-rejected", { id: id.slice(0, 32), reason: "invalid account id" });
      this.jsonResponse(response, 400, { ok: false, error: "账号 id 无效" });
      return;
    }
    try {
      const upstream = await this.fetch(`http://127.0.0.1:${this.bridgePort}/account/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
        cache: "no-store",
        signal: timeoutSignal(1000),
      });
      const body = await upstream.json().catch(() => ({}));
      if (!upstream.ok || body?.ok !== true) {
        const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
        const reason = normalizeError(body?.error || `bridge account select HTTP ${upstream.status}`);
        this.log("account-select-failed", { id, status, reason });
        this.jsonResponse(response, status, { ok: false, error: reason });
        return;
      }
      this.log("account-select-success", { id });
      this.jsonResponse(response, 200, body);
    } catch (error) {
      const reason = normalizeError(error?.message || error);
      this.log("account-select-proxy-error", { id, bridgePort: this.bridgePort, reason });
      this.jsonResponse(response, 503, { ok: false, error: "账号切换服务暂不可用" });
    }
  }

  serveArchiveUi(response) {
    try {
      const currentSource = fs.readFileSync(PIWEB_ARCHIVE_UI_FILE, "utf8");
      if (currentSource !== this.archiveUiSource) {
        this.archiveUiSource = currentSource;
        this.log("piweb-archive-ui-reloaded", { version: PIWEB_ARCHIVE_VERSION });
      }
    } catch (error) {
      this.log("piweb-archive-ui-reload-failed", { reason: normalizeError(error?.message || error) });
    }
    const body = Buffer.from(this.archiveUiSource);
    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  }

  currentPiWebPageChunk() {
    if (!this.piWebPackageRoot) return null;
    const manifestFile = path.join(this.piWebPackageRoot, ".next", "server", "app", "page_client-reference-manifest.js");
    try {
      const stat = fs.statSync(manifestFile);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (this.pageChunkAsset && this.pageChunkManifestStamp === stamp) return this.pageChunkAsset;
      const previous = this.pageChunkAsset?.name || "";
      const asset = resolvePiWebPageChunk(this.piWebPackageRoot);
      this.pageChunkAsset = asset;
      this.pageChunkManifestStamp = stamp;
      this.pageChunkFailure = "";
      if (asset?.name !== previous) this.log("piweb-page-chunk-selected", { previous: previous || null, current: asset?.name || null });
      return asset;
    } catch (error) {
      const reason = normalizeError(error?.message || error);
      if (reason !== this.pageChunkFailure) this.log("piweb-page-chunk-unavailable", { packageRoot: this.piWebPackageRoot, reason });
      this.pageChunkFailure = reason;
      return this.pageChunkAsset && fs.existsSync(this.pageChunkAsset.file) ? this.pageChunkAsset : null;
    }
  }

  serveCurrentPiWebPageChunk(parsedUrl, response) {
    const asset = this.currentPiWebPageChunk();
    if (!asset || parsedUrl.pathname !== `/_next/static/chunks/app/${asset.name}`) return false;
    try {
      const body = fs.readFileSync(asset.file);
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      if (!this.pageChunkServedNames.has(asset.name)) {
        this.pageChunkServedNames.add(asset.name);
        this.log("piweb-page-chunk-served", { asset: asset.name, bytes: body.length });
      }
    } catch (error) {
      const reason = normalizeError(error?.message || error);
      this.log("piweb-page-chunk-serve-error", { asset: asset.name, reason });
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(`Pi Web current page chunk unavailable: ${reason}`);
    }
    return true;
  }

  async handleHtmlProxy(request, response) {
    const upstreamResult = await this.fetchBufferedUpstream(request);
    const contentType = String(upstreamResult.headers["content-type"] || "");
    if (upstreamResult.status >= 400 || !contentType.toLowerCase().includes("text/html")) {
      this.writeBuffered(response, upstreamResult);
      return;
    }
    let html = upstreamResult.body.toString("utf8");
    const currentPageChunk = this.currentPiWebPageChunk();
    const rewrite = rewritePiWebPageChunkReferences(html, currentPageChunk);
    html = rewrite.html;
    if (rewrite.replacements > 0 && currentPageChunk) {
      const key = `${rewrite.staleNames.join(",")}=>${currentPageChunk.name}`;
      if (!this.pageChunkRewriteKeys.has(key)) {
        this.pageChunkRewriteKeys.add(key);
        this.log("piweb-page-chunk-rewritten", { stale: rewrite.staleNames, current: currentPageChunk.name, replacements: rewrite.replacements });
      }
    }
    if (!html.includes(PIWEB_ARCHIVE_UI_PATH)) {
      const nonce = /<script\b[^>]*\bnonce=["']([^"']+)["']/iu.exec(html)?.[1];
      const nonceAttribute = nonce ? ` nonce="${nonce.replace(/["&<>]/gu, "")}"` : "";
      const tag = `<script src="${PIWEB_ARCHIVE_UI_PATH}" data-pi-session-archive-bootstrap="${PIWEB_ARCHIVE_VERSION}"${nonceAttribute}></script>`;
      html = /<head\b[^>]*>/iu.test(html) ? html.replace(/<head\b[^>]*>/iu, (head) => head + tag) : tag + html;
    }
    this.writeBuffered(response, upstreamResult, {
      body: Buffer.from(html),
      headers: { "cache-control": "no-store" },
      changed: true,
    });
  }

  async handleSessionList(request, response, parsedUrl) {
    const upstreamResult = await this.fetchBufferedUpstream(request);
    let body;
    try { body = JSON.parse(upstreamResult.body.toString("utf8")); }
    catch { this.writeBuffered(response, upstreamResult); return; }
    if (upstreamResult.status >= 400 || !Array.isArray(body?.sessions)) {
      this.writeBuffered(response, upstreamResult);
      return;
    }
    this.sessionCatalogue = body.sessions;
    this.sessionCatalogueAt = this.now();
    if (Array.isArray(body.runningSessionIds)) this.runningIds = new Set(body.runningSessionIds.map(String));
    const partition = this.archiveStore.partition(body.sessions);
    const archivedGroupCount = new Set(partition.archived.map((session) => String(session.archiveGroupId || session.id))).size;
    const view = parsedUrl.searchParams.get("archiveView") === "archived" ? "archived" : "active";
    const value = {
      ...body,
      sessions: view === "archived" ? partition.archived : partition.active,
      archive: {
        view,
        activeCount: partition.active.length,
        archivedCount: archivedGroupCount,
        archivedSessionCount: partition.archived.length,
        version: PIWEB_ARCHIVE_VERSION,
      },
    };
    this.writeBuffered(response, upstreamResult, {
      body: Buffer.from(JSON.stringify(value)),
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      changed: true,
    });
  }

  async fetchSessionCatalogue() {
    const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/sessions?force=1`, {
      cache: "no-store",
      signal: timeoutSignal(10000),
    });
    if (!response.ok) throw new Error(`sessions HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.sessions)) throw new Error("sessions response has no catalogue");
    this.sessionCatalogue = body.sessions;
    this.sessionCatalogueAt = this.now();
    return body.sessions;
  }

  sessionFamily(catalogue, rootId) {
    const familyIds = new Set([String(rootId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of catalogue) {
        const id = String(session?.id || "");
        const parentId = String(session?.relation?.parentSessionId || "");
        if (session?.relation?.kind === "subagent" && parentId && familyIds.has(parentId) && !familyIds.has(id)) {
          familyIds.add(id);
          changed = true;
        }
      }
    }
    return catalogue.filter((session) => familyIds.has(String(session?.id || "")));
  }

  async fetchRunning() {
    const response = await this.fetch(`http://127.0.0.1:${this.webPort}/api/agent/running`, {
      cache: "no-store",
      signal: timeoutSignal(5000),
    });
    if (!response.ok) throw new Error(`running HTTP ${response.status}`);
    const body = await response.json();
    return new Set(Array.isArray(body?.runningSessionIds) ? body.runningSessionIds.map(String) : []);
  }

  async runningSessionsForArchive(maxWaitMs = 120) {
    const cached = new Set(this.runningIds);
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), maxWaitMs); });
    const probe = this.fetchRunning().then((value) => ({ value }), (error) => ({ error }));
    const result = await Promise.race([probe, timeout]);
    clearTimeout(timer);
    if (result?.value instanceof Set) {
      this.runningIds = result.value;
      return result.value;
    }
    this.log("session-archive-running-cache", {
      reason: result?.timeout ? "probe-timeout" : normalizeError(result?.error?.message || result?.error || "probe-failed"),
      count: cached.size,
    });
    return cached;
  }

  async handleArchiveMutation(request, response, action, encodedId) {
    if (!this.mutationOriginAllowed(request)) {
      this.log("session-archive-rejected", { action, reason: "cross-origin mutation" });
      this.jsonResponse(response, 403, { error: "cross-origin session archive mutation rejected" });
      return;
    }
    let sessionId;
    try { sessionId = decodeURIComponent(encodedId); }
    catch {
      this.log("session-archive-rejected", { action, reason: "invalid session id encoding" });
      this.jsonResponse(response, 400, { error: "invalid session id encoding" });
      return;
    }
    this.log("session-archive-request", { action, sessionId });
    if (action === "restore") {
      try {
        const result = this.archiveStore.restore(sessionId);
        if (result.restored) this.log("session-restored", { sessionId, sessionIds: result.sessionIds });
        this.jsonResponse(response, 200, { ok: true, restored: result.restored, preserved: true, sessionId, sessionIds: result.sessionIds });
      } catch (error) {
        const message = String(error?.message || error);
        this.log("session-archive-failed", { action, sessionId, status: 500, error: message });
        this.jsonResponse(response, 500, { error: message });
      }
      return;
    }
    try {
      let catalogue = this.sessionCatalogue;
      let catalogueSource = "ui-cache";
      let target = catalogue.find((session) => String(session?.id || "") === sessionId);
      if (!target) {
        catalogue = await this.fetchSessionCatalogue();
        catalogueSource = "forced-refresh";
        target = catalogue.find((session) => String(session?.id || "") === sessionId);
      }
      this.log("session-archive-catalogue", {
        action,
        sessionId,
        source: catalogueSource,
        ageMs: this.sessionCatalogueAt ? Math.max(0, this.now() - this.sessionCatalogueAt) : null,
        count: catalogue.length,
      });
      const running = await this.runningSessionsForArchive();
      if (!target) {
        this.log("session-archive-failed", { action, sessionId, status: 404, error: "Session not found" });
        this.jsonResponse(response, 404, { error: "Session not found" });
        return;
      }
      const family = this.sessionFamily(catalogue, sessionId);
      const runningFamily = family.map((session) => String(session.id)).filter((id) => running.has(id));
      if (runningFamily.length) {
        const message = `Session is running and cannot be archived: ${runningFamily.join(", ")}`;
        this.log("session-archive-failed", { action, sessionId, status: 409, error: message });
        this.jsonResponse(response, 409, { error: message });
        return;
      }
      const result = this.archiveStore.archiveMany(family, sessionId);
      if (result.created) this.log("session-archived", { sessionId, sessionIds: result.records.map((record) => record.id), preserved: true });
      this.jsonResponse(response, 200, {
        ok: true,
        archived: true,
        created: result.created,
        preserved: true,
        sessionId,
        sessionIds: result.records.map((record) => record.id),
        archivedAt: result.records[0]?.archivedAt || "",
      });
    } catch (error) {
      const message = String(error?.message || error);
      const status = /requires|outside|does not exist|does not match|not a Pi JSONL/u.test(message) ? 409 : 500;
      this.log("session-archive-failed", { action, sessionId, status, error: message });
      this.jsonResponse(response, status, { error: message });
    }
  }

  async handlePublicProxy(request, response) {
    const parsedUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && parsedUrl.pathname === PIWEB_ARCHIVE_UI_PATH) return this.serveArchiveUi(response);
    if (request.method === "GET" && parsedUrl.pathname === PIWEB_ACCOUNT_USAGE_PATH) return this.handleAccountUsageProxy(response, parsedUrl);
    if (request.method === "POST" && parsedUrl.pathname === PIWEB_ACCOUNT_SELECT_PATH) return this.handleAccountSelectProxy(request, response);
    if (request.method === "GET" && this.serveCurrentPiWebPageChunk(parsedUrl, response)) return;
    if (request.method === "GET" && parsedUrl.pathname === "/api/sessions") return this.handleSessionList(request, response, parsedUrl);

    const explicitArchive = /^\/api\/sessions\/([^/]+)\/(archive|restore)$/u.exec(parsedUrl.pathname);
    const legacyArchive = /^\/api\/sessions\/([^/]+)$/u.exec(parsedUrl.pathname);
    if (request.method === "POST" && explicitArchive) return this.handleArchiveMutation(request, response, explicitArchive[2], explicitArchive[1]);
    if (request.method === "DELETE" && legacyArchive) return this.handleArchiveMutation(request, response, "archive", legacyArchive[1]);

    const acceptsHtml = String(request.headers.accept || "").toLowerCase().includes("text/html");
    if (request.method === "GET" && !parsedUrl.pathname.startsWith("/api/") && !parsedUrl.pathname.startsWith("/_next/") && (parsedUrl.pathname === "/" || acceptsHtml)) {
      return this.handleHtmlProxy(request, response);
    }

    // 关键边界：agent prompt/abort/events 与其它 API 全部不解析、不缓冲、不持久化。
    this.streamProxy(request, response);
  }

  health() {
    return {
      ok: true,
      version: PIWEB_UI_PROXY_VERSION,
      publicWebPort: this.publicWebPort,
      upstreamWebPort: this.webPort,
      archiveVersion: PIWEB_ARCHIVE_VERSION,
      promptCapture: false,
      recoveryDispatch: false,
      goalStateConsumer: false,
      agentRequests: "byte-stream-pass-through",
    };
  }

  async start() {
    if (this.closed) throw new Error("proxy is closed");
    if (this.publicWebPort > 0) {
      this.proxyServer = http.createServer((request, response) => {
        Promise.resolve(this.handlePublicProxy(request, response)).catch((error) => {
          this.log("public-proxy-error", { path: request.url || "", reason: normalizeError(error?.message || error) });
          if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
          if (!response.destroyed) response.end(JSON.stringify({ error: "Pi Web UI proxy failed" }));
        });
      });
      await new Promise((resolve, reject) => {
        this.proxyServer.once("error", reject);
        this.proxyServer.listen(this.publicWebPort, "127.0.0.1", resolve);
      });
    }

    this.server = http.createServer((request, response) => {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/")) {
        this.jsonResponse(response, 200, this.health());
        return;
      }
      this.jsonResponse(response, 404, { error: "not found" });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.healthPort, "127.0.0.1", resolve);
    });
    this.log("started", this.health());
    return this.health();
  }

  async close() {
    this.closed = true;
    const closeServer = (server) => new Promise((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
    await Promise.all([closeServer(this.proxyServer), closeServer(this.server)]);
    this.log("stopped");
  }
}

export async function piWebUiProxyMain() {
  const proxy = new PiWebUiProxy();
  await proxy.start();
  const stop = async () => { await proxy.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export function isDirectRun(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return pathKey(fs.realpathSync(argvPath)) === pathKey(fs.realpathSync(fileURLToPath(moduleUrl))); }
  catch { return pathKey(argvPath) === pathKey(fileURLToPath(moduleUrl)); }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  piWebUiProxyMain().catch((error) => {
    console.error(`[piweb-ui-proxy] fatal: ${normalizeError(error?.stack || error)}`);
    process.exit(1);
  });
}
