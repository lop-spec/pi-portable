#!/usr/bin/env node
// 同步 pi CLI home(~/.pi/agent)与仓库链源,堵"手动 cp 只带 extensions 不带 src/chain"的盲区。
// 实录:2026-08-31 起 ~/.pi 只有 extensions 副本,S3/S8 每轮 Cannot find module lop-memory.mjs,
// CLI 与 best-of-n 候选会话完全没有历史注入,直到 2026-09-01 核查才暴露。
//
// 做法:
//   1) ~/.pi/agent/src → 仓库 src 的 junction(单源,改仓即改 CLI live;已是正确 junction 则跳过,
//      是真实目录则报错退出,不破坏用户既有资产)。
//   2) cp src/lop-chain.ts → ~/.pi/agent/extensions/lop-chain.ts(内容不同才覆盖,覆盖前留时间戳备份)。
// 幂等,可随时重跑:node tools/sync-cli-home.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SRC = path.join(ROOT, "src");
const AGENT_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const CLI_SRC = path.join(AGENT_HOME, "src");
const CLI_EXT = path.join(AGENT_HOME, "extensions");

function fail(message) {
  console.error(`[sync-cli-home] FAIL ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(REPO_SRC, "chain", "lop-memory.mjs"))) fail(`仓库链源缺失: ${REPO_SRC}`);
if (!fs.existsSync(CLI_EXT)) fail(`CLI home 不存在,先手动初始化: ${CLI_EXT}`);

// 1) junction ~/.pi/agent/src → repo src
const stat = fs.lstatSync(CLI_SRC, { throwIfNoEntry: false });
if (!stat) {
  fs.symlinkSync(REPO_SRC, CLI_SRC, "junction");
  console.log(`[sync-cli-home] junction 创建: ${CLI_SRC} → ${REPO_SRC}`);
} else if (stat.isSymbolicLink() || fs.realpathSync(CLI_SRC) !== CLI_SRC) {
  const target = fs.realpathSync(CLI_SRC);
  if (path.resolve(target) !== path.resolve(fs.realpathSync(REPO_SRC))) {
    fail(`已有 junction 指向别处: ${CLI_SRC} → ${target};人工确认后再处理`);
  }
  console.log(`[sync-cli-home] junction 已就位: ${CLI_SRC} → ${target}`);
} else {
  fail(`${CLI_SRC} 是真实目录而非 junction;为保护既有资产不自动覆盖,人工合并后重跑`);
}

// 2) extensions/lop-chain.ts 副本对齐(RUNTIME_DRIFT 靠此文件的版本串触发 live 重载)
const from = path.join(REPO_SRC, "lop-chain.ts");
const to = path.join(CLI_EXT, "lop-chain.ts");
const wanted = fs.readFileSync(from, "utf8");
const current = fs.existsSync(to) ? fs.readFileSync(to, "utf8") : "";
if (current === wanted) {
  console.log(`[sync-cli-home] lop-chain.ts 已一致,跳过`);
} else {
  if (current) {
    const backup = `${to}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-sync-cli-home`;
    fs.copyFileSync(to, backup);
    console.log(`[sync-cli-home] 旧副本备份: ${backup}`);
  }
  fs.writeFileSync(to, wanted, "utf8");
  console.log(`[sync-cli-home] lop-chain.ts 已更新: ${to}`);
}

// 读回验证:CLI 视角下链模块必须可达
const probe = path.join(CLI_SRC, "chain", "lop-memory.mjs");
if (!fs.existsSync(probe)) fail(`读回失败,链模块不可达: ${probe}`);
console.log(`[sync-cli-home] OK 链模块可达: ${probe}`);

// 3) extensions/browser-agent → 仓库 src/browser-agent 的 junction(单源;pi 按目录内 index.ts 装载)
const baFrom = path.join(REPO_SRC, "browser-agent");
const baTo = path.join(CLI_EXT, "browser-agent");
const baStat = fs.lstatSync(baTo, { throwIfNoEntry: false });
if (!baStat) {
  fs.symlinkSync(baFrom, baTo, "junction");
  console.log(`[sync-cli-home] junction 创建: ${baTo} → ${baFrom}`);
} else if (baStat.isSymbolicLink() || fs.realpathSync(baTo).toLowerCase() !== baTo.toLowerCase()) {
  const target = fs.realpathSync(baTo);
  if (target.toLowerCase() !== fs.realpathSync(baFrom).toLowerCase()) fail(`已有 junction 指向别处: ${baTo} → ${target};人工确认后再处理`);
  console.log(`[sync-cli-home] junction 已就位: ${baTo} → ${target}`);
} else {
  fail(`${baTo} 是真实目录而非 junction;为保护既有资产不自动覆盖,人工合并后重跑`);
}
