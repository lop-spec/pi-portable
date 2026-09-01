#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：隐藏 assistant thinking（推理摘要）块。
// 背景: GPT-5.6 经 8794 桥(codex 后端)返回的 reasoning summary 无论 auto/detailed 都只有
// 英文标题式短句(实测 1820 块仅 3 块混中文词,p50=49 字符,零信息量),chatgpt.com 网页上的
// 中文思考是网页产品自有摘要器,API 拿不到。前端展示价值为零 => 整体隐藏。
// 中文推理过程 = 模型中途输出的 text 块,不受本补丁影响,照常显示。
//
// 原理: 上游自带 isHiddenBlock 判定(仅隐藏"非流式空 thinking"),本补丁把它扩成
// "一切 thinking 都隐藏"。历史分组的可见性判定(em(msg).length>0)复用同一函数,
// 纯 thinking 消息会连壳一起从 ProcessDetailsGroup 中消失。
//
// 用法: node patch-piweb-hide-thinking.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；锚点命中数不符 => 中止且零写入；幂等可重入（已打则 already-patched）。
// 顺序: 必须在 fold + draft-persist 之后（链尾）。本补丁 chunk 名指纹含当前 chunk hash,
//       上游补丁改名后本补丁会自动换名重打；反过来先跑本补丁会让 draft 的固定名指纹
//       同名换内容,毒缓存。
// 回滚: --revert 按备份目录整体拷回；新 chunk 文件保留（已无引用,孤儿无害）；重启 pi-web。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwHideThinkingV1";
// 参与 chunk 名指纹。需要强制客户端丢弃旧缓存时 bump 这个值。
export const PATCH_REVISION = "r1";

const ID = "([\\w$]+)";
// 上游 isHiddenBlock（编译后）: 仅当 thinking 块非 deferred、非流式且内容为空时隐藏。
// client chunk 与 server/app/page.js 两侧形参名不同(e,t / a,b),全部用捕获组。
const EF_ANCHOR = new RegExp(
  `function ${ID}\\(${ID},${ID}=\\{\\}\\)\\{return"thinking"===\\2\\.type` +
  `&&!\\2\\.deferred&&!\\3\\.isStreaming&&""===\\2\\.thinking\\.trim\\(\\)\\}`,
  "g");

export function applyHideThinking(src, label = "bundle", { browserMark = false } = {}) {
  if (src.includes(MARK)) return { out: src, applied: false };
  const hits = [...src.matchAll(EF_ANCHOR)];
  if (hits.length !== 1) {
    throw new Error(`${label}: thinking 过滤锚点命中 ${hits.length} 次(期望1)，拒绝写入`);
  }
  const [, fn, blk, opt] = hits[0];
  // client 侧留 window 标记供 live 验证；server 侧留注释标记做幂等判定。
  const marker = browserMark
    ? `typeof window<"u"&&(window.${MARK}=!0);`
    : `/*${MARK}*/`;
  const out = src.replace(EF_ANCHOR, () =>
    `function ${fn}(${blk},${opt}={}){return"thinking"===${blk}.type}${marker}`);
  return { out, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-hide-thinking"));

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

  // 当前生效的 page chunk 以 server 侧引用为准（fold/draft 补丁已改过名）
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
    client = applyHideThinking(clientSrc, "client", { browserMark: true });
    server = applyHideThinking(serverSrc, "server-page");
  } catch (error) { die(error instanceof Error ? error.message : String(error)); }

  // chunk 名指纹 = 当前 chunk hash + 本补丁代码：上游链(fold/draft)一换名，本补丁产物名
  // 自动跟着换；本补丁代码一变 URL 也变。绝不同名换内容（SW 对 /_next/static 是 cacheFirst）。
  const patchFingerprint = crypto.createHash("sha1")
    .update(CUR_HASH).update(":")
    .update(PATCH_REVISION).update(":")
    .update(applyHideThinking.toString())
    .digest("hex");
  const NEW_HASH = client.applied ? ("pwh" + patchFingerprint).slice(0, CUR_HASH.length) : CUR_HASH;

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

  const foldApplied = clientSrc.includes('"process-group-lead-"');
  const draftApplied = clientSrc.includes("__pwDraftPersistV1");
  const summary = {
    status: CHECK ? "check-ok" : "patched",
    pkg: PKG, version: VERSION,
    chunk: { from: `page-${CUR_HASH}.js`, to: `page-${NEW_HASH}.js`, renamed: CUR_HASH !== NEW_HASH },
    applied: { client: client.applied, serverPage: server.applied },
    foldPatchDetected: foldApplied, draftPatchDetected: draftApplied,
    refEdits: refEdits.map((e) => ({ file: path.relative(PKG, e.file), count: e.count })),
    backup: BACKUP,
  };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }
  if (!draftApplied) console.error("[WARN] 未检测到 draft-persist 补丁标记；本补丁应在 fold+draft 之后跑（链尾），否则 draft 的固定名指纹会同名换内容毒缓存。");

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
