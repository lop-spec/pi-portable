#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：彻底隐藏扩展明确标为 display:false 的 custom 消息。
//
// 背景: Pi 的扩展 API 用 display:false 表示消息需要进入会话/LLM 上下文但不应展示；
// pi-web 0.8.11 却把它渲染成可展开的“隐藏的扩展消息”卡片，导致 lop-chain、
// lop-adversary 等内部控制消息占据聊天区。这里恢复 display 字段本来的展示语义。
// display:true 或未提供 display 的 custom 消息、普通用户/助手/命令消息均保持原样。
//
// 原理: MessageView 的统一 custom role 分支在进入 compaction/CustomMessageView 前增加
// display===false guard。client chunk 与 server/app/page.js 双侧同改，避免水合不一致；
// 会话 JSONL 和模型上下文均不改，只移除 DOM 渲染。
//
// 用法: node patch-piweb-hide-hidden-extension-messages.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；锚点命中数不符 => 中止且零写入；幂等可重入。
// 顺序: Pi Web 补丁链最末端。chunk 名指纹含当前 chunk hash，上游补丁变化时自动换名。
// 回滚: --revert 按备份目录整体拷回；新 chunk 文件保留为无引用孤儿；重启 pi-web。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwHideHiddenExtensionMessagesV1";
export const PATCH_REVISION = "r1";

const ID = "([\\w$]+)";
// MessageView 编译后的相邻分支：toolResult 不渲染，custom 进入 compaction/通用卡片。
// 捕获 message 形参并用反向引用约束两处分支必须使用同一对象，避免误伤相似表达式。
const CUSTOM_ROLE_ANCHOR = new RegExp(
  `"toolResult"===${ID}\\.role\\?null:"custom"===\\1\\.role\\?`,
  "g",
);

