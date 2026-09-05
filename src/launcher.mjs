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
import { withSilentWindowsProcessEnv } from "./windows-process-env.mjs";
import { appendLineRotating } from "./log-rotate.mjs";
import { BRIDGE_REARM_MS, createBridgeGuard, describeBridgeExit } from "./bridge-guard.mjs";

const HOME = process.env.PI_PORTABLE_HOME || path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const DATA = process.env.PI_PORTABLE_DATA || path.join(HOME, "data");
const BLOB = path.join(HOME, "assets.enc");
const PORTS = {
  bridge: Number(process.env.PI_BRIDGE_PORT || 8794),
  web: Number(process.env.PI_WEB_PORT || 30141), // user-facing archive/UI proxy
  webInternal: Number(process.env.PI_WEB_INTERNAL_PORT || (Number(process.env.PI_WEB_PORT || 30141) - 1)),
  supervisor: Number(process.env.PI_RUN_SUPERVISOR_PORT || (Number(process.env.PI_WEB_PORT || 30141) + 1)),
};
const NODE = process.env.PI_NODE_EXE || path.join(HOME, "runtime", "node.exe");
const PROCESS_HOST = process.platform === "win32" && process.env.PI_PROCESS_HOST && fs.existsSync(process.env.PI_PROCESS_HOST)
  ? process.env.PI_PROCESS_HOST : "";
const NATIVE_RESTART_EXIT_CODE = 75;
// 仅防旧 assets.enc 把退役 rules.jsonl 写回活动根；launcher 不生成也不消费该 bootstrap。
const LEGACY_ASSET_LAYOUT = Object.freeze({ "rules.jsonl": path.join("registry", "bootstrap-rules.jsonl") });

function spawnPortableNode(nodeExe, args, options) {
  if (PROCESS_HOST) return spawn(PROCESS_HOST, ["--pi-node-host", ...args], options);
  return spawn(nodeExe, args, options);
}
// 加密资产段的布局契约(打包器必须按这些键写入,launcher 依赖它们):
//   .pi/agent/models.json|settings.json|AGENTS.md  pi 配置(HOME 被指向 DATA,故需前导点)
//   auth.json  codex 登录态文件(仅键名约定,不含内容) scan-allow: 布局契约键名,非凭证
//   rules-pretool.mjs                              旧包兼容键；当前单一真值在 .pi/agent/data
//   egress-extra-ports.json                        个人出口端口(可选,自适应优先探测)
// 旧 rules.jsonl/anchors/profile-anchors 仅可被旧资产解包保留，launcher 不再生成或消费。
const children = [];
let shuttingDown = false;

