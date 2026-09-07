// 独立拉起 pi-portable 桥（8794）：launcher 熔断后或端口被旧桥抢占时的止血工具。
// 复刻 launcher 的桥环境（PI_PORTABLE_DATA / CODEX_PROXY_PORT / 出口代理），静默、分离、stderr 落盘。
// 用法：node restart-bridge-standalone.mjs [--restart-idle|--kill-stale]
// 只经桥自身的原子 idle 端点退出；旧版无端点、活跃请求或非桥占用均拒绝，绝不强杀。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { commandReferencesPath, readBridgeEgress, resolveBridgeRuntime } from "./bridge-runtime-paths.mjs";

const runtime = resolveBridgeRuntime(import.meta.url);
const HOME = runtime.portableRoot;
const DATA = runtime.data;
const PORT = Number(process.env.PI_BRIDGE_PORT || process.env.CODEX_PROXY_PORT || 8794);
const BRIDGE = path.join(HOME, "src", "bridge", "codex-responses-proxy.mjs");
const killStale = process.argv.includes("--kill-stale");
const restartIdle = process.argv.includes("--restart-idle");

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health", timeout: 1500 }, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
function ps(cmd) { return execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8", windowsHide: true }).trim(); }
function listenerPids() {
  return ps(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

for (const pid of listenerPids()) {
  const cmd = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
  const isBridge = /codex-responses-proxy\.mjs/i.test(cmd);
  const isPortable = commandReferencesPath(cmd, BRIDGE);
  if (isPortable && !restartIdle) { console.log(`${PORT} 已是 pi-portable 桥 pid ${pid}，不动`); process.exit(0); }
  if (!isBridge) { console.log(`pid ${pid} 占用 ${PORT} 但不是桥，放弃：${cmd.slice(0, 120)}`); process.exit(1); }
  if (!killStale && !restartIdle) { console.log(`pid ${pid} 是旧桥；未指定切换，不动`); process.exit(1); }
  const current = await health();
  if (current?.lifecycle?.version !== "idle-shutdown-v1" || current.pid !== Number(pid)) {
    console.error(`shutdown refused reason=unsupported-idle-protocol port=${PORT} pid=${pid}; 保留现有进程`);
    process.exit(1);
  }
  const reply = await fetch(`http://127.0.0.1:${PORT}/admin/shutdown-if-idle`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000),
  });
  const result = await reply.json();
  if (!reply.ok || !result.ok) {
    console.error(`shutdown refused status=${reply.status} active=${result.activeRequests ?? "unknown"}; 保留现有进程`);
    process.exit(1);
  }
  console.log(`桥已接受空闲退出 pid=${pid}；无强杀`);
  for (let i = 0; i < 20; i++) {
    const h = await health();
    if (!h) break;
    if (h.pid !== Number(pid)) { console.log(`launcher 已接管 pid=${h.pid}`); process.exit(0); }
    if (i === 19) { console.error("shutdown pending; 不启动竞争实例、不强杀"); process.exit(1); }
    await new Promise(r => setTimeout(r, 100));
  }
}

const egress = readBridgeEgress(DATA);
const env = { ...process.env, PI_PORTABLE_DATA: DATA, PI_PORTABLE_HOME: HOME, CODEX_PROXY_PORT: String(PORT) };
if (runtime.accountHomes) env.CODEX_ACCOUNT_HOMES = runtime.accountHomes;
if (egress.mode === "proxy") { env.CODEX_UPSTREAM_PROXY_HOST = egress.host || "127.0.0.1"; env.CODEX_UPSTREAM_PROXY_PORT = String(egress.port); }
else delete env.CODEX_UPSTREAM_PROXY_PORT;

const errFd = fs.openSync(path.join(DATA, "bridge-stderr.log"), "a");
const child = spawn(process.execPath, [BRIDGE], { env, detached: true, stdio: ["ignore", "ignore", errFd], windowsHide: true });
fs.closeSync(errFd);
child.unref();
console.log(`已拉起 pi-portable 桥 pid ${child.pid} egress=${egress.mode || "direct"}${egress.port ? ":" + egress.port : ""}`);

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const h = await health();
  if (h?.ok) { console.log(`就绪：${JSON.stringify(h).slice(0, 300)}`); process.exit(0); }
}
console.log("10s 内未就绪，看 " + path.join(DATA, "bridge-stderr.log"));
process.exit(1);
