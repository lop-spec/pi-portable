// 硬重启契约:托盘"重启"必须是无条件彻底重启,不得退化成"开个窗口"。
// 覆盖三条真实踩过的坑:
//   1 junction 布局下 isMain 恒 false —— UI 代理静默 exit 0,launcher 判"未就绪"杀整树;
//   2 清场只认自家 children —— 僵死实例留下的孤儿活过重启,新实例撞端口起不来;
//   3 常驻形态 stdin 非 TTY —— ask() 永久挂起,进程活着却一件事不做。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { isDirectRun } from "../src/piweb-ui-proxy.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const launcher = fs.readFileSync(path.join(ROOT, "src", "launcher.mjs"), "utf8");

test("junction 布局下 UI 代理仍认得自己是主模块", { skip: process.platform !== "win32" }, () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hard-restart-"));
  const link = path.join(stage, "src");
  const mk = spawnSync("cmd.exe", ["/c", "mklink", "/J", link, path.join(ROOT, "src")], { windowsHide: true, encoding: "utf8" });
  if (mk.status !== 0) { fs.rmSync(stage, { recursive: true, force: true }); return; } // 无权建 junction 时跳过
  try {
    const viaJunction = path.join(link, "piweb-ui-proxy.mjs");
    assert.notEqual(
      path.resolve(viaJunction).toLowerCase(),
      path.resolve(path.join(ROOT, "src", "piweb-ui-proxy.mjs")).toLowerCase(),
      "前置条件:junction 路径必须与真实路径字面不同,否则本用例测不到回归",
    );
    assert.equal(isDirectRun(viaJunction, import.meta.url.replace("/tests/hard-restart-contract.mjs", "/src/piweb-ui-proxy.mjs")), true,
      "launcher 以 HOME/src 路径拉起 UI 代理时,isMain 必须为 true(否则进程静默 exit 0)");
    assert.equal(isDirectRun("", import.meta.url), false, "无 argv[1] 不算直跑");
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
});

test("UI 代理直跑判定不受盘符大小写与相对路径影响", () => {
  const self = new URL("../src/piweb-ui-proxy.mjs", import.meta.url);
  const real = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "src", "piweb-ui-proxy.mjs");
  assert.equal(isDirectRun(real, self.href), true);
  assert.equal(isDirectRun(real.toLowerCase(), self.href), true, "argv 盘符大小写不同不得判为非主模块");
  assert.equal(isDirectRun(path.join(ROOT, "src", "..", "src", "piweb-ui-proxy.mjs"), self.href), true, "含 .. 的等价路径必须判为主模块");
  assert.equal(isDirectRun(path.join(ROOT, "src", "launcher.mjs"), self.href), false, "别的脚本不得被判成本模块");
});

test("硬重启:清场覆盖跨实例台账、端口占用者与命令行指纹三层", () => {
  assert.match(launcher, /function sweepRuntime/, "缺全局清场函数");
  assert.match(launcher, /runtime-pids\.json/, "缺跨实例 pid 台账——僵死实例的孤儿将活过重启");
  assert.match(launcher, /function listPortOwners/, "缺端口占用者发现(netstat)");
  assert.match(launcher, /function listFingerprintPids/, "缺命令行指纹兜底");
  assert.match(launcher, /listPortOwners\(ports\)/, "清场必须按端口找占用者");
  assert.match(launcher, /let stubborn = \[\.\.\.wanted\]\.filter/, "缺进程存活确认——taskkill 报成功不等于进程已消失");
  assert.match(launcher, /plan\.roots\.flatMap/, "必须批量清理去重的进程树根，不能逐 PID 串行 taskkill");
  assert.match(launcher, /refusing to kill unowned port processes/, "端口号不能替代进程归属核验");
});

test("硬重启:新实例冷启,绝不复用残留实例", () => {
  assert.match(launcher, /function hardRestart/, "托盘重启必须走硬重启");
  assert.match(launcher, /c === "RESTART".*hardRestart\(\)/s, "托盘 RESTART 必须绑定 hardRestart");
  assert.match(launcher, /PI_FORCE_FRESH: "1"/, "硬重启拉起的新实例必须带冷启标记");
  assert.match(launcher, /PI_FORCE_FRESH === "1"[\s\S]{0,550}sweepRuntime/, "冷启没有可信清场交接时必须先清场");
  assert.match(launcher, /restart\?\.swept && !\(await Promise\.all\(restart\.ports\.map/, "跳过重复清场必须同时核验交接标记和端口为空");
  const shortCircuit = launcher.match(/if \(restart \|\| process\.env\.PI_FORCE_FRESH === "1"\)[\s\S]*?已被占用/);
  assert(shortCircuit, "「端口已占用就只开窗口」的短路必须排在冷启分支之后,否则重启退化成开窗口");
  assert(!/restartSelf/.test(launcher), "旧的半吊子 restartSelf 必须已被替换");
});

test("硬重启:桥端口只在本运行面拥有它时才清", () => {
  assert.match(launcher, /bridgeOwnedByUs/, "缺桥归属标记");
  assert.match(launcher, /bridgeOurs \? \[PORTS\.bridge\] : \[\]/, "不接管的生产桥不得被清场误杀");
});

test("manual restart survives native supervisor env and reopens the page without blocking on diagnostics", () => {
  assert.match(launcher, /saveRestartHandoff\(DATA,[\s\S]*supervisorPid:/);
  assert.match(launcher, /if \(restart\?\.openWindow\)[\s\S]*PI_AUTO_WINDOW = "1"[\s\S]*else if \(fs\.existsSync\(headlessMarker\)\)/);
  assert.match(launcher, /const runtimeCheck = spawn\(/, "只读诊断不能阻塞启动 UI");
  assert(launcher.indexOf("saveRestartHandoff(DATA") < launcher.indexOf("process.exit(NATIVE_RESTART_EXIT_CODE)"));
});

test("常驻形态下 ask() 不得挂起", () => {
  assert.match(launcher, /if \(!process\.stdin\.isTTY\)[\s\S]{0,260}Promise\.resolve\(""\)/,
    "stdin 非 TTY 时必须立即放弃提问,否则隐藏窗口启动会永久卡住");
});
