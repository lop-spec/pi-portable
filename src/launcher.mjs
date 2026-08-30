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
import { RULES_ASSET_LAYOUT, syncRulesSnapshot } from "./rules-snapshot.mjs";
import { withSilentWindowsProcessEnv } from "./windows-process-env.mjs";

const HOME = process.env.PI_PORTABLE_HOME || path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const DATA = process.env.PI_PORTABLE_DATA || path.join(HOME, "data");
const BLOB = path.join(HOME, "assets.enc");
const PORTS = { bridge: Number(process.env.PI_BRIDGE_PORT || 8794), web: Number(process.env.PI_WEB_PORT || 30141) };
const NODE = process.env.PI_NODE_EXE || path.join(HOME, "runtime", "node.exe");
const PROCESS_HOST = process.platform === "win32" && process.env.PI_PROCESS_HOST && fs.existsSync(process.env.PI_PROCESS_HOST)
  ? process.env.PI_PROCESS_HOST : "";
const NATIVE_RESTART_EXIT_CODE = 75;

function spawnPortableNode(nodeExe, args, options) {
  if (PROCESS_HOST) return spawn(PROCESS_HOST, ["--pi-node-host", ...args], options);
  return spawn(nodeExe, args, options);
}
// 加密资产段的布局契约(打包器必须按这些键写入,launcher 依赖它们):
//   .pi/agent/models.json|settings.json|AGENTS.md  pi 配置(HOME 被指向 DATA,故需前导点)
//   auth.json  codex 登录态文件(仅键名约定,不含内容) scan-allow: 布局契约键名,非凭证
//   rules-pretool.mjs                              S7 工具门私有规则(可选)
//   egress-extra-ports.json                        个人出口端口(可选,自适应优先探测)
//   rules.jsonl(旧包兼容键) / registry/bootstrap-rules.jsonl  只作为规则 bootstrap
//   anchors.jsonl / profile-anchors.json                        其它执行链数据面(可选)
// data/rules.jsonl 始终由 rules-snapshot 单向生成,不再由加密资产直接覆盖。
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

