// Pi Web 只读会话读取进程（由 piweb-ui-proxy 经 IPC 拉起）。
// 加载与 pi-web 同一份编译后的 GET /api/sessions/[id] 与 /context 路由，在独立进程里解析会话 JSONL，
// 让 pi-web 主进程的事件循环不再被几十到几百 MB 的同步解析冻结。输出与上游同源同码。
// 本进程只读：会话文件属于 pi-web 主进程，这里任何写入（含 SDK 的末行换行修复、旧版迁移重写）一律拦截；
// 被拦的写入会随结果上报，代理据此不缓存或回退上游。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const packageRoot = process.env.PIWEB_SESSION_READER_PACKAGE;
if (!packageRoot || typeof process.send !== "function") {
  console.error("[piweb-session-reader] requires PIWEB_SESSION_READER_PACKAGE and an IPC channel");
  process.exit(2);
}

// ---- write guard (must run before any pi-web/SDK module is loaded) ----
let blocked = [];
const WRITE_FLAG = /[wa+]/u;
const readOnlyError = (name, target) => Object.assign(
  new Error(`piweb-session-reader is read-only: ${name} ${String(target ?? "").slice(0, 200)}`),
  { code: "EPIWEBREADONLY" },
);
const isWriteFlags = (flags) => (typeof flags === "number"
  ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0
  : WRITE_FLAG.test(String(flags ?? "r")));

function guardSync(name) {
  if (typeof fs[name] !== "function") return;
  fs[name] = (target) => { blocked.push(name); throw readOnlyError(name, target); };
}
function guardCallback(name) {
  if (typeof fs[name] !== "function") return;
  fs[name] = (target, ...rest) => {
    blocked.push(name);
    const callback = rest.reverse().find((value) => typeof value === "function");
    const error = readOnlyError(name, target);
    if (callback) process.nextTick(callback, error); else throw error;
  };
}
function guardPromise(name) {
  if (typeof fs.promises[name] !== "function") return;
  fs.promises[name] = async (target) => { blocked.push(`promises.${name}`); throw readOnlyError(name, target); };
}

// SDK loadEntriesFromFile() appends "\n" when the last line is unterminated (a writer is mid-append).
// The owner process repairs that; here it is a no-op so the read still returns the complete lines.
fs.appendFileSync = () => { blocked.push("appendFileSync"); };
for (const name of ["writeFileSync", "writeSync", "writevSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "copyFileSync",
  "cpSync", "truncateSync", "ftruncateSync", "symlinkSync", "linkSync", "utimesSync", "futimesSync", "chmodSync", "fchmodSync", "mkdtempSync"]) guardSync(name);
for (const name of ["appendFile", "writeFile", "write", "writev", "rename", "unlink", "rm", "rmdir", "copyFile", "cp", "truncate",
  "ftruncate", "symlink", "link", "utimes", "futimes", "chmod", "mkdtemp"]) guardCallback(name);
for (const name of ["appendFile", "writeFile", "rename", "unlink", "rm", "rmdir", "copyFile", "cp", "truncate", "symlink", "link",
  "utimes", "chmod", "mkdtemp"]) guardPromise(name);
// Existing directories are a no-op for mkdir; creating new ones is a write.
const nativeMkdirSync = fs.mkdirSync;
fs.mkdirSync = (target, options) => {
  if (fs.existsSync(target)) return undefined;
  blocked.push("mkdirSync");
  throw readOnlyError("mkdirSync", target);
};
const nativeMkdir = fs.promises.mkdir;
fs.promises.mkdir = async (target, options) => {
  if (fs.existsSync(target)) return undefined;
  blocked.push("promises.mkdir");
  throw readOnlyError("mkdir", target);
};
const nativeOpenSync = fs.openSync;
fs.openSync = (target, flags, mode) => {
  if (isWriteFlags(flags)) { blocked.push("openSync:w"); throw readOnlyError("openSync", target); }
  return nativeOpenSync(target, flags, mode);
};
const nativeOpen = fs.open;
fs.open = (target, flags, ...rest) => {
  if (typeof flags !== "function" && isWriteFlags(flags)) {
    blocked.push("open:w");
    const callback = rest.reverse().find((value) => typeof value === "function");
    const error = readOnlyError("open", target);
    if (callback) return process.nextTick(callback, error);
    throw error;
  }
  return nativeOpen(target, flags, ...rest);
};
const nativePromiseOpen = fs.promises.open;
fs.promises.open = async (target, flags, mode) => {
  if (isWriteFlags(flags)) { blocked.push("promises.open:w"); throw readOnlyError("open", target); }
  return nativePromiseOpen(target, flags, mode);
};
fs.createWriteStream = (target) => { blocked.push("createWriteStream"); throw readOnlyError("createWriteStream", target); };
syncBuiltinESMExports();
void nativeMkdirSync; void nativeMkdir;

// ---- routes ----
const ROUTES = {
  detail: { file: ".next/server/app/api/sessions/[id]/route.js", suffix: "" },
  context: { file: ".next/server/app/api/sessions/[id]/context/route.js", suffix: "/context" },
};

async function loadRoute(file) {
  const mod = require(path.join(packageRoot, file));
  let routeModule;
  for (let attempt = 0; attempt < 400 && !routeModule; attempt += 1) {
    try { routeModule = mod.routeModule; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  if (!routeModule) throw new Error(`route module did not load: ${file}`);
  if (typeof routeModule.ensureUserland === "function") await routeModule.ensureUserland();
  const handler = routeModule.userland?.GET;
  if (typeof handler !== "function") throw new Error(`route has no GET handler: ${file}`);
  return handler;
}

const handlers = {};
let queue = Promise.resolve();

async function read(message) {
  const route = ROUTES[message.route];
  const handler = handlers[message.route];
  if (!route || !handler) throw new Error(`unknown route ${message.route}`);
  const id = String(message.id || "");
  const search = String(message.search || "");
  blocked = [];
  const startedAt = performance.now();
  const request = new Request(`http://127.0.0.1/api/sessions/${encodeURIComponent(id)}${route.suffix}${search}`, {
    headers: { host: "127.0.0.1", "accept-encoding": "identity" },
  });
  const response = await handler(request, { params: Promise.resolve({ id }) });
  const body = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((value, name) => {
    if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) headers[name] = value;
  });
  return { status: response.status, headers, body, ms: performance.now() - startedAt, blocked: [...new Set(blocked)] };
}

process.on("message", (message) => {
  if (message?.type !== "read") return;
  queue = queue.then(async () => {
    try {
      const result = await read(message);
      process.send({ type: "result", seq: message.seq, ...result, rss: process.memoryUsage().rss });
    } catch (error) {
      process.send({ type: "result", seq: message.seq, error: String(error?.stack || error).slice(0, 2000), blocked: [...new Set(blocked)], rss: process.memoryUsage().rss });
    }
  });
});
process.on("disconnect", () => process.exit(0));

(async () => {
  process.chdir(packageRoot);
  for (const [name, route] of Object.entries(ROUTES)) handlers[name] = await loadRoute(route.file);
  process.send({ type: "ready", routes: Object.keys(handlers), pid: process.pid });
})().catch((error) => {
  try { process.send({ type: "fatal", error: String(error?.stack || error).slice(0, 2000) }); } catch {}
  process.exit(1);
});
