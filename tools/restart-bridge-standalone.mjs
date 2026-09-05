// 独立拉起 pi-portable 桥（8794）：launcher 熔断后或端口被旧桥抢占时的止血工具。
// 复刻 launcher 的桥环境（PI_PORTABLE_DATA / CODEX_PROXY_PORT / 出口代理），静默、分离、stderr 落盘。
// 用法：node restart-bridge-standalone.mjs [--kill-stale]   （--kill-stale 结束占着 8794 的旧 codex-responses-proxy.mjs 进程）
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const DATA = process.env.PI_PORTABLE_DATA || "C:/Users/lop/AppData/Local/pi-web/portable/data";
const PORT = Number(process.env.PI_BRIDGE_PORT || 8794);
const BRIDGE = path.join(HOME, "src", "bridge", "codex-responses-proxy.mjs");
const killStale = process.argv.includes("--kill-stale");

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
  const isPortable = /pi-portable[\\/]src[\\/]bridge/i.test(cmd);
  if (isPortable) { console.log(`8794 已是 pi-portable 桥 pid ${pid}，不动`); process.exit(0); }
  if (!isBridge) { console.log(`pid ${pid} 占用 ${PORT} 但不是桥，放弃：${cmd.slice(0, 120)}`); process.exit(1); }
  if (!killStale) { console.log(`pid ${pid} 是旧桥（${cmd.slice(0, 120)}），加 --kill-stale 才结束`); process.exit(1); }
  ps(`Stop-Process -Id ${pid} -Force`);
  console.log(`已结束旧桥 pid ${pid}`);
}

let egress = {};
try { egress = JSON.parse(fs.readFileSync(path.join(DATA, "egress.json"), "utf8")); } catch { /* 直连 */ }
const env = { ...process.env, PI_PORTABLE_DATA: DATA, PI_PORTABLE_HOME: HOME, CODEX_PROXY_PORT: String(PORT) };
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
