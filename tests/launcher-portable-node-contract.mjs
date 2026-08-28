// 回归契约:便携启动器不得通过 npm .cmd 包装器或全局 node 启动 pi-web。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const source = fs.readFileSync(path.join(root, "src", "launcher.mjs"), "utf8");

assert.match(source, /pkg\.bin/, "pi-web 入口应从包清单 bin 字段解析");
assert.match(source, /spawn\(nodeExe, \[webEntry, "--no-open"\]/, "pi-web 必须由便携 nodeExe 直接启动");
assert.doesNotMatch(source, /node_modules["'], ["']\.bin|pi-web\.cmd/, "不得回退到 npm Windows 包装器");
assert.match(source, /PATH: \[path\.dirname\(nodeExe\), inheritedPath\]/, "子进程 PATH 应包含便携 Node 目录");
assert.match(source, /path\.join\(DATA, "pi-web\.log"\)/, "pi-web stdout/stderr 必须持久化");
assert.match(source, /function portableizeModelAuth\(\)/, "便携启动时必须迁移模型鉴权命令");
assert.match(source, /process\.env\.PI_PORTABLE_DATA,'auth\.json'/, "模型鉴权必须读取便携 data/auth.json");
assert.match(source, /function configurePortableBash\(\)/, "启动器必须配置非标准安装位置的 Git Bash");
assert.match(source, /"Programs", "Git", "bin", "bash\.exe"/, "启动器必须识别 Git for Windows 当前用户安装路径");

console.log("PASS launcher portable-node/auth/bash contract");
