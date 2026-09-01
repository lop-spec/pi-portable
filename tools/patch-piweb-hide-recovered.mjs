#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：会话恢复后隐藏历史错误框与 supervisor 恢复注入消息。
// 背景: 8794 上游 429/502 等错误会以 assistant(stopReason=error) 落库,run-supervisor 随即
// 注入 "[lop-run-supervisor recovery] ..." user 消息重投。连环失败时界面平铺一串
// 红错误框+蓝恢复消息;一旦恢复(其后出现任何 assistant 消息),这些历史噪音仍挂在明面。
//
// 语义: 消息 i 满足以下任一,且其后存在任何 assistant 消息(=已有更新的尝试/恢复),则不渲染:
//   a) assistant 且 stopReason==="error" 且无 text/image 正文块(有部分正文的 error 保留,不丢信息);
//   b) user 且首个 text 块以 "[lop-run-supervisor recovery]" 开头。
// 效果: 连环失败只显示最新一对错误+恢复注入;恢复轮一产出 assistant 消息即全部隐藏;
//   未恢复时(错误是最新状态)照常显示。会话 jsonl 不动,仅渲染层。
//
// 原理: 单条消息渲染函数 d(t,n) 是平铺/处理详情组/live-tail 的唯一收口,在其入口注入判定。
// client chunk + server/app/page.js 双侧同改(水合一致)。
//
// 用法: node patch-piweb-hide-recovered.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；锚点命中数不符 => 中止且零写入；幂等可重入（已打则 already-patched）。
// 顺序: 链尾(hide-thinking 之后)。chunk 名指纹含当前 chunk hash,上游补丁改名自动跟随。
// 回滚: --revert 按备份目录整体拷回；新 chunk 文件保留（孤儿无害）；重启 pi-web。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwHideRecoveredV1";
export const PATCH_REVISION = "r1";
export const RECOVERY_PREFIX = "[lop-run-supervisor recovery]";

const ID = "([\\w$]+)";
// 渲染函数头: <fn>=(<idx>,<opt>={})=>{let <msg>=<opt>.messageOverride??<arr>[<idx>],
const D_ANCHOR = new RegExp(
  `${ID}=\\(${ID},${ID}=\\{\\}\\)=>\\{let ${ID}=\\3\\.messageOverride\\?\\?${ID}\\[\\2\\],`,
  "g");

export function applyHideRecovered(src, label = "bundle") {
  if (src.includes(MARK)) return { out: src, applied: false };
  const hits = [...src.matchAll(D_ANCHOR)];
  if (hits.length !== 1) {
    throw new Error(`${label}: 消息渲染函数锚点命中 ${hits.length} 次(期望1)，拒绝写入`);
  }
  const [, fn, idx, opt, msg, arr] = hits[0];
  // 结束首个声明,插入 guard,再开新 let 接续原有后续声明(原文以逗号继续)。
  const guard =
    `${fn}=(${idx},${opt}={})=>{let ${msg}=${opt}.messageOverride??${arr}[${idx}];` +
    `if((("assistant"===${msg}.role&&"error"===${msg}.stopReason` +
    `&&!(Array.isArray(${msg}.content)&&${msg}.content.some(pwHRb=>pwHRb&&("text"===pwHRb.type||"image"===pwHRb.type))))` +
    `||("user"===${msg}.role&&(pwHRc=>{let pwHRt="string"==typeof pwHRc?pwHRc:` +
    `Array.isArray(pwHRc)?(pwHRc.find(pwHRb=>pwHRb&&"text"===pwHRb.type)?.text??""):"";` +
    `return pwHRt.startsWith(${JSON.stringify(RECOVERY_PREFIX)})})(${msg}.content)))` +
    `&&${arr}.slice(${idx}+1).some(pwHRm=>pwHRm&&"assistant"===pwHRm.role))return null;` +
    `/*${MARK}*/let `;
  const out = src.replace(D_ANCHOR, () => guard);
  return { out, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-hide-recovered"));

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
    client = applyHideRecovered(clientSrc, "client");
    server = applyHideRecovered(serverSrc, "server-page");
  } catch (error) { die(error instanceof Error ? error.message : String(error)); }

  // chunk 名指纹含当前 chunk hash:上游链(fold/draft/interactions/hide-thinking)一换名自动跟随;
  // 绝不同名换内容(SW 对 /_next/static 是 cacheFirst)。
  const patchFingerprint = crypto.createHash("sha1")
    .update(CUR_HASH).update(":")
    .update(PATCH_REVISION).update(":")
    .update(applyHideRecovered.toString())
    .digest("hex");
  const NEW_HASH = client.applied ? ("pwr" + patchFingerprint).slice(0, CUR_HASH.length) : CUR_HASH;

  const newChunk = path.join(chunkDir, `page-${NEW_HASH}.js`);
  if (CUR_HASH !== NEW_HASH && fs.existsSync(newChunk) && !fs.readFileSync(newChunk, "utf8").includes(MARK)) {
    die(`目标 chunk 已存在且不是本补丁产物，拒绝覆盖: ${newChunk}`);
  }

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
      const base = path.resolve(f) === path.resolve(pageServer) ? server.out : fs.readFileSync(f, "utf8");
      const count = base.split(CUR_HASH).length - 1;
      if (count > 0) refEdits.push({ file: f, count, out: base.replaceAll(CUR_HASH, NEW_HASH) });
    }
    if (refEdits.reduce((a, e) => a + e.count, 0) < 1) die("page chunk 引用未找到，拒绝改名（会 404）");
  }
  if (server.applied && !refEdits.some((e) => path.resolve(e.file) === path.resolve(pageServer))) {
    refEdits.push({ file: pageServer, count: 0, out: server.out });
  }

  const summary = {
    status: CHECK ? "check-ok" : "patched",
    pkg: PKG, version: VERSION,
    chunk: { from: `page-${CUR_HASH}.js`, to: `page-${NEW_HASH}.js`, renamed: CUR_HASH !== NEW_HASH },
    applied: { client: client.applied, serverPage: server.applied },
    hideThinkingDetected: clientSrc.includes("__pwHideThinkingV1"),
    refEdits: refEdits.map((e) => ({ file: path.relative(PKG, e.file), count: e.count })),
    backup: BACKUP,
  };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }

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
