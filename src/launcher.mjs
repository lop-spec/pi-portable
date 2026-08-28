// pi-portable launcher:双击起全套,关闭杀整棵进程树彻底退出。
// 流程:自检 → 解密资产(首启口令/DPAPI 缓存)→ 出口自适应 → 起桥 → 起 pi-web → 开窗口 → 守窗退出
// 目录约定:HOME=解包根(含 runtime/ app/ chain/ bridge/),DATA=数据根(解密资产+日志+账本)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { detectEgress } from "./egress-autodetect.mjs";
import { openAssets } from "./assets-crypto.mjs";

const HOME = process.env.PI_PORTABLE_HOME || path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const DATA = process.env.PI_PORTABLE_DATA || path.join(HOME, "data");
const BLOB = path.join(HOME, "assets.enc");
const PORTS = { bridge: Number(process.env.PI_BRIDGE_PORT || 8794), web: Number(process.env.PI_WEB_PORT || 30141) };
const NODE = process.env.PI_NODE_EXE || path.join(HOME, "runtime", "node.exe");
// 加密资产段的布局契约(打包器必须按这些键写入,launcher 依赖它们):
//   .pi/agent/models.json|settings.json|AGENTS.md  pi 配置(HOME 被指向 DATA,故需前导点)
//   auth.json  codex 登录态文件(仅键名约定,不含内容) scan-allow: 布局契约键名,非凭证
//   rules-pretool.mjs                              S7 工具门私有规则(可选)
//   egress-extra-ports.json                        个人出口端口(可选,自适应优先探测)
//   rules.jsonl / anchors.jsonl / profile-anchors.json  执行链数据面(可选)
const children = [];
let shuttingDown = false;

const log = (m) => {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(path.join(DATA, "launcher.log"), line + "\n"); } catch {}
};

function withPortableNode(env, nodeExe) {
  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  const withoutPath = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"));
  return { ...withoutPath, PATH: [path.dirname(nodeExe), inheritedPath].filter(Boolean).join(path.delimiter) };
}

function resolvePiWebEntry() {
  const packageRoot = path.join(HOME, "app", "node_modules", "@agegr", "pi-web");
  const packageFile = path.join(packageRoot, "package.json");
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")); }
  catch (e) { throw new Error(`pi-web 包清单不可读(${packageFile}):${e.message}`); }
  const declaredBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["pi-web"];
  const candidates = [
    declaredBin && path.resolve(packageRoot, declaredBin),
    path.join(packageRoot, "dist", "server.js"), // 兼容早期发行布局
  ].filter(Boolean);
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (!entry) throw new Error(`pi-web JS 入口缺失(版本 ${pkg.version || "未知"}):${candidates.join(",")}`);
  return { entry, version: pkg.version || "未知" };
}

function portableizeModelAuth() {
  const modelsFile = path.join(DATA, ".pi", "agent", "models.json");
  const authFile = path.join(DATA, "auth.json");
  if (!fs.existsSync(modelsFile) || !fs.existsSync(authFile)) return 0;
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  let changed = 0;
  function rewriteCommands(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, current] of Object.entries(value)) {
      if (typeof current === "object") { rewriteCommands(current); continue; }
      if (typeof current !== "string" || !current.startsWith("!node -p")) continue;
      if (!current.includes("readFileSync") || !current.includes("auth.json")) continue;
      const token = current.match(/\.tokens\.(access_token|account_id)\b/)?.[1];
      if (!token || !auth?.tokens?.[token]) throw new Error(`便携 auth.json 缺少 tokens.${token || "?"}:${authFile}`);
      const portableCommand = `!node -p "JSON.parse(require('fs').readFileSync(require('path').join(process.env.PI_PORTABLE_DATA,'auth.json'),'utf8')).tokens.${token}"`;
      if (current !== portableCommand) { value[key] = portableCommand; changed++; }
    }
  }
  rewriteCommands(models.providers || {});
  if (changed) {
    const tmp = modelsFile + ".portable.tmp";
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2) + "\n");
    fs.renameSync(tmp, modelsFile);
  }
  return changed;
}

