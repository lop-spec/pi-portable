// 回归契约:便携启动器不得通过 npm .cmd 包装器或全局 node 启动 pi-web。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const source = fs.readFileSync(path.join(root, "src", "launcher.mjs"), "utf8");

assert.match(source, /pkg\.bin/, "pi-web 入口应从包清单 bin 字段解析");
assert.match(source, /spawnPortableNode\(nodeExe, \[webEntry, "--no-open"\]/, "pi-web 必须由原生进程宿主拉起便携 nodeExe");
assert.doesNotMatch(source, /node_modules["'], ["']\.bin|pi-web\.cmd/, "不得回退到 npm Windows 包装器");
assert.match(source, /PATH: \[path\.dirname\(nodeExe\), inheritedPath\]/, "子进程 PATH 应包含便携 Node 目录");
assert.match(source, /withSilentWindowsProcessEnv\(withPortableNode\(process\.env, nodeExe\)\)/, "pi-web 环境必须启用 MSYS ConPTY，阻止 Bash 原生子进程弹控制台");
assert.match(source, /path\.join\(DATA, "pi-web\.log"\)/, "pi-web stdout/stderr 必须持久化");
assert.match(source, /function startWeb\(\)/, "pi-web 必须由 launcher 守护并可原位重启");
assert.match(source, /pi-web 自动重启/u, "pi-web 异常退出必须自动重启");
assert.match(source, /fs\.openSync\(webLog, "a"\)/, "pi-web 重启不得覆盖既有退出日志");
assert.match(source, /path\.join\(HOME, "src", "piweb-ui-proxy\.mjs"\)/, "launcher 必须启动透明会话 UI 代理");
assert.match(source, /PI_RUN_SUPERVISOR_PORT/, "UI 代理健康端口必须显式传递");
assert.match(source, /PI_RUN_SUPERVISOR_PUBLIC_PORT/, "用户入口端口必须显式传递给 UI 代理");
assert.match(source, /webInternal/u, "Pi Web 上游必须与用户入口端口分离，以保留归档 UI 代理");
assert.match(source, /PI_CODING_AGENT_DIR/u, "便携运行必须显式固定 agent 数据目录");
assert.match(source, /会话 UI 代理 60s 内退出超 5 次/u, "UI 代理崩溃循环必须熔断");
assert.doesNotMatch(source, /run-supervisor\.mjs|recovery-dispatched|prompt-intent/u, "launcher 不得恢复会话级监督或 prompt 捕获");
assert.match(source, /function portableizeModelAuth\(\)/, "便携启动时必须迁移模型鉴权命令");
assert.match(source, /process\.env\.PI_PORTABLE_DATA,'auth\.json'/, "模型鉴权必须读取便携 data/auth.json");
assert.match(source, /function configurePortableBash\(\)/, "启动器必须配置非标准安装位置的 Git Bash");
assert.match(source, /"Programs", "Git", "bin", "bash\.exe"/, "启动器必须识别 Git for Windows 当前用户安装路径");
assert.match(source, /path\.join\(DATA, "headless\.enabled"\)/, "受管远端必须能通过数据根标记无窗常驻");
assert.match(source, /function syncManagedFollowupExtension\(\)/, "启动器必须同步用户主动开启的自动追问扩展");
assert.match(source, /自动追问扩展源缺失,未安装/u, "扩展同步失败必须留下无条件启动日志");
assert.equal(fs.existsSync(path.join(root, "src", "extensions", "lop-followup.ts")), true, "发行源码层必须包含默认关闭的自动追问扩展");
assert.doesNotMatch(source, /syncRulesSnapshot|refreshRulesSnapshot/u, "启动器不得继续生成已退役规则快照");
assert.doesNotMatch(source, /patch-piweb-hide-recovered|patch-piweb-hide-hidden-extension-messages/u, "启动器不得重新应用隐藏控制消息的 UI 补丁");

console.log("PASS launcher portable-node/auth/bash/ui-proxy contract");
