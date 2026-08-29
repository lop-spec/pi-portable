// 托盘契约:tray.ps1 与 launcher.mjs 的行协议一致;ps1 纯 ASCII(PS 5.1 按 ANSI 解析);
// Windows 上 SelfTest 实跑验证程序集加载与 NotifyIcon 构造。
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const PS1 = path.join(ROOT, "src", "tray.ps1");

test("tray.ps1 与 launcher 协议契约", () => {
  const raw = fs.readFileSync(PS1);
  for (let i = 0; i < raw.length; i++) assert(raw[i] < 0x80, `tray.ps1 必须纯 ASCII(偏移 ${i} 处 0x${raw[i].toString(16)}):中文文案走 argv 传参`);
  const ps1 = raw.toString("utf8");
  const launcher = fs.readFileSync(path.join(ROOT, "src", "launcher.mjs"), "utf8");
  for (const tok of ["READY", "OPEN", "RESTART", "EXIT"]) {
    assert(ps1.includes(`"${tok}"`), `tray.ps1 缺协议 ${tok}`);
    assert(launcher.includes(`"${tok}"`), `launcher.mjs 缺 ${tok} 解析`);
  }
  assert(launcher.includes("PI_TRAY"), "launcher 缺 PI_TRAY 开关");
  assert(launcher.includes("assets") && launcher.includes("pi-web.ico"), "托盘图标必须优先 lop 自绘 assets/pi-web.ico");
  assert(launcher.includes("icon-192.png"), "缺 pi-web 包内 icon-192.png 图标回退");
  assert(ps1.includes(".ico"), "tray.ps1 缺 .ico 直载分支");
  assert(launcher.includes("PI_AUTO_WINDOW"), "launcher 缺 PI_AUTO_WINDOW 自启档");
  assert(fs.existsSync(path.join(ROOT, "assets", "pi-web.ico")), "assets/pi-web.ico 缺失");
  assert(launcher.includes("-MenuOpen"), "中文菜单文本必须由 launcher argv 传入");
});

test("tray.ps1 SelfTest 实跑(Windows)", { skip: process.platform !== "win32" }, () => {
  const r = spawnSync("powershell.exe",
    ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", PS1, "-SelfTest"],
    { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.strictEqual(r.status, 0, `exit=${r.status} stderr=${(r.stderr || "").slice(0, 300)}`);
  assert(r.stdout.split(/\r?\n/).includes("READY"), `stdout=${r.stdout}`);
});