function portAlive(port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1", () => done(true));
  });
}
async function httpOk(url, timeout = 2000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(timeout) }); return r.ok; } catch { return false; }
}
function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (silent) {
      const onData = (ch) => { if (["\n", "\r", "\u0004"].includes(ch.toString())) process.stdin.removeListener("data", onData); };
      process.stdin.on("data", onData);
      rl._writeToOutput = function (s) { if (s.includes(question)) rl.output.write(question); else rl.output.write("*"); };
    }
    rl.question(question, (a) => { rl.close(); if (silent) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

// ── 关闭:杀整棵进程树 ─────────────────────────────────────────
function killTree(pid) {
  try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }); } catch {}
}
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("退出中:杀进程树…");
  for (const c of children) if (c?.pid) killTree(c.pid);
  // 兜底:清理本 launcher 占用的两个端口上的残留(仅限本次拉起的 pid,不误杀他人)
  log("已退出");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  log(`pi-portable 启动 HOME=${HOME}`);

  // 1 自检
  if (!fs.existsSync(NODE) && !process.env.PI_NODE_EXE) log(`警告:未找到便携 node(${NODE}),将使用当前 node`);
  const nodeExe = fs.existsSync(NODE) ? NODE : process.execPath;
  const portableEnv = withPortableNode(process.env, nodeExe);
  if (await portAlive(PORTS.web)) { log(`端口 ${PORTS.web} 已被占用——可能已有实例在跑,直接开窗口`); await openWindow(); return; }

  // 2 解密资产(若有加密段)
  if (fs.existsSync(BLOB)) {
    try {
      let r;
      try { r = openAssets(BLOB, DATA, {}); }
      catch {
        log("首次启动:需要一次解密口令(之后本机免输)");
        const pw = await ask("口令: ", { silent: true });
        r = openAssets(BLOB, DATA, { password: pw });
      }
      log(`资产就绪(${r.source === "cached" ? "本机密钥缓存" : "口令解密"},${r.ms}ms,${r.written.length} 项)`);
    } catch (e) {
      log("资产解密失败:" + String(e.message).slice(0, 120));
      log("口令错误或资产块损坏。删除 " + path.join(DATA, "key.dpapi") + " 可重输口令。");
      process.exit(2);
    }
  } else log("无加密资产段(base 版):使用本机已有配置");

  try {
    const changed = portableizeModelAuth();
    if (changed) log(`模型鉴权已便携化(${changed} 个 provider → data\\auth.json)`);
  } catch (e) { log(`模型鉴权便携化失败:${e.message}`); }

  // 3 出口自适应
  const egress = await detectEgress(DATA);
  if (egress.mode === "needsInput") {
    log("未找到可用出口(直连与常见代理端口均不通)");
    const p = await ask("请输入本机代理端口(如 7890,直接回车跳过): ");
    if (p) { egress.mode = "proxy"; egress.host = "127.0.0.1"; egress.port = Number(p); }
  }
  log(`出口:${egress.mode}${egress.port ? " :" + egress.port : ""}`);

  // 4 起桥
  const bridgeEnv = { ...portableEnv, PI_PORTABLE_DATA: DATA, CODEX_PROXY_PORT: String(PORTS.bridge) };
  if (egress.mode === "proxy") { bridgeEnv.CODEX_UPSTREAM_PROXY_HOST = egress.host || "127.0.0.1"; bridgeEnv.CODEX_UPSTREAM_PROXY_PORT = String(egress.port); }
  else delete bridgeEnv.CODEX_UPSTREAM_PROXY_PORT;
  if (!(await portAlive(PORTS.bridge))) {
    const bridge = spawn(nodeExe, [path.join(HOME, "src", "bridge", "codex-responses-proxy.mjs")], { env: bridgeEnv, stdio: "ignore", windowsHide: true });
    children.push(bridge);
    for (let i = 0; i < 20 && !(await httpOk(`http://127.0.0.1:${PORTS.bridge}/health`)); i++) await new Promise((r) => setTimeout(r, 500));
  }
  log(await httpOk(`http://127.0.0.1:${PORTS.bridge}/health`) ? `桥就绪 :${PORTS.bridge}` : `桥未就绪(继续,pi 可用其它 provider)`);

  // 5 起 pi-web
  const webEnv = {
    ...portableEnv, PI_PORTABLE_DATA: DATA, PI_PORTABLE_HOME: HOME,
    HOME: DATA, USERPROFILE: DATA, // pi 配置落在数据根(解密出的 pi/ 目录)
    PORT: String(PORTS.web), NO_PROXY: "localhost,127.0.0.1",
  };
  const webLog = path.join(DATA, "pi-web.log");
  const { entry: webEntry, version: webVersion } = resolvePiWebEntry();
  const webLogFd = fs.openSync(webLog, "w");
  let web;
  try {
    web = spawn(nodeExe, [webEntry, "--no-open"], {
      env: webEnv, stdio: ["ignore", webLogFd, webLogFd], windowsHide: true,
    });
  } finally { fs.closeSync(webLogFd); }
  children.push(web);
  let webExit = "";
  web.once("error", (e) => { webExit = `启动错误:${e.message}`; log(`pi-web ${webExit}`); });
  web.once("exit", (code, signal) => {
    webExit = `进程退出 code=${code ?? "-"} signal=${signal ?? "-"}`;
    if (!shuttingDown) log(`pi-web ${webExit}`);
  });
  log(`pi-web 启动 @agegr/pi-web@${webVersion} (${path.relative(HOME, webEntry)})`);
  for (let i = 0; i < 40 && !webExit && !(await httpOk(`http://127.0.0.1:${PORTS.web}/`)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await httpOk(`http://127.0.0.1:${PORTS.web}/`))) {
    log(`pi-web 未就绪(${webExit || "20 秒超时"}),详见 ${webLog}`);
    shutdown(3);
  }
  log(`pi-web 就绪 :${PORTS.web}`);

  // 6 开窗口并守护:窗口关闭 = 整体退出。PI_HEADLESS=1 时不开窗(自动化/无头场景),常驻至信号
  if (process.env.PI_HEADLESS === "1") { log("无头模式:不开窗口,等待终止信号"); setInterval(() => {}, 1 << 30); return; }
  await openWindow(true);
}

function chromePath() {
  for (const p of [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ]) if (fs.existsSync(p)) return p;
  return null;
}

async function openWindow(guard = false) {
  const url = `http://127.0.0.1:${PORTS.web}/`;
  const browser = chromePath();
  if (!browser) { log("未找到 Chrome/Edge,用默认浏览器打开"); spawnSync("cmd.exe", ["/c", "start", "", url], { windowsHide: true }); return; }
  // --user-data-dir 独立配置,窗口关闭进程即退出 → 可作为退出信号
  const profile = path.join(DATA, "browser-profile");
  const win = spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { stdio: "ignore" });
  children.push(win);
  log("窗口已打开" + (guard ? "(关闭窗口即彻底退出)" : ""));
  if (guard) win.on("exit", () => { log("窗口已关闭"); shutdown(0); });
}

main().catch((e) => { log("启动失败:" + String(e.stack || e).slice(0, 400)); shutdown(1); });
