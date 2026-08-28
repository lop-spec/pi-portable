// 出口自适应:换机第一难题(chatgpt.com 是否直连可达因网络环境而异)。
// 顺序:①已保存配置 ②直连探测 ③本机常见代理端口探测 ④返回 needsInput 由 UI 引导。
// 结果持久化到便携数据根,供 launcher 注入 CODEX_UPSTREAM_PROXY_PORT。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import tls from "node:tls";

const UPSTREAM_HOST = "chatgpt.com";
// 常见本机代理端口:Clash/Mihomo、v2rayN、Shadowsocks、Surge/Quantumult 等默认值。
// 自建/非标端口请用 extraPorts 传入,或在数据根放 egress-extra-ports.json(数字数组)。
const COMMON_PROXY_PORTS = [7890, 10809, 10808, 1080, 8080, 7897, 20171, 20172];
const PROBE_TIMEOUT = 4000;

export function configPath(dataRoot) { return path.join(dataRoot, "egress.json"); }

export function loadEgress(dataRoot) {
  try { return JSON.parse(fs.readFileSync(configPath(dataRoot), "utf8")); } catch { return null; }
}
export function saveEgress(dataRoot, cfg) {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(configPath(dataRoot), JSON.stringify({ ...cfg, at: new Date().toISOString() }, null, 2));
  return cfg;
}

export function probeDirect(timeout = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: UPSTREAM_HOST, port: 443, servername: UPSTREAM_HOST, ALPNProtocols: ["http/1.1"] });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once("secureConnect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export function probeProxy(port, host = "127.0.0.1", timeout = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method: "CONNECT", path: `${UPSTREAM_HOST}:443`, headers: { Host: `${UPSTREAM_HOST}:443` } });
    const done = (ok) => { try { req.destroy(); } catch {} resolve(ok); };
    req.setTimeout(timeout, () => done(false));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return done(false); }
      // CONNECT 通了还要确认能完成 TLS(有些代理只接受连接不转发)
      const secure = tls.connect({ socket, servername: UPSTREAM_HOST, ALPNProtocols: ["http/1.1"] });
      secure.setTimeout(timeout, () => { secure.destroy(); done(false); });
      secure.once("secureConnect", () => { secure.destroy(); done(true); });
      secure.once("error", () => done(false));
    });
    req.once("error", () => done(false));
    req.end();
  });
}

// 返回 {mode:"direct"|"proxy"|"needsInput", port, tried:[...]}
export async function detectEgress(dataRoot, { force = false, extraPorts = [] } = {}) {
  if (!force) {
    const saved = loadEgress(dataRoot);
    if (saved?.mode === "direct" && await probeDirect()) return { ...saved, source: "saved" };
    if (saved?.mode === "proxy" && await probeProxy(saved.port, saved.host || "127.0.0.1")) return { ...saved, source: "saved" };
  }
  const tried = [];
  if (await probeDirect()) { tried.push("direct:ok"); return saveEgress(dataRoot, { mode: "direct", port: 0, tried }); }
  tried.push("direct:fail");
  // 用户自定义端口优先(数据根 egress-extra-ports.json,便于自建/非标出口)
  let userPorts = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, "egress-extra-ports.json"), "utf8"));
    if (Array.isArray(parsed)) userPorts = parsed.filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  } catch { /* 未配置 */ }
  for (const port of [...extraPorts, ...userPorts, ...COMMON_PROXY_PORTS]) {
    if (await probeProxy(port)) { tried.push(`proxy:${port}:ok`); return saveEgress(dataRoot, { mode: "proxy", host: "127.0.0.1", port, tried }); }
    tried.push(`proxy:${port}:fail`);
  }
  return { mode: "needsInput", port: 0, tried };
}

// CLI:node egress-autodetect.mjs <dataRoot>
if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`) {
  const dataRoot = process.argv[2] || path.join(process.env.LOCALAPPDATA || ".", "pi-portable");
  const t0 = Date.now();
  const r = await detectEgress(dataRoot, { force: process.argv.includes("--force") });
  console.log(JSON.stringify({ ...r, elapsedMs: Date.now() - t0 }, null, 2));
  process.exit(r.mode === "needsInput" ? 1 : 0);
}