const log = (m) => {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${m}`;
  console.log(line);
  const written = appendLineRotating(path.join(DATA, "launcher.log"), line);
  if (!written.ok) console.error(`[launcher-log] ${written.error}`);
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

function syncManagedFollowupExtension() {
  const source = path.join(HOME, "src", "extensions", "lop-followup.ts");
  const extensionDir = path.join(DATA, ".pi", "agent", "extensions");
  const target = path.join(extensionDir, "lop-followup.ts");
  if (!fs.existsSync(source)) return { status: "source-missing", source, target };

  const wanted = fs.readFileSync(source, "utf8");
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current === wanted) return { status: "already-current", source, target };

  fs.mkdirSync(extensionDir, { recursive: true });
  let backup = null;
  if (current) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const historyDir = path.join(extensionDir, "_历史版本");
    fs.mkdirSync(historyDir, { recursive: true });
    backup = path.join(historyDir, `lop-followup.${stamp}.ts`);
    fs.copyFileSync(target, backup);
  }

  const tmp = `${target}.portable.tmp`;
  fs.writeFileSync(tmp, wanted, "utf8");
  fs.renameSync(tmp, target);
  if (fs.readFileSync(target, "utf8") !== wanted) throw new Error(`自动追问扩展读回不一致:${target}`);
  return { status: current ? "updated" : "installed", source, target, backup };
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
// 8794 上是不是一座活着的 pi-portable 桥（/health 回 ok + policyVersion）；外部替换的桥也算。
async function bridgeHealthy(port, timeout = 2000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.ok === true && typeof j.policyVersion === "string";
  } catch { return false; }
}
function ask(question, { silent = false } = {}) {
  // 常驻形态(wscript //B、计划任务、托盘自启)下 stdin 不是 TTY:readline 会永远等一个
  // 不可能到来的输入,进程就此活着但一件事都不做——外部只看到端口全空、托盘也没有,
  // 即"卡住"。非交互环境一律立刻放弃提问,交回上层走默认分支。
  if (!process.stdin.isTTY) {
    log(`非交互环境(stdin 非 TTY),跳过提问:${question.trim()}`);
    return Promise.resolve("");
  }
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
  try {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000, encoding: "utf8" });
    return r.status === 0 || /not found|找不到/i.test(String(r.stderr || ""));
  } catch { return false; }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ── 运行面台账:跨实例记录本运行面拉起过的 pid ───────────────────
// 只杀 children 数组是不够的——launcher 一旦僵死/被强杀,它的子进程就成了没人认领的
// 孤儿,继续占着端口;下一次"重启"看不见它们,新实例撞端口后整套起不来。台账把
// 归属关系落盘,任何一个新实例都能替前任收尸。
const LEDGER = path.join(DATA, "runtime-pids.json");
function readLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    return { entries: Array.isArray(raw?.entries) ? raw.entries : [], bridgeOwned: raw?.bridgeOwned === true };
  } catch { return { entries: [], bridgeOwned: false }; }
}
function writeLedger(ledger) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = LEDGER + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
    fs.renameSync(tmp, LEDGER);
  } catch {}
}
let bridgeOwnedByUs = false;
function ledgerRecord(pid, role) {
  if (!pid) return;
  const ledger = readLedger();
  ledger.entries = ledger.entries.filter((e) => e?.pid !== pid);
  ledger.entries.push({ pid, role, at: new Date().toISOString(), launcherPid: process.pid });
  if (ledger.entries.length > 64) ledger.entries = ledger.entries.slice(-64);
  ledger.bridgeOwned = bridgeOwnedByUs || ledger.bridgeOwned;
  writeLedger(ledger);
}
// 台账 + 自身 pid 一起登记:僵死的 launcher 本体同样要能被后来者杀掉。
function ledgerRecordSelf() { ledgerRecord(process.pid, "launcher"); }

// 端口占用者:netstat 零依赖解析,拿到的是"现在真的在监听"的 pid,比任何台账都硬。
function listPortOwners(ports) {
  const owners = new Set();
  try {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 8000, encoding: "utf8" });
    for (const line of String(r.stdout || "").split("\n")) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      if (!ports.includes(Number(m[1]))) continue;
      const pid = Number(m[2]);
      if (pid > 4) owners.add(pid);
    }
  } catch {}
  return [...owners];
}

// 命令行指纹:第三层兜底。台账丢失(数据根被清)且端口已被别的状态占住时,仍能按
// "属于本运行面的进程"精确定位。限定 HOME 前缀,绝不误伤别人的 node / powershell。
function listFingerprintPids() {
  if (process.platform !== "win32") return [];
  const script = [
    "$home_ = $env:PI_SWEEP_HOME;",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($home_.ToLower()) } |",
    "Where-Object { $_.CommandLine -match 'launcher\\.mjs|run-supervisor\\.mjs|tray\\.ps1|codex-responses-proxy|pi-web' } |",
    "ForEach-Object { $_.ProcessId }",
  ].join(" ");
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 15000, encoding: "utf8", env: { ...process.env, PI_SWEEP_HOME: HOME },
    });
    return String(r.stdout || "").split(/\r?\n/).map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 4 && n !== process.pid);
  } catch { return []; }
}

// 全局清场:台账 → 端口占用者 → 命令行指纹,三层都杀,再确认端口真的空了。
// 只清本运行面的东西:桥端口仅在本运行面拥有它时才动(不接管的生产桥不受影响)。
async function sweepRuntime({ reason = "sweep", keepSelf = true } = {}) {
  const ledger = readLedger();
  const bridgeOurs = bridgeOwnedByUs || ledger.bridgeOwned;
  const ports = [PORTS.web, PORTS.webInternal, PORTS.supervisor, ...(bridgeOurs ? [PORTS.bridge] : [])];
  const killed = new Set();
  const kill = (pid) => {
    if (!pid || killed.has(pid)) return;
    if (keepSelf && pid === process.pid) return;
    killed.add(pid);
    killTree(pid);
  };

  const wanted = new Set();
  for (const c of children) if (c?.pid) wanted.add(c.pid);
  for (const e of ledger.entries) { const p = Number(e?.pid); if (Number.isInteger(p) && p > 4) wanted.add(p); }
  for (const p of listPortOwners(ports)) wanted.add(p);
  if (keepSelf) wanted.delete(process.pid);
  for (const p of wanted) kill(p);

  // 进程存活确认:taskkill 报成功不等于进程已消失(子树深、句柄未释放都会滞后),而
  // "重启看起来没生效"正是从这种滞后开始的。逐轮复核到真死,中途补一次指纹扫描。
  for (let round = 0; round < 20; round++) {
    const alive = [...wanted].filter((p) => pidAlive(p));
    if (!alive.length) break;
    if (round === 3) for (const p of listFingerprintPids()) { wanted.add(p); kill(p); }
    for (const p of alive) { killed.delete(p); kill(p); }
    await new Promise((r) => setTimeout(r, 200));
  }
  const stubborn = [...wanted].filter((p) => pidAlive(p));

  // 端口释放确认:进程都死了不代表端口立刻可 bind,占用者也可能根本不在上面几层里。
  let free = false;
  for (let round = 0; round < 24; round++) {
    const stillListening = listPortOwners(ports);
    if (!stillListening.length) { free = true; break; }
    if (round === 4) for (const pid of listFingerprintPids()) kill(pid);
    for (const pid of stillListening) { killed.delete(pid); kill(pid); }
    await new Promise((r) => setTimeout(r, 250));
  }
  writeLedger({ entries: [], bridgeOwned: false });
  log(`清场(${reason}):杀 ${killed.size} 个进程,端口 ${ports.join("/")} ${free ? "已全部释放" : "仍有占用"}`
    + (stubborn.length ? `,顽固存活 ${stubborn.join(",")}` : ""));
  return { killed: [...killed], stubborn, free, ports };
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("退出中:杀进程树…");
  for (const c of children) if (c?.pid) killTree(c.pid);
  for (const e of readLedger().entries) if (e?.pid && e.pid !== process.pid) killTree(Number(e.pid));
  writeLedger({ entries: [], bridgeOwned: false });
  log("已退出");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  // 受管远端的数据根标记只禁止登录自启时弹窗，仍保留交互桌面的托盘与双击进入能力。
  // 真正的无头启动必须由调用方显式传 PI_HEADLESS=1；否则标记会让人工双击也静默退出。
  const headlessMarker = path.join(DATA, "headless.enabled");
  if (fs.existsSync(headlessMarker)) {
    process.env.PI_AUTO_WINDOW = "0";
    log("检测到受管启动标记:禁止首次自启弹窗;仅显式 PI_HEADLESS=1 才进入无头模式");
  }
  log(`pi-portable 启动 HOME=${HOME}${process.env.PI_HEADLESS === "1" ? " headless=1" : ""}`);

  // 1 自检
  if (!fs.existsSync(NODE) && !process.env.PI_NODE_EXE) log(`警告:未找到便携 node(${NODE}),将使用当前 node`);
  const nodeExe = fs.existsSync(NODE) ? NODE : process.execPath;
  const portableEnv = withSilentWindowsProcessEnv(withPortableNode(process.env, nodeExe));
  if (process.env.PI_FORCE_FRESH === "1") {
    // 硬重启拉起的冷启实例:残留一律不复用,先清场再起全套(否则会退化成"只开个窗口")。
    log("冷启:不复用任何残留实例,先做全局清场");
    await sweepRuntime({ reason: "cold-start" });
  } else if (await portAlive(PORTS.web)) {
    if (process.env.PI_HEADLESS === "1") log(`端口 ${PORTS.web} 已有实例,无头模式仅同步规则,不打开窗口`);
    else { log(`端口 ${PORTS.web} 已被占用——可能已有实例在跑,直接开窗口`); await openWindow(); }
    return;
  }
  ledgerRecordSelf();

  // 2 解密资产(若有加密段)
  if (fs.existsSync(BLOB)) {
    try {
      let r;
      try { r = openAssets(BLOB, DATA, { layout: LEGACY_ASSET_LAYOUT }); }
      catch {
        log("首次启动:需要一次解密口令(之后本机免输)");
        const pw = await ask("口令: ", { silent: true });
        r = openAssets(BLOB, DATA, { password: pw, layout: LEGACY_ASSET_LAYOUT });
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
  try {
    const shellPath = configurePortableBash();
    if (shellPath) log(`Bash 已配置:${shellPath}`);
  } catch (e) { log(`Bash 配置失败:${e.message}`); }
  try {
    const extension = syncManagedFollowupExtension();
    if (extension.status === "source-missing") log(`自动追问扩展源缺失,未安装:${extension.source}`);
    else log(`自动追问扩展:${extension.status} (${extension.target})`);
  } catch (e) { log(`自动追问扩展同步失败:${e.message}`); }

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
  // 退出后的处置由 bridge-guard 决策(可测试):健康桥在监听→接管看护;崩溃循环→熔断但 2 分钟后重探;否则重拉。
  // 2026-09-05 实录:外部脚本 Stop-Process 换桥后 launcher 连撞 5 次 EADDRINUSE 永久熔断,桥从此脱离守护。
  const bridgeGuard = createBridgeGuard();
  async function bridgeRearmCheck() {
    if (shuttingDown) return;
    const listening = await portAlive(PORTS.bridge);
    const healthy = listening && await bridgeHealthy(PORTS.bridge);
    const decision = bridgeGuard.rearm({ listening, healthy });
    if (decision.action === "adopt") { setTimeout(bridgeRearmCheck, decision.watchInMs); return; }
    if (decision.action === "wait") { log("桥守护:8794 有监听但 /health 不健康,继续等待"); setTimeout(bridgeRearmCheck, decision.retryInMs); return; }
    log("桥守护:8794 无人监听,重拉桥");
    startBridge();
  }
  function startBridge() {
    const errFd = fs.openSync(bridgeErrLog, "a");
    let bridge;
    try {
      bridge = spawnPortableNode(nodeExe, [path.join(HOME, "src", "bridge", "codex-responses-proxy.mjs")], { env: bridgeEnv, stdio: ["ignore", "ignore", errFd], windowsHide: true });
    } finally { fs.closeSync(errFd); }
    children.push(bridge);
    bridgeOwnedByUs = true; // 桥是本运行面起的 → 清场时才允许动 8794(不接管的生产桥不受影响)
    ledgerRecord(bridge.pid, "bridge");
    bridge.once("exit", (code, signal) => {
      if (shuttingDown) return;
      const at = children.indexOf(bridge);
      if (at >= 0) children.splice(at, 1);
      log(`桥进程退出 ${describeBridgeExit(code, signal)}(崩因见 ${bridgeErrLog})`);
      void (async () => {
        const healthy = await bridgeHealthy(PORTS.bridge);
        if (shuttingDown) return;
        const decision = bridgeGuard.decide({ healthy });
        if (decision.action === "adopt") {
          log(`桥守护:8794 已有健康桥在服务(外部替换),不重拉;每 ${Math.round(decision.watchInMs / 1000)}s 看护一次`);
          setTimeout(bridgeRearmCheck, decision.watchInMs);
          return;
        }
        if (decision.action === "break") {
          log(`桥 60s 内退出超 5 次,熔断自动重启;${Math.round(decision.retryInMs / 1000)}s 后重新探测(pi 可用其它 provider)`);
          setTimeout(bridgeRearmCheck, decision.retryInMs);
          return;
        }
        setTimeout(() => {
          if (shuttingDown) return;
          log("桥自动重启…");
          startBridge();
        }, decision.delayMs);
      })();
    });
    return bridge;
  }
  if (!(await portAlive(PORTS.bridge))) {
    startBridge();
    for (let i = 0; i < 20 && !(await httpOk(`http://127.0.0.1:${PORTS.bridge}/health`)); i++) await new Promise((r) => setTimeout(r, 500));
  } else {
    log(`8794 已有桥在服务(非本运行面所起),接管看护:每 ${Math.round(BRIDGE_REARM_MS / 1000)}s 探测一次,消失即重拉`);
    setTimeout(bridgeRearmCheck, BRIDGE_REARM_MS);
  }
  log(await httpOk(`http://127.0.0.1:${PORTS.bridge}/health`) ? `桥就绪 :${PORTS.bridge}` : `桥未就绪(继续,pi 可用其它 provider)`);

  // 5 起 pi-web
  // bash 工具预加载:pi 的 bash 工具是每次 `bash -c` 且继承进程 env,非交互 bash 会 source
  // $BASH_ENV。把 ssh 头/证据落盘等每轮重复生成的样板固化成 helper(assets/bash-prelude.sh),
  // 模型侧零 token。文件缺失只告警不阻断(失败路径必留痕)。
  const bashPrelude = path.join(HOME, "assets", "bash-prelude.sh");
  const bashPreludeEnv = fs.existsSync(bashPrelude) ? { BASH_ENV: bashPrelude.replace(/\\/g, "/") } : {};
  log(bashPreludeEnv.BASH_ENV ? `bash 预加载:${bashPreludeEnv.BASH_ENV}` : `bash 预加载缺失,跳过:${bashPrelude}`);
  const webEnv = {
    ...portableEnv, PI_PORTABLE_DATA: DATA, PI_PORTABLE_HOME: HOME,
    PI_CODING_AGENT_DIR: path.join(DATA, ".pi", "agent"),
    HOME: DATA, USERPROFILE: DATA, // pi 配置落在数据根(解密出的 pi/ 目录)
    PORT: String(PORTS.webInternal), NO_PROXY: "localhost,127.0.0.1",
    // 上下文水位门在 pi-web 上冻结复用几乎不生效(24h freeze 13 / frozen 1),裁剪收益被
    // 缓存 miss + 工具结果重读吃掉。lop-chain 侧已按便携运行面默认关,这里显式钉住口径;
    // 需要回滚只改这一处为 "1"(CLI 不受影响)。
    LOP_COMPACT_GUARD: "0",
    ...bashPreludeEnv,
  };
  const webLog = path.join(DATA, "pi-web.log");
  const { entry: webEntry, version: webVersion } = resolvePiWebEntry();
  // 起 pi-web 前先把产物补丁钉在位:npm 升级/异机重装会还原 .next 产物,脚本均幂等
  // (已打 => already-patched 零写入;版本/锚点不符 => exit≠0 零写入)。失败只告警,按现有产物继续。
  // 顺序硬约束:fold 在前,draft-persist 其次,interactions 再按当前 chunk 寻锚;
  // drop-auto/show-thinking/worktree-sessions 依次执行，conversation-nodes 保持链尾；不再应用隐藏
  // recovery、扩展消息或工具卡的补丁，模型上下文及工具过程对用户保持可见。
  // chunk 名指纹含当前 hash，乱序会污染 PWA 缓存。
  const piWebPkgRoot = path.join(HOME, "app", "node_modules", "@agegr", "pi-web");
  for (const patchName of ["patch-piweb-fold.mjs", "patch-piweb-draft-persist.mjs", "patch-piweb-interactions.mjs", "patch-piweb-drop-auto-thinking.mjs", "patch-piweb-show-thinking.mjs", "patch-piweb-worktree-sessions.mjs", "patch-piweb-conversation-nodes.mjs"]) {
    const patchScript = path.join(HOME, "tools", patchName);
    if (!fs.existsSync(patchScript)) { log(`pi-web 补丁脚本缺失,跳过:tools\\${patchName}`); continue; }
    const r = spawnSync(nodeExe, [patchScript, "--pkg", piWebPkgRoot], { windowsHide: true, timeout: 120000, encoding: "utf8" });
    const outLine = String(r.stdout || "").trim().split(/\r?\n/).pop() || "";
    // 成功路径必输出一行 JSON;exit 0 且零输出说明 main 根本没跑(如直跑判定失效),按未应用告警。
    if (r.status === 0 && outLine) log(`pi-web 补丁 ${patchName}:${outLine.slice(0, 400)}`);
    else log(`pi-web 补丁 ${patchName} 未应用(exit=${r.status ?? r.signal ?? "?"}):${(String(r.stderr || "").trim().split(/\r?\n/).pop() || outLine || "无输出").slice(0, 300)}——按现有产物继续启动`);
  }
  const webRestarts = [];
  let webExit = "";
  let web = null;
  function startWeb() {
    const webLogFd = fs.openSync(webLog, "a");
    try {
      web = spawnPortableNode(nodeExe, [webEntry, "--no-open"], {
        env: webEnv, stdio: ["ignore", webLogFd, webLogFd], windowsHide: true,
      });
    } finally { fs.closeSync(webLogFd); }
    children.push(web);
    ledgerRecord(web.pid, "web");
    web.once("error", (error) => { webExit = `启动错误:${error.message}`; log(`pi-web ${webExit}`); });
    web.once("exit", (code, signal) => {
      const exited = web;
      const at = children.indexOf(exited);
      if (at >= 0) children.splice(at, 1);
      webExit = `进程退出 code=${code ?? "-"} signal=${signal ?? "-"}`;
      if (shuttingDown) return;
      log(`pi-web ${webExit}`);
      const now = Date.now();
      webRestarts.push(now);
      while (webRestarts.length && now - webRestarts[0] > 60000) webRestarts.shift();
      if (webRestarts.length > 5) {
        log("pi-web 60s 内退出超 5 次,交回原生 launcher 重启整套运行面");
        shutdown(4);
        return;
      }
      setTimeout(() => {
        if (shuttingDown) return;
        webExit = "";
        log("pi-web 自动重启…");
        startWeb();
      }, 1000);
    });
    log(`pi-web 启动 @agegr/pi-web@${webVersion} (${path.relative(HOME, webEntry)})`);
    return web;
  }
  startWeb();
  for (let i = 0; i < 40 && !webExit && !(await httpOk(`http://127.0.0.1:${PORTS.webInternal}/`)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await httpOk(`http://127.0.0.1:${PORTS.webInternal}/`))) {
    log(`pi-web 未就绪(${webExit || "20 秒超时"}),详见 ${webLog}`);
    shutdown(3);
  }
  log(`pi-web 内部运行面就绪 :${PORTS.webInternal}`);

  // 6 会话归档 UI 透明代理：只处理归档/额度展示，其余请求字节流透传；不读取 prompt、
  // 不跟踪任务、不注入恢复消息，也不改变模型 Stop。自身崩溃仍由 launcher 熔断守护。
  const supervisorScript = path.join(HOME, "src", "piweb-ui-proxy.mjs");
  const supervisorErrLog = path.join(DATA, "piweb-ui-proxy-stderr.log");
  const supervisorRestarts = [];
  const supervisorEnv = {
    ...portableEnv,
    PI_PORTABLE_DATA: DATA,
    PI_PORTABLE_HOME: HOME,
    PI_CODING_AGENT_DIR: path.join(DATA, ".pi", "agent"),
    PI_WEB_PORT: String(PORTS.webInternal),
    PI_RUN_SUPERVISOR_PUBLIC_PORT: String(PORTS.web),
    PI_RUN_SUPERVISOR_PORT: String(PORTS.supervisor),
    NO_PROXY: "localhost,127.0.0.1",
  };
  function startRunSupervisor() {
    if (!fs.existsSync(supervisorScript)) {
      log(`会话 UI 代理缺失:${supervisorScript}`);
      return null;
    }
    const errFd = fs.openSync(supervisorErrLog, "a");
    let supervisor;
    try {
      supervisor = spawnPortableNode(nodeExe, [supervisorScript], {
        env: supervisorEnv, stdio: ["ignore", "ignore", errFd], windowsHide: true,
      });
    } finally { fs.closeSync(errFd); }
    children.push(supervisor);
    ledgerRecord(supervisor.pid, "supervisor");
    supervisor.once("exit", (code, signal) => {
      const at = children.indexOf(supervisor);
      if (at >= 0) children.splice(at, 1);
      if (shuttingDown) return;
      log(`会话 UI 代理退出 code=${code ?? "-"} signal=${signal ?? "-"}(详见 ${supervisorErrLog})`);
      const now = Date.now();
      supervisorRestarts.push(now);
      while (supervisorRestarts.length && now - supervisorRestarts[0] > 60000) supervisorRestarts.shift();
      if (supervisorRestarts.length > 5) {
        log("会话 UI 代理 60s 内退出超 5 次,交回原生 launcher 重启整套运行面");
        shutdown(5);
        return;
      }
      setTimeout(() => { if (!shuttingDown) startRunSupervisor(); }, 1000);
    });
    return supervisor;
  }
  if (!(await httpOk(`http://127.0.0.1:${PORTS.supervisor}/health`))) startRunSupervisor();
  for (let i = 0; i < 20 && !(await httpOk(`http://127.0.0.1:${PORTS.supervisor}/health`)); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await httpOk(`http://127.0.0.1:${PORTS.supervisor}/health`))) {
    log(`会话 UI 代理未就绪,详见 ${supervisorErrLog}`);
    shutdown(5);
  }
  for (let i = 0; i < 20 && !(await httpOk(`http://127.0.0.1:${PORTS.web}/`)); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await httpOk(`http://127.0.0.1:${PORTS.web}/`))) {
    log(`持久化 Web 代理未就绪 :${PORTS.web}`);
    shutdown(5);
  }
  log(`会话 UI 代理就绪 health=:${PORTS.supervisor} public=:${PORTS.web} upstream=:${PORTS.webInternal}`);

  // 7 托盘 + 窗口:托盘在则关窗驻留(单击托盘再进入,菜单可重启/彻底退出);托盘不可用回退关窗即退
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
  // 这是用户明确进入的 GUI；windowsHide:true 会让 Edge 进程存在但主窗口不可见。
  const win = spawn(cmd[0], [...cmd.slice(1), `--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { stdio: "ignore", windowsHide: false });
  children.push(win);
  ledgerRecord(win.pid, "window");
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
  ledgerRecord(tray.pid, "tray");
  trayAlive = true;
  readline.createInterface({ input: tray.stdout }).on("line", (line) => {
    const c = line.trim();
    if (c === "READY") log(`托盘就绪(${Date.now() - t0}ms;单击进入,菜单:打开/重启/彻底退出)`);
    else if (c === "OPEN") { log("托盘:进入"); openWindow().catch((e) => log(`开窗失败:${e.message}`)); }
    else if (c === "RESTART") { log("托盘:重启(无条件硬重启)"); hardRestart(); }
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

// ── 硬重启:无条件全局清场 → 端口确认释放 → 冷启新实例 ───────────
// 旧实现只杀 children 记录的 pid,任何孤儿(前一个僵死 launcher 留下的 pi-web / 监督器 /
// 托盘)都活过重启;新实例 main() 开头又有"端口已占用就只开个窗口"的短路,于是"重启"
// 静默退化成"开窗口",服务还是那套旧的甚至半死的。硬重启把这两处都堵死:
//   1 三层清场(children + 跨实例台账 + 端口占用者 + 命令行指纹),不依赖本进程记忆;
//   2 端口逐轮确认释放,不是等固定秒数就硬拉;
//   3 新实例带 PI_FORCE_FRESH=1,进门先清场,绝不复用任何残留实例。
function hardRestart() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("硬重启:全局清场中(台账+端口+指纹)…");
  (async () => {
    const swept = await sweepRuntime({ reason: "restart" });
    if (process.env.PI_LAUNCH_SUPERVISOR === "1") {
      log(`清场完成:交由原生宿主重启(exit ${NATIVE_RESTART_EXIT_CODE})`);
      process.exit(NATIVE_RESTART_EXIT_CODE);
    }
    try {
      const next = spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: "ignore", windowsHide: true, cwd: process.cwd(),
        env: { ...process.env, PI_FORCE_FRESH: "1" },
      });
      next.unref();
      log(`新实例已拉起 pid=${next.pid} 冷启=1 清场=${swept.killed.length}(后续日志见 launcher.log)`);
    } catch (e) { log(`新实例拉起失败:${e.message}`); }
    process.exit(0);
  })();
}

main().catch((e) => { log("启动失败:" + String(e.stack || e).slice(0, 400)); shutdown(1); });
