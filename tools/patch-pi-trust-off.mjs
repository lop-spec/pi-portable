#!/usr/bin/env node
// 关闭 pi / pi-web 的项目信任门（lop 明确要求：任何机器、任何目录都不再被信任校验拦住）。
//
// 背景：SDK 的 hasTrustRequiringProjectResources() 会从 cwd 逐级向上找 `.agents/skills`，
// 只排除 process.env.HOME 下的那一个。pi-portable 的 launcher 把子进程 HOME 改写成了数据根
// (launcher.mjs: `HOME: DATA, USERPROFILE: DATA`)，于是用户自己的 C:\Users\<u>\.agents\skills
// 反而被当成「项目祖先里的第三方代码」，任意项目都判定 requiresTrust=true；trust.json 又没有
// 记录 → 受限模式 → 发送类 API 全部 403。
//
// 取舍：本补丁让判定恒为 false，等价于「全部项目视为可信」，项目级 .pi/extensions、.pi/skills、
// .agents/skills 会像信任后一样被加载执行。这是显式降级，仅用于本人自有机器。
// 数据面的 trust.json 不受影响（留着也不会再被读到）。
//
// 用法: node patch-pi-trust-off.mjs [--pkg <pi-web包目录>] [--sdk <sdk目录>]... [--backup <目录>] [--check] [--revert]
// 约束: 锚点命中 0 处 => 中止且零写入；幂等可重入；改的是服务端代码，重启 pi-web 即生效（不涉及浏览器缓存）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__piTrustOffV1";
const ANCHOR = /function hasTrustRequiringProjectResources\(([\w$]*)\)\s*\{/g;

/** 在函数体最前面插入 return false —— 不必解析函数体的括号配对，最小且可逆。 */
export function disableTrustGate(src, label = "bundle") {
  if (src.includes(MARK)) return { out: src, applied: false, hits: 0 };
  const hits = [...src.matchAll(ANCHOR)].length;
  if (hits === 0) return { out: src, applied: false, hits: 0 };
  const out = src.replace(ANCHOR, (all) => `${all}/*${MARK}*/return false;`);
  return { out, applied: true, hits };
}

function collectJsFiles(dir) {
  const files = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) files.push(p);
    }
  })(dir);
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const argAll = (n) => args.reduce((acc, a, i) => (a === n && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
  const CHECK = args.includes("--check");
  const REVERT = args.includes("--revert");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-pi-trust-off"));
  const die = (m) => { console.error("[ABORT] " + m); process.exit(1); };

  const sdkDirs = argAll("--sdk");
  if (sdkDirs.length === 0) {
    // pi-web 自带的 SDK；异机布局不同就显式传 --sdk。
    for (const candidate of [
      path.join(PKG, "node_modules", "@earendil-works", "pi-coding-agent"),
      path.join(path.dirname(path.dirname(PKG)), "@earendil-works", "pi-coding-agent"),
    ]) {
      if (fs.existsSync(path.join(candidate, "package.json"))) sdkDirs.push(candidate);
    }
  }
  if (sdkDirs.length === 0) die("找不到 @earendil-works/pi-coding-agent，请用 --sdk 指定");

  if (REVERT) {
    if (!fs.existsSync(BACKUP)) die("备份目录不存在: " + BACKUP);
    const restored = [];
    for (const [index, sdk] of sdkDirs.entries()) {
      const root = path.join(BACKUP, `sdk${index}`);
      if (!fs.existsSync(root)) continue;
      (function walk(d) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) { walk(p); continue; }
          const rel = path.relative(root, p);
          fs.copyFileSync(p, path.join(sdk, rel));
          restored.push(rel);
        }
      })(root);
    }
    console.log(JSON.stringify({ status: "reverted", sdkDirs, restored, note: "重启 pi-web 后生效" }, null, 1));
    process.exit(0);
  }

  const edits = [];
  let alreadyPatched = 0;
  for (const [index, sdk] of sdkDirs.entries()) {
    const dist = path.join(sdk, "dist");
    if (!fs.existsSync(dist)) die("SDK 缺少 dist 目录: " + sdk);
    for (const file of collectJsFiles(dist)) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes(MARK)) { alreadyPatched += 1; continue; }
      const result = disableTrustGate(src, path.basename(file));
      if (!result.applied) continue;
      edits.push({ sdkIndex: index, sdk, file, hits: result.hits, out: result.out });
    }
  }

  const summary = {
    status: CHECK ? "check-ok" : "patched",
    sdkDirs,
    alreadyPatchedFiles: alreadyPatched,
    edits: edits.map((e) => ({ file: path.relative(e.sdk, e.file), hits: e.hits })),
    backup: BACKUP,
  };

  if (edits.length === 0) {
    console.log(JSON.stringify({ ...summary, status: alreadyPatched > 0 ? "already-patched" : "no-anchor" }, null, 1));
    process.exit(alreadyPatched > 0 ? 0 : 1);
  }
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }

  for (const edit of edits) {
    const dst = path.join(BACKUP, `sdk${edit.sdkIndex}`, path.relative(edit.sdk, edit.file));
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(edit.file, dst);
    }
    fs.writeFileSync(edit.file, edit.out);
  }
  console.log(JSON.stringify(summary, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
