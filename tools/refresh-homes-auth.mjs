// 刷新指定 homes 根下各槽位（primary 除外）的 codex auth.json 访问令牌，复用桥内 account-pool 的刷新逻辑。
// 出口沿用当前便携数据根（CONNECT 代理）或直连。凭据只写回原文件，不打印。
// 用法：node refresh-homes-auth.mjs [homesRoot]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import tls from "node:tls";
import { createAccountPool } from "../src/bridge/account-pool.mjs";
import { readBridgeEgress, resolveBridgeRuntime } from "./bridge-runtime-paths.mjs";

const runtime = resolveBridgeRuntime(import.meta.url);
const homesInput = process.argv[2] || runtime.accountHomes;
if (!homesInput) throw new Error("未找到账号 homes；请传入路径或设置 CODEX_ACCOUNT_HOMES");
const homesRoot = path.resolve(homesInput);
const DATA = runtime.data;
if (!fs.existsSync(homesRoot)) throw new Error(`账号 homes 不存在：${homesRoot}`);
const egress = readBridgeEgress(DATA);

function connect(host) {
  if (egress.mode !== "proxy") {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] });
      s.once("secureConnect", () => resolve(s)); s.once("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: egress.host || "127.0.0.1", port: egress.port, method: "CONNECT", path: `${host}:443`, headers: { Host: `${host}:443` } });
    req.setTimeout(10000, () => req.destroy(new Error("CONNECT 超时")));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`CONNECT ${res.statusCode}`)); }
      const s = tls.connect({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
      s.once("secureConnect", () => resolve(s)); s.once("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

const scratch = path.join(DATA, "_历史版本");
fs.mkdirSync(scratch, { recursive: true });
const pool = createAccountPool({
  homesRoot,
  poolStateFile: path.join(scratch, "refresh-tool-pool-state.json"),
  pinStateFile: path.join(scratch, "refresh-tool-pin-state.json"),
  connect, log: (m) => console.log(m),
});
const before = pool.snapshot?.() ?? null;
const refreshed = await pool.refreshExpiring(365 * 24 * 60 * 60_000);
console.log("homesRoot", homesRoot, "refreshed", refreshed.join(",") || "(none)");
if (before) console.log("after", JSON.stringify(pool.snapshot()).slice(0, 400));
