#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：从 thinking 档位下拉中删除 "auto"（=chat.thinkingUseDefault）。
// 背景(2026-09-01 lop 裁决): 推理强度完全由会话控制。auto 档把请求强度回退到全局
// defaultThinkingLevel(当前 low),与会话按模型钉的 max 相互打架——8794 桥日志实测
// 同一窗口混出 high→max 81 次 + low→max 21 次。桥侧已同轮撤销强制 max(v7.15.0),
// 若保留 auto 档,误选后请求会以 low 直发。删除选项即从源头收口。
// 已处于 auto 的存量会话不受影响(状态值仍可显示,只是不可再选)。
//
// 原理: 档位枚举编译为字面量数组 ["auto","off",...,"max"],client chunk 与
// server/app/page.js 各出现一次;把 "auto" 从数组里去掉,i18n 映射表保留不动。
//
// 用法: node patch-piweb-drop-auto-thinking.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；锚点命中数不符 => 中止且零写入；幂等可重入（已打则 already-patched）。
// 顺序: 链尾(在 fold/draft/interactions/hide-thinking/hide-recovered 之后)。chunk 名
//       指纹含当前 chunk hash,上游补丁改名后本补丁自动换名重打。
// 回滚: --revert 按备份目录整体拷回；新 chunk 文件保留（已无引用,孤儿无害）；重启 pi-web。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwDropAutoThinkingV1";
// 参与 chunk 名指纹。需要强制客户端丢弃旧缓存时 bump 这个值。
export const PATCH_REVISION = "r1";

const ANCHOR = '["auto","off","minimal","low","medium","high","xhigh","max"]';
const REPLACEMENT = '["off","minimal","low","medium","high","xhigh","max"]';

