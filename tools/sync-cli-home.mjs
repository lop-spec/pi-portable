// 同步 pi CLI home(~/.pi/agent/extensions)与仓库常驻扩展源。
// 2026-09-05 起常驻扩展:lop-pretool.ts(确定性工具前修复)、lop-followup.ts(默认关闭的追问模式)两份文件复制,
// 以及 browser-agent 目录 junction(浏览器工具,2026-09-05 lop 明确恢复;junction 单源,改仓即改 live)。
// 旧 lop-chain.ts / lop-swarm 已退役,本脚本不再创建,发现残留只报告不动手。
// 用法: node tools/sync-cli-home.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const AGENT_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const CLI_EXT = path.join(AGENT_HOME, "extensions");
const HISTORY = path.join(CLI_EXT, "_历史版本");
const RESIDENT = ["lop-pretool.ts", "extensions/lop-followup.ts"];
const RESIDENT_DIRS = ["browser-agent"];
const RETIRED = ["lop-chain.ts", "lop-swarm"];
const check = process.argv.includes("--check");

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
let changed = 0, same = 0;
fs.mkdirSync(CLI_EXT, { recursive: true });
for (const rel of RESIDENT) {
  const from = path.join(REPO_SRC, rel);
  const to = path.join(CLI_EXT, path.basename(rel));
  if (!fs.existsSync(from)) { console.error(`[sync-cli-home] 仓库源缺失: ${from}`); process.exitCode = 1; continue; }
  const src = fs.readFileSync(from);
  if (fs.existsSync(to) && Buffer.compare(src, fs.readFileSync(to)) === 0) { same++; console.log(`[sync-cli-home] 一致: ${path.basename(rel)}`); continue; }
  if (check) { changed++; console.log(`[sync-cli-home] 待更新: ${path.basename(rel)}`); continue; }
  if (fs.existsSync(to)) { fs.mkdirSync(HISTORY, { recursive: true }); fs.copyFileSync(to, path.join(HISTORY, `${path.basename(rel)}.${stamp()}.bak`)); }
  fs.writeFileSync(to, src); changed++;
  console.log(`[sync-cli-home] 已更新: ${to}`);
}
for (const name of RESIDENT_DIRS) {
  const from = path.join(REPO_SRC, name);
  const to = path.join(CLI_EXT, name);
  if (!fs.existsSync(path.join(from, "index.ts"))) { console.error(`[sync-cli-home] 仓库源缺失: ${from}`); process.exitCode = 1; continue; }
  const st = fs.lstatSync(to, { throwIfNoEntry: false });
  if (!st) {
    if (check) { changed++; console.log(`[sync-cli-home] 待创建 junction: ${name}`); continue; }
    fs.symlinkSync(from, to, "junction"); changed++;
    console.log(`[sync-cli-home] junction 创建: ${to} → ${from}`);
  } else if (st.isSymbolicLink() || fs.realpathSync(to).toLowerCase() !== to.toLowerCase()) {
    const target = fs.realpathSync(to);
    if (target.toLowerCase() !== fs.realpathSync(from).toLowerCase()) { console.error(`[sync-cli-home] junction 指向别处: ${to} → ${target};人工确认后再处理`); process.exitCode = 1; continue; }
    same++; console.log(`[sync-cli-home] junction 已就位: ${name}`);
  } else {
    console.error(`[sync-cli-home] ${to} 是真实目录而非 junction;为保护既有资产不自动覆盖,人工合并后重跑`); process.exitCode = 1;
  }
}
const leftovers = RETIRED.filter((n) => fs.existsSync(path.join(CLI_EXT, n)));
if (leftovers.length) console.log(`[sync-cli-home] 发现已退役残留(未处理,请手动移入 _历史版本): ${leftovers.join(", ")}`);
console.log(`[sync-cli-home] 完成 changed=${changed} same=${same} check=${check}`);
