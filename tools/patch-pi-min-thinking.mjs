// 推理强度下限=low(lop 2026-11-04):pi-ai 的 getSupportedThinkingLevels 对 reasoning 模型不再返回 off/minimal。
// pi-web 档位菜单、pi CLI(含 Shift+Tab 循环/设置选择器/--thinking)、会话恢复与 setThinkingLevel 的 clamp 都经这一个函数,
// 所以只改这一处:off/minimal 在 clamp 时自动上抬到 low。非 reasoning 模型仍返回 ["off"](无思考可选);
// 若某 reasoning 模型去掉 off/minimal 后一档都不剩,保持原列表,不制造空列表。
// 覆盖:pi-ai 源码副本(dist/models.js)与 pi CLI 打包副本(dist/bundle/**/*.js 里的压缩内联)。
// 幂等:已打=already-patched 零写入;锚点不符=exit 1 零写入。写入前经 backup.mjs 物理备份并读回校验。
// 用法:node patch-pi-min-thinking.mjs [--pkg <pi-web 包目录> | --sdk <pi-coding-agent 目录>] [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resolveSdk } from "./patch-pi-native-policy.mjs";

export const VERSION = "lop-min-thinking-v1";
const MARK = `/* ${VERSION} */`;
const FLOOR_DROP = ["off", "minimal"];
const ORIGINAL = /(export )?function getSupportedThinkingLevels\(model\)/g;
const CLAMP = /(export )?function clampThinkingLevel\(/g;

/** 返回改写后的源码;已打过原样返回;锚点数量不对抛错。 */
export function transform(before, label = "source") {
  if (before.includes(MARK)) return before;
  const originals = before.match(ORIGINAL) || [];
  const clamps = before.match(CLAMP) || [];
  if (originals.length !== 1) throw Error(`${label}: getSupportedThinkingLevels 定义命中 ${originals.length} 次(应为 1)`);
  if (clamps.length !== 1) throw Error(`${label}: clampThinkingLevel 定义命中 ${clamps.length} 次(应为 1)`);
  const exported = originals[0].startsWith("export ") ? "export " : "";
  const wrapper = `${MARK}${exported}function getSupportedThinkingLevels(model){const all=lopAllThinkingLevels(model);if(!model.reasoning)return all;const floor=all.filter(level=>!${JSON.stringify(FLOOR_DROP)}.includes(level));return floor.length?floor:all}\n`;
  return before
    .replace(ORIGINAL, "function lopAllThinkingLevels(model)")
    .replace(CLAMP, (m) => wrapper + m);
}

/** 源码副本:sdk 自带的与同级的 pi-ai;打包副本:sdk/dist/bundle 下含内联定义的 js。 */
export function targets(sdk) {
  const files = new Set();
  for (const root of [path.join(sdk, "node_modules/@earendil-works/pi-ai"), path.resolve(sdk, "../pi-ai")]) {
    const file = path.join(root, "dist/models.js");
    if (fs.existsSync(file)) files.add(fs.realpathSync(file));
  }
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && /function getSupportedThinkingLevels\(model\)/.test(fs.readFileSync(full, "utf8"))) files.add(fs.realpathSync(full));
    }
  };
  walk(path.join(sdk, "dist/bundle"));
  return [...files];
}

export function patchMinThinking(sdk, { check = false } = {}) {
  const files = targets(sdk);
  if (!files.length) throw Error("找不到 getSupportedThinkingLevels 的定义文件: " + sdk);
  const edits = files.map((file) => {
    const before = fs.readFileSync(file, "utf8");
    return { file, before, after: transform(before, file) };
  });
  const changed = edits.filter((e) => e.before !== e.after);
  for (const e of changed) { // 语法预检:写旁路临时 .mjs 做 --check,不导入
    const tmp = e.file + ".min-thinking-check-" + process.pid + ".mjs";
    try { fs.writeFileSync(tmp, e.after, { flag: "wx" }); execFileSync(process.execPath, ["--check", tmp], { windowsHide: true, stdio: "pipe" }); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  if (!check && changed.length) {
    const backup = fileURLToPath(new URL("./backup.mjs", import.meta.url));
    execFileSync(process.execPath, [backup, ...changed.map((e) => e.file), "--label", "min-thinking"], { windowsHide: true, stdio: "pipe" });
    for (const e of changed) {
      if (fs.readFileSync(e.file, "utf8") !== e.before) throw Error("Concurrent SDK update: " + e.file);
      const staged = e.file + ".min-thinking-stage-" + process.pid;
      try {
        fs.writeFileSync(staged, e.after, { flag: "wx" });
        fs.renameSync(staged, e.file);
        if (fs.readFileSync(e.file, "utf8") !== e.after) throw Error("Readback mismatch: " + e.file);
      } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
    }
  }
  return { version: VERSION, status: changed.length ? (check ? "pending" : "patched") : "already-patched", files: edits.length, changed: changed.length, sdk };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const i = process.argv.indexOf("--sdk"), j = process.argv.indexOf("--pkg");
    const sdk = i >= 0 ? fs.realpathSync(process.argv[i + 1]) : resolveSdk(j >= 0 ? process.argv[j + 1] : path.join(process.env.PI_PORTABLE_HOME || ".", "app/node_modules/@agegr/pi-web"));
    console.log(JSON.stringify(patchMinThinking(sdk, { check: process.argv.includes("--check") })));
  } catch (error) { console.error("[min-thinking] " + error.message); process.exitCode = 1; }
}