export function applyHideHiddenExtensionMessages(src, label = "bundle", { browserMark = false } = {}) {
  if (src.includes(MARK)) return { out: src, applied: false };
  const hits = [...src.matchAll(CUSTOM_ROLE_ANCHOR)];
  if (hits.length !== 1) {
    throw new Error(`${label}: custom 消息渲染锚点命中 ${hits.length} 次(期望1)，拒绝写入`);
  }
  const message = hits[0][1];
  const marker = browserMark
    ? `typeof window<"u"&&(window.${MARK}=!0),`
    : `/*${MARK}*/`;
  const out = src.replace(CUSTOM_ROLE_ANCHOR, () =>
    `"toolResult"===${message}.role?null:"custom"===${message}.role?(${marker}!1===${message}.display)?null:`,
  );
  return { out, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-hide-hidden-extension-messages"));
  const VERSION = "0.8.11";
  const die = (message) => {
    console.error("[ABORT] " + message);
    process.exit(1);
  };

  const pkgJsonPath = path.join(PKG, "package.json");
  if (!fs.existsSync(pkgJsonPath)) die("包目录不存在: " + PKG);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.version !== VERSION) die(`package version ${pkgJson.version} != ${VERSION}，拒绝执行`);

  if (args.includes("--revert")) {
    if (!fs.existsSync(BACKUP)) die("备份目录不存在: " + BACKUP);
    const restored = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(source);
          continue;
        }
        const relative = path.relative(BACKUP, source);
        const target = path.join(PKG, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        restored.push(relative);
      }
    })(BACKUP);
    console.log(JSON.stringify({
      status: "reverted",
      pkg: PKG,
      restored,
      note: "新 chunk 文件保留为无引用孤儿；重启 pi-web 后生效",
    }, null, 1));
    process.exit(0);
  }

  const manifest = path.join(PKG, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("找不到 page_client-reference-manifest.js");
  const referencedHashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/g)].map((match) => match[1]),
  )];
  if (referencedHashes.length !== 1) die(`page chunk 引用解析异常: ${JSON.stringify(referencedHashes)}`);
  const currentHash = referencedHashes[0];
  if (currentHash.length < 8) die(`page chunk hash 过短，无法安全改名: ${currentHash}`);

  const chunkDirectory = path.join(PKG, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDirectory, `page-${currentHash}.js`);
  const serverPage = path.join(PKG, ".next", "server", "app", "page.js");
  if (!fs.existsSync(currentChunk)) die("当前 page chunk 不存在: " + currentChunk);
  if (!fs.existsSync(serverPage)) die("server page.js 不存在: " + serverPage);
  const clientSource = fs.readFileSync(currentChunk, "utf8");
  const serverSource = fs.readFileSync(serverPage, "utf8");

  if (clientSource.includes(MARK) && serverSource.includes(MARK)) {
    console.log(JSON.stringify({ status: "already-patched", pkg: PKG, chunk: path.basename(currentChunk) }));
    process.exit(0);
  }

  let client;
  let server;
  try {
    client = applyHideHiddenExtensionMessages(clientSource, "client", { browserMark: true });
    server = applyHideHiddenExtensionMessages(serverSource, "server-page");
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const patchFingerprint = crypto.createHash("sha1")
    .update(currentHash).update(":")
    .update(PATCH_REVISION).update(":")
    .update(applyHideHiddenExtensionMessages.toString())
    .digest("hex");
  const nextHash = client.applied ? ("pwx" + patchFingerprint).slice(0, currentHash.length) : currentHash;
  const nextChunk = path.join(chunkDirectory, `page-${nextHash}.js`);
  if (currentHash !== nextHash && fs.existsSync(nextChunk) && !fs.readFileSync(nextChunk, "utf8").includes(MARK)) {
    die(`目标 chunk 已存在且不是本补丁产物，拒绝覆盖: ${nextChunk}`);
  }

  const referenceEdits = [];
  if (currentHash !== nextHash) {
    const candidates = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(candidate);
        else candidates.push(candidate);
      }
    })(path.join(PKG, ".next", "server", "app"));
    for (const name of ["build-manifest.json", "app-build-manifest.json", "react-loadable-manifest.json"]) {
      const candidate = path.join(PKG, ".next", name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
    for (const file of candidates) {
      const source = path.resolve(file) === path.resolve(serverPage) ? server.out : fs.readFileSync(file, "utf8");
      const count = source.split(currentHash).length - 1;
      if (count > 0) referenceEdits.push({ file, count, out: source.replaceAll(currentHash, nextHash) });
    }
    if (referenceEdits.reduce((sum, edit) => sum + edit.count, 0) < 1) {
      die("page chunk 引用未找到，拒绝改名（会 404）");
    }
  }
  if (server.applied && !referenceEdits.some((edit) => path.resolve(edit.file) === path.resolve(serverPage))) {
    referenceEdits.push({ file: serverPage, count: 0, out: server.out });
  }

  const summary = {
    status: CHECK ? "check-ok" : "patched",
    pkg: PKG,
    version: VERSION,
    chunk: { from: `page-${currentHash}.js`, to: `page-${nextHash}.js`, renamed: currentHash !== nextHash },
    applied: { client: client.applied, serverPage: server.applied },
    upstreamPatches: {
      fold: clientSource.includes('"process-group-lead-"'),
      draft: clientSource.includes("__pwDraftPersistV1"),
      interactions: clientSource.includes("__pwPasteAndScrollV2"),
      hideThinking: clientSource.includes("__pwHideThinkingV1"),
      hideRecovered: clientSource.includes("__pwHideRecoveredV1"),
      thinkingDefault: clientSource.includes("__pwThinkingDefaultDisplayV2"),
    },
    refEdits: referenceEdits.map((edit) => ({ file: path.relative(PKG, edit.file), count: edit.count })),
    backup: BACKUP,
  };
  if (CHECK) {
    console.log(JSON.stringify(summary, null, 1));
    process.exit(0);
  }

  for (const file of new Set([currentChunk, serverPage, ...referenceEdits.map((edit) => edit.file)])) {
    const destination = path.join(BACKUP, path.relative(PKG, file));
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }

  if (client.applied) fs.writeFileSync(nextChunk, client.out);
  for (const edit of referenceEdits) fs.writeFileSync(edit.file, edit.out);
  // 旧 chunk 保留：运行中的 Next 进程与 PWA 缓存可能仍引用旧 URL。
  console.log(JSON.stringify(summary, null, 1));
}

// junction 布局下 argv[1] 与 import.meta.url 字面路径不同，比较 realpath 才不会静默跳过。
const realPathOf = (candidate) => {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
};
if (process.argv[1] && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()) main();