function configurePortableBash() {
  const settingsFile = path.join(DATA, ".pi", "agent", "settings.json");
  if (!fs.existsSync(settingsFile)) return null;
  const candidates = [
    process.env.PI_BASH_EXE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  const bash = candidates.find((candidate) => fs.existsSync(candidate));
  if (!bash) return null;
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  if (settings.shellPath && fs.existsSync(settings.shellPath)) return null;
  settings.shellPath = bash.replaceAll("\\", "/");
  const tmp = settingsFile + ".portable.tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, settingsFile);
  return settings.shellPath;
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

function refreshRulesSnapshot() {
  try {
    const rules = syncRulesSnapshot({
      dataRoot: DATA,
      upstreamSource: process.env.PI_RULES_SOURCE || null,
      upstreamLabel: process.env.PI_RULES_SOURCE_LABEL || undefined,
    });
    if (rules.skipped) log(`规则快照跳过:${rules.reason}`);
    else log(`规则快照${rules.changed ? "已生成" : "已是目标态"}(${rules.ruleCount} 条,${rules.sha256.slice(0, 12)},${rules.sourceKind})`);
    return rules;
  } catch (e) {
    log(`规则快照同步失败(保留上次已验证 rules.jsonl):${String(e.message).slice(0, 160)}`);
    return null;
  }
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
  const portableEnv = withSilentWindowsProcessEnv(withPortableNode(process.env, nodeExe));
  refreshRulesSnapshot(); // 已有实例也先收敛规则；运行中的扩展下一轮直接读取新生成物。
  if (await portAlive(PORTS.web)) {
    if (process.env.PI_HEADLESS === "1") log(`端口 ${PORTS.web} 已有实例,无头模式仅同步规则,不打开窗口`);
    else { log(`端口 ${PORTS.web} 已被占用——可能已有实例在跑,直接开窗口`); await openWindow(); }
    return;
  }

  // 2 解密资产(若有加密段)
  if (fs.existsSync(BLOB)) {
    try {
      let r;
      try { r = openAssets(BLOB, DATA, { layout: RULES_ASSET_LAYOUT }); }
      catch {
        log("首次启动:需要一次解密口令(之后本机免输)");
        const pw = await ask("口令: ", { silent: true });
        r = openAssets(BLOB, DATA, { password: pw, layout: RULES_ASSET_LAYOUT });
      }
      log(`资产就绪(${r.source === "cached" ? "本机密钥缓存" : "口令解密"},${r.ms}ms,${r.written.length} 项)`);
    } catch (e) {
      log("资产解密失败:" + String(e.message).slice(0, 120));
      log("口令错误或资产块损坏。删除 " + path.join(DATA, "key.dpapi") + " 可重输口令。");
      process.exit(2);
    }
  } else log("无加密资产段(base 版):使用本机已有配置");

  refreshRulesSnapshot(); // 首次从 legacy bootstrap 迁移后再生成一次。

  try {
    const changed = portableizeModelAuth();
    if (changed) log(`模型鉴权已便携化(${changed} 个 provider → data\\auth.json)`);
  } catch (e) { log(`模型鉴权便携化失败:${e.message}`); }
  try {
    const shellPath = configurePortableBash();
    if (shellPath) log(`Bash 已配置:${shellPath}`);
  } catch (e) { log(`Bash 配置失败:${e.message}`); }

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
  // 桥守护:stderr 落盘留崩因证据;桥退出(非收尾)自动重启,崩溃循环时熔断防空转。
  // 2026-08-29 异机实测:桥静默崩溃后 pi-web 独活,pi 全线 Connection error 且零日志——两个缺口都在这里补。
  const bridgeErrLog = path.join(DATA, "bridge-stderr.log");
  const bridgeRestarts = [];
  function startBridge() {
    const errFd = fs.openSync(bridgeErrLog, "a");
    let bridge;
    try {
      bridge = spawnPortableNode(nodeExe, [path.join(HOME, "src", "bridge", "codex-responses-proxy.mjs")], { env: bridgeEnv, stdio: ["ignore", "ignore", errFd], windowsHide: true });
    } finally { fs.closeSync(errFd); }
    children.push(bridge);
    bridge.once("exit", (code, signal) => {
      if (shuttingDown) return;
      const at = children.indexOf(bridge);
      if (at >= 0) children.splice(at, 1);
      log(`桥进程退出 code=${code ?? "-"} signal=${signal ?? "-"}(崩因见 ${bridgeErrLog})`);
      const now = Date.now();
      bridgeRestarts.push(now);
      while (bridgeRestarts.length && now - bridgeRestarts[0] > 60000) bridgeRestarts.shift();
      if (bridgeRestarts.length > 5) { log("桥 60s 内退出超 5 次,熔断自动重启(pi 可用其它 provider)"); return; }
      setTimeout(() => {
        if (shuttingDown) return;
        log("桥自动重启…");
        startBridge();
      }, 1000);
    });
    return bridge;
  }
  if (!(await portAlive(PORTS.bridge))) {
    startBridge();
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
    web = spawnPortableNode(nodeExe, [webEntry, "--no-open"], {
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

  // 6 托盘 + 窗口:托盘在则关窗驻留(单击托盘再进入,菜单可重启/彻底退出);托盘不可用回退关窗即退
  if (process.env.PI_HEADLESS === "1") { log("无头模式:不开窗口,等待终止信号"); setInterval(() => {}, 1 << 30); return; }
  const hasTray = startTray();
  if (!hasTray) log("无托盘:关闭窗口即彻底退出");
  // PI_AUTO_WINDOW=0:自启/常驻场景不自动弹窗,窗口由托盘"进入"按需打开(托盘不可用则忽略该档)
  if (process.env.PI_AUTO_WINDOW === "0" && hasTray) { log("自启模式:不自动开窗,单击托盘进入"); return; }
  await openWindow();
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

function browserCmd() {
  if (process.env.PI_BROWSER_CMD) {
    try { const c = JSON.parse(process.env.PI_BROWSER_CMD); if (Array.isArray(c) && c.length) return c; } catch {}
    log("PI_BROWSER_CMD 不是 JSON 数组,忽略");
  }
  const b = chromePath();
  return b ? [b] : null;
}

let windowProc = null;
async function openWindow() {
  const url = `http://127.0.0.1:${PORTS.web}/`;
  const cmd = browserCmd();
  if (!cmd) { log("未找到 Chrome/Edge,用默认浏览器打开"); spawnSync("cmd.exe", ["/c", "start", "", url], { windowsHide: true }); return; }
  // --user-data-dir 独立配置 → 独立应用身份,任务栏图标取 pi-web 自带 favicon/manifest 图标
  const profile = path.join(DATA, "browser-profile");
  const win = spawn(cmd[0], [...cmd.slice(1), `--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { stdio: "ignore", windowsHide: true });
  children.push(win);
  windowProc = win;
  log("窗口已打开");
  win.once("exit", () => {
    if (windowProc === win) windowProc = null;
    const at = children.indexOf(win);
    if (at >= 0) children.splice(at, 1);
    if (shuttingDown) return;
    if (trayAlive) log("窗口已关闭:驻留托盘(单击托盘图标重新进入)");
    else { log("窗口已关闭:无托盘,彻底退出"); shutdown(0); }
  });
}

// ── 托盘:pi 图标常驻,单击进入;菜单 打开/重启/彻底退出 ─────────
let trayAlive = false;
const trayRestarts = [];
function startTray() {
  if (process.env.PI_TRAY === "0") return false;
  let cmd = null;
  if (process.env.PI_TRAY_CMD) {
    try { const c = JSON.parse(process.env.PI_TRAY_CMD); if (Array.isArray(c) && c.length) cmd = c; } catch {}
    if (!cmd) { log("PI_TRAY_CMD 不是 JSON 数组,不起托盘"); return false; }
  } else {
    // 图标优先 lop 自绘 π 图标(assets/pi-web.ico,与桌面 lnk 同源);缺失回退 pi-web 包内 icon-192.png
    const icon = [
      path.join(HOME, "assets", "pi-web.ico"),
      path.join(HOME, "app", "node_modules", "@agegr", "pi-web", "public", "icons", "icon-192.png"),
    ].find((p) => fs.existsSync(p));
    cmd = ["powershell.exe", "-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass",
      "-File", path.join(HOME, "src", "tray.ps1"),
      "-Title", "Pi Web", "-ParentPid", String(process.pid),
      "-MenuOpen", "打开 Pi Web", "-MenuRestart", "重启", "-MenuExit", "彻底退出"];
    if (icon) cmd.push("-IconPng", icon);
  }
  let tray;
  const t0 = Date.now();
  try { tray = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
  catch (e) { log(`托盘启动失败:${e.message}`); return false; }
  children.push(tray);
  trayAlive = true;
  readline.createInterface({ input: tray.stdout }).on("line", (line) => {
    const c = line.trim();
    if (c === "READY") log(`托盘就绪(${Date.now() - t0}ms;单击进入,菜单:打开/重启/彻底退出)`);
    else if (c === "OPEN") { log("托盘:进入"); openWindow().catch((e) => log(`开窗失败:${e.message}`)); }
    else if (c === "RESTART") { log("托盘:重启"); restartSelf(); }
    else if (c === "EXIT") { log("托盘:彻底退出"); shutdown(0); }
  });
  tray.once("exit", () => {
    trayAlive = false;
    const at = children.indexOf(tray);
    if (at >= 0) children.splice(at, 1);
    if (shuttingDown) return;
    const now = Date.now();
    trayRestarts.push(now);
    while (trayRestarts.length && now - trayRestarts[0] > 60000) trayRestarts.shift();
    if (trayRestarts.length > 2) {
      log("托盘 60s 内退出超 2 次,放弃托盘,回退关窗即退语义");
      if (!windowProc) { log("窗口也已不在:直接彻底退出"); shutdown(0); }
      return;
    }
    log("托盘进程退出,1s 后重启…");
    setTimeout(() => { if (!shuttingDown) startTray(); }, 1000);
  });
  return true;
}

// ── 重启:杀本实例整棵树 → 端口释放后按原参数拉起新实例 ─────────
function restartSelf() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("重启:杀本实例进程树,拉起新实例…");
  for (const c of children) if (c?.pid) killTree(c.pid);
  (async () => {
    for (let i = 0; i < 20 && ((await portAlive(PORTS.web)) || (await portAlive(PORTS.bridge))); i++)
      await new Promise((r) => setTimeout(r, 500));
    if (process.env.PI_LAUNCH_SUPERVISOR === "1") {
      log(`端口已释放:交由原生宿主重启(exit ${NATIVE_RESTART_EXIT_CODE})`);
      process.exit(NATIVE_RESTART_EXIT_CODE);
    }
    try {
      const next = spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: "ignore", windowsHide: true, cwd: process.cwd(), env: { ...process.env },
      });
      next.unref();
      log(`新实例已拉起 pid=${next.pid}(后续日志见 launcher.log)`);
    } catch (e) { log(`新实例拉起失败:${e.message}`); }
    process.exit(0);
  })();
}

main().catch((e) => { log("启动失败:" + String(e.stack || e).slice(0, 400)); shutdown(1); });
