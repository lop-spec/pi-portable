// 异机无头验证:出口自适应 → 起桥 → /health → pi -p 一轮全链 → 回显 S6 日志。
// 不开窗口、不守窗;验证完杀桥退出。用法(异机):
//   runtime\node.exe tools\remote-verify.mjs "<测试 prompt>"
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectEgress } from "../src/egress-autodetect.mjs";

const HOME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(HOME, "data");
const NODE = path.join(HOME, "runtime", "node.exe");
const BRIDGE_PORT = 8794;
const log = (m) => console.log(`[verify] ${m}`);

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}
function httpBody(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (d) => { b += d; }); res.on("end", () => resolve(b));
    });
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
}

let extraPorts = [];
try { extraPorts = JSON.parse(fs.readFileSync(path.join(DATA, "egress-extra-ports.json"), "utf8")); } catch {}
const egress = await detectEgress(DATA, { extraPorts });
log(`egress: ${egress.mode}${egress.port ? " :" + egress.port : ""} (${egress.source || "probe"})`);

const bridgeEnv = { ...process.env, PI_PORTABLE_DATA: DATA, CODEX_PROXY_PORT: String(BRIDGE_PORT) };
if (egress.mode === "proxy") {
  bridgeEnv.CODEX_UPSTREAM_PROXY_HOST = egress.host || "127.0.0.1";
  bridgeEnv.CODEX_UPSTREAM_PROXY_PORT = String(egress.port);
}
let bridge = null;
if (!(await httpOk(`http://127.0.0.1:${BRIDGE_PORT}/health`))) {
  bridge = spawn(NODE, [path.join(HOME, "src", "bridge", "codex-responses-proxy.mjs")], {
    env: bridgeEnv, stdio: "ignore", windowsHide: true,
  });
  for (let i = 0; i < 20 && !(await httpOk(`http://127.0.0.1:${BRIDGE_PORT}/health`)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}
const health = await httpBody(`http://127.0.0.1:${BRIDGE_PORT}/health`);
log(`bridge health: ${health.slice(0, 160) || "FAIL"}`);
if (!health) { bridge?.kill(); process.exit(2); }

const prompt = process.argv[2] || "读取当前目录并说明里面有什么,一句话";
const piCli = path.join(HOME, "app", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const piEnv = {
  ...process.env, PI_PORTABLE_DATA: DATA, PI_PORTABLE_HOME: HOME,
  HOME: DATA, USERPROFILE: DATA, NO_PROXY: "localhost,127.0.0.1",
};
// 便携 node 进 PATH:pi 解析 "!node -p ..." 凭证命令依赖它(launcher.withPortableNode 同款)
const pathKey = Object.keys(piEnv).find((k) => k.toUpperCase() === "PATH") || "PATH";
piEnv[pathKey] = path.join(HOME, "runtime") + ";" + (piEnv[pathKey] || "");
log(`pi run: ${prompt}`);
const t0 = Date.now();
const pi = spawn(NODE, [piCli, "-p", "--no-session", prompt], {
  env: piEnv, cwd: DATA, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
pi.stdout.on("data", (d) => { out += d; });
pi.stderr.on("data", (d) => { out += d; });
const code = await new Promise((resolve) => {
  const t = setTimeout(() => { pi.kill(); resolve(-1); }, 240000);
  pi.on("exit", (c) => { clearTimeout(t); resolve(c); });
});
log(`pi exit=${code} ${(Date.now() - t0) / 1000}s`);
console.log("--- pi output (tail) ---");
console.log(out.split("\n").slice(-15).join("\n"));
console.log("--- lop-chain.log (tail) ---");
try { console.log(fs.readFileSync(path.join(DATA, "lop-chain.log"), "utf8").split("\n").slice(-12).join("\n")); }
catch (e) { console.log("no lop-chain.log: " + e.message); }
bridge?.kill();
process.exit(code === 0 ? 0 : 3);