export function applyDropAutoThinking(src, label = "bundle", { browserMark = false } = {}) {
  if (src.includes(MARK)) return { out: src, applied: false };
  const hits = src.split(ANCHOR).length - 1;
  if (hits !== 1) {
    throw new Error(`${label}: thinking 档位枚举锚点命中 ${hits} 次(期望1)，拒绝写入`);
  }
  // 锚点是表达式上下文里的数组字面量,标记语句只能追加到文件尾(独立语句上下文)。
  const marker = browserMark
    ? `\n;typeof window<"u"&&(window.${MARK}=!0);`
    : `\n/*${MARK}*/`;
  const out = src.replace(ANCHOR, REPLACEMENT) + marker;
  return { out, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-drop-auto"));

  const VERSION = "0.8.11";
  const die = (m) => { console.error("[ABORT] " + m); process.exit(1); };

  const pkgJsonPath = path.join(PKG, "package.json");
  if (!fs.existsSync(pkgJsonPath)) die("包目录不存在: " + PKG);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.version !== VERSION) die(`package version ${pkgJson.version} != ${VERSION}，拒绝执行`);

  if (args.includes("--revert")) {
    if (!fs.existsSync(BACKUP)) die("备份目录不存在: " + BACKUP);
    const restored = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const rel = path.relative(BACKUP, p);
        fs.copyFileSync(p, path.join(PKG, rel));
        restored.push(rel);
      }
    })(BACKUP);
    console.log(JSON.stringify({
      status: "reverted", pkg: PKG, restored,
      note: "打补丁生成的新 chunk 文件保留（已无引用，孤儿无害）；重启 pi-web 后生效",
    }, null, 1));
    process.exit(0);
  }

  // 当前生效的 page chunk 以 server 侧引用为准（上游补丁链已改过名）
  const manifest = path.join(PKG, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("找不到 page_client-reference-manifest.js");
  const refHashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/g)].map((m) => m[1]),
  )];
  if (refHashes.length !== 1) die(`page chunk 引用解析异常: ${JSON.stringify(refHashes)}`);
  const CUR_HASH = refHashes[0];
  if (CUR_HASH.length < 8) die(`page chunk hash 过短，无法安全改名: ${CUR_HASH}`);

  const chunkDir = path.join(PKG, ".next", "static", "chunks", "app");
  const curChunk = path.join(chunkDir, `page-${CUR_HASH}.js`);
  const pageServer = path.join(PKG, ".next", "server", "app", "page.js");
  if (!fs.existsSync(curChunk)) die("当前 page chunk 不存在: " + curChunk);
  if (!fs.existsSync(pageServer)) die("server page.js 不存在: " + pageServer);
  const clientSrc = fs.readFileSync(curChunk, "utf8");
  const serverSrc = fs.readFileSync(pageServer, "utf8");

  if (clientSrc.includes(MARK) && serverSrc.includes(MARK)) {
    console.log(JSON.stringify({ status: "already-patched", pkg: PKG, chunk: path.basename(curChunk) }));
    process.exit(0);
  }

  let client, server;
  try {
    client = applyDropAutoThinking(clientSrc, "client", { browserMark: true });
    server = applyDropAutoThinking(serverSrc, "server-page");
  } catch (error) { die(error instanceof Error ? error.message : String(error)); }

  // chunk 名指纹 = 当前 chunk hash + 本补丁代码：上游链一换名，本补丁产物名自动跟着换；
  // 本补丁代码一变 URL 也变。绝不同名换内容（SW 对 /_next/static 是 cacheFirst）。
  const patchFingerprint = crypto.createHash("sha1")
    .update(CUR_HASH).update(":")
    .update(PATCH_REVISION).update(":")
    .update(applyDropAutoThinking.toString())
    .digest("hex");
  const NEW_HASH = client.applied ? ("pwa" + patchFingerprint).slice(0, CUR_HASH.length) : CUR_HASH;

  const newChunk = path.join(chunkDir, `page-${NEW_HASH}.js`);
  if (CUR_HASH !== NEW_HASH && fs.existsSync(newChunk) && !fs.readFileSync(newChunk, "utf8").includes(MARK)) {
    die(`目标 chunk 已存在且不是本补丁产物，拒绝覆盖: ${newChunk}`);
  }

  // 引用替换覆盖 server/app 全树 + 根 manifest
  const refEdits = [];
  if (CUR_HASH !== NEW_HASH) {
    const candidates = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else candidates.push(p);
      }
    })(path.join(PKG, ".next", "server", "app"));
    for (const n of ["build-manifest.json", "app-build-manifest.json", "react-loadable-manifest.json"]) {
      const p = path.join(PKG, ".next", n);
      if (fs.existsSync(p)) candidates.push(p);
    }
    for (const f of candidates) {
      // server/app/page.js 本身也可能引用 chunk 名,统一走替换;其打过补丁的内容单独写。
      const base = path.resolve(f) === path.resolve(pageServer) ? server.out : fs.readFileSync(f, "utf8");
      const count = base.split(CUR_HASH).length - 1;
      if (count > 0) refEdits.push({ file: f, count, out: base.replaceAll(CUR_HASH, NEW_HASH) });
    }
    if (refEdits.reduce((a, e) => a + e.count, 0) < 1) die("page chunk 引用未找到，拒绝改名（会 404）");
  }
  // server page.js 若没进 refEdits（无 chunk 名引用），补丁内容仍需落盘
  if (server.applied && !refEdits.some((e) => path.resolve(e.file) === path.resolve(pageServer))) {
    refEdits.push({ file: pageServer, count: 0, out: server.out });
  }

  const upstreamApplied = {
    fold: clientSrc.includes('"process-group-lead-"'),
    draft: clientSrc.includes("__pwDraftPersistV1"),
    hideThinking: clientSrc.includes("__pwHideThinkingV1"),
    hideRecovered: clientSrc.includes("__pwHideRecoveredV1"),
  };
  const summary = {
    status: CHECK ? "check-ok" : "patched",
    pkg: PKG, version: VERSION,
    chunk: { from: `page-${CUR_HASH}.js`, to: `page-${NEW_HASH}.js`, renamed: CUR_HASH !== NEW_HASH },
    applied: { client: client.applied, serverPage: server.applied },
    upstreamApplied,
    refEdits: refEdits.map((e) => ({ file: path.relative(PKG, e.file), count: e.count })),
    backup: BACKUP,
  };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }
  if (!upstreamApplied.hideRecovered) console.error("[WARN] 未检测到 hide-recovered 补丁标记；本补丁应在补丁链尾运行，否则上游补丁改名会让本补丁产物名失去跟随。");

  for (const f of [curChunk, pageServer, ...refEdits.map((e) => e.file)]) {
    const dst = path.join(BACKUP, path.relative(PKG, f));
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
  }

  if (client.applied) fs.writeFileSync(newChunk, client.out);
  for (const e of refEdits) fs.writeFileSync(e.file, e.out);
  // 旧 chunk 保留：运行中的 Next 进程可能仍按旧 hash 派发请求。
  console.log(JSON.stringify(summary, null, 1));
}

// junction 布局下 argv[1] 是链接路径而 import.meta.url 是真实路径,字面比较必不等 → 静默 exit 0 假成功;两侧都过 realpath。
const realPathOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()) main();
