#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：恢复并默认展开模型的用户可见 reasoning summary。
//
// 旧 patch-piweb-hide-thinking V1 把所有 thinking block 当作 hidden block，导致推理生成
// 期间“处理详情”只有工具调用、完全没有推理摘要。本补丁原位撤销 V1，恢复上游语义：
// 只过滤“已结束且为空”的 thinking；流式及非空 thinking 均渲染。同时让 ThinkingBlock
// 对流式（非 deferred）内容初始展开，因此生成过程中直接看到摘要；历史 deferred 内容
// 仍从收起态点击加载，避免“已展开却未触发取回正文”的空卡。
//
// 用法: node patch-piweb-show-thinking.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；功能锚点不唯一即中止且零写入；client/server 双侧修改；幂等可重入。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwShowThinkingV4";
export const PREVIOUS_MARKS = ["__pwShowThinkingV2", "__pwShowThinkingV3"];
export const RETIRED_MARK = "__pwHideThinkingV1";
export const PATCH_REVISION = "r3";

const HIDDEN_FUNCTION_RE = /function ([\w$]+)\(([\w$]+),([\w$]+)=\{\}\)\{return"thinking"===\2\.type\}(?:typeof window<"u"&&\(window\.__pwHideThinkingV1=!0\);|\/\*__pwHideThinkingV1\*\/)/gu;
const VISIBLE_FUNCTION_RE = /function ([\w$]+)\(([\w$]+),([\w$]+)=\{\}\)\{return"thinking"===\2\.type&&!\2\.deferred&&!\3\.isStreaming&&""===\2\.thinking\.trim\(\)\}/gu;
const STATE_RE = /\(0,([\w$]+)\.useState\)\((!0|!1|![\w$]+\.deferred)\)/gu;

function restoreThinkingVisibility(source, label) {
  const hidden = [...source.matchAll(HIDDEN_FUNCTION_RE)];
  const visible = [...source.matchAll(VISIBLE_FUNCTION_RE)];
  if (hidden.length === 1 && visible.length === 0) {
    const [, name, block, options] = hidden[0];
    return source.replace(HIDDEN_FUNCTION_RE,
      `function ${name}(${block},${options}={}){return"thinking"===${block}.type&&!${block}.deferred&&!${options}.isStreaming&&""===${block}.thinking.trim()}`,
    );
  }
  if (hidden.length === 0 && visible.length === 1) return source;
  throw new Error(`${label}: thinking visibility anchor hidden=${hidden.length} visible=${visible.length} (expected exactly one), refusing write`);
}

function locateThinkingRenderer(source, label) {
  const candidates = [];
  for (const match of source.matchAll(/"i18n\.thinkingUnavailable"/gu)) {
    const functionStart = source.lastIndexOf("function ", match.index);
    if (functionStart < 0 || match.index - functionStart > 5000) continue;
    const functionEnd = source.indexOf("function ", match.index + match[0].length);
    const end = functionEnd < 0 ? Math.min(source.length, match.index + 5000) : functionEnd;
    const body = source.slice(functionStart, end);
    if (!body.includes('"i18n.loadingThinking"')) continue;
    const statesBeforeUnavailable = [...body.slice(0, match.index - functionStart).matchAll(STATE_RE)];
    if (statesBeforeUnavailable.length < 2) continue;
    const signature = body.match(/^function [\w$]+\(\{block:([\w$]+),/u);
    if (!signature) continue;
    candidates.push({ functionStart, end, firstState: statesBeforeUnavailable[0], block: signature[1], body });
  }
  if (candidates.length !== 1) {
    throw new Error(`${label}: thinking renderer anchor matched ${candidates.length} times (expected 1), refusing write`);
  }
  return candidates[0];
}

function expandThinkingCard(source, label) {
  const renderer = locateThinkingRenderer(source, label);
  const desired = `!${renderer.block}.deferred`;
  if (renderer.firstState[2] === desired) return source;
  const index = renderer.functionStart + renderer.firstState.index;
  const text = renderer.firstState[0];
  return source.slice(0, index) + text.replace(`(${renderer.firstState[2]})`, `(${desired})`) + source.slice(index + text.length);
}

export function localizeVisibleThinkingSummary(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || /[\u3400-\u9fff]/u.test(text)) return value;
  const normalized = text.replace(/[*_`#]/gu, " ").trim().toLowerCase();
  if (/\b(plan|planning|design|designing|architecting)\b/u.test(normalized)) return "正在规划当前任务…";
  if (/\b(inspect|inspecting|locate|locating|trace|tracing|check|checking)\b/u.test(normalized)) return "正在检查相关信息…";
  if (/\b(debug|debugging|diagnose|diagnosing|investigate|investigating)\b/u.test(normalized)) return "正在定位问题原因…";
  if (/\b(implement|implementing|edit|editing|update|updating|apply|applying|fix|fixing)\b/u.test(normalized)) return "正在实施修正…";
  if (/\b(test|testing|verify|verifying|validate|validating)\b/u.test(normalized)) return "正在验证修改结果…";
  if (/\b(review|reviewing|audit|auditing|reassess|reassessing)\b/u.test(normalized)) return "正在复核结果…";
  if (/\b(research|researching|explore|exploring|compare|comparing)\b/u.test(normalized)) return "正在调研可行方案…";
  if (/\b(configure|configuring|deploy|deploying|publish|publishing)\b/u.test(normalized)) return "正在配置并应用变更…";
  if (/\b(finalize|finalizing|finish|finishing|summarize|summarizing)\b/u.test(normalized)) return "正在整理最终结果…";
  return "正在深入分析当前任务…";
}

function localizeThinkingRenderer(source, label) {
  if (source.includes("__pwLocalizeVisibleThinkingSummary")) return source;
  const renderer = locateThinkingRenderer(source, label);
  const deferredTernary = /([\w$]+)\.deferred\?([\w$]+):\1\.thinking/gu;
  const matches = [...renderer.body.matchAll(deferredTernary)];
  if (matches.length !== 1) {
    throw new Error(`${label}: thinking content anchor matched ${matches.length} times (expected 1), refusing write`);
  }
  const helper = localizeVisibleThinkingSummary.toString().replace("localizeVisibleThinkingSummary", "__pwLocalizeVisibleThinkingSummary");
  const [, block, loaded] = matches[0];
  const replacement = `__pwLocalizeVisibleThinkingSummary(${block}.deferred?${loaded}:${block}.thinking)`;
  const bodyStart = renderer.functionStart;
  const localizedBody = renderer.body.replace(deferredTernary, replacement);
  return source.slice(0, bodyStart) + helper + localizedBody + source.slice(renderer.end);
}

export function applyShowThinking(src, label = "bundle", { browserMark = false } = {}) {
  if (src.includes(MARK)) return { out: src, applied: false };
  let out = src;
  for (const previous of PREVIOUS_MARKS) {
    out = out
      .replace(new RegExp(`;typeof window<"u"&&\\(window\\.${previous}=!0\\);`, "gu"), "")
      .replace(new RegExp(`/\\*${previous}\\*/`, "gu"), "");
  }
  out = restoreThinkingVisibility(out, label);
  out = expandThinkingCard(out, label);
  out = localizeThinkingRenderer(out, label);
  if (out.includes(RETIRED_MARK)) throw new Error(`${label}: retired hide-thinking marker remains after restore`);
  out += browserMark
    ? `;typeof window<"u"&&(window.${MARK}=!0);`
    : `/*${MARK}*/`;
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
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-show-thinking"));
  const VERSION = "0.8.11";
  const die = (message) => {
    console.error("[ABORT] " + message);
    process.exit(1);
  };

  const pkgJsonPath = path.join(PKG, "package.json");
  if (!fs.existsSync(pkgJsonPath)) die("package directory missing: " + PKG);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.version !== VERSION) die(`package version ${pkgJson.version} != ${VERSION}; refusing`);

  if (args.includes("--revert")) {
    if (!fs.existsSync(BACKUP)) die("backup directory missing: " + BACKUP);
    const restored = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(source); continue; }
        const relative = path.relative(BACKUP, source);
        const target = path.join(PKG, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        restored.push(relative);
      }
    })(BACKUP);
    console.log(JSON.stringify({ status: "reverted", pkg: PKG, restored, note: "restart pi-web after revert" }, null, 1));
    process.exit(0);
  }

  const manifest = path.join(PKG, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("page_client-reference-manifest.js missing");
  const referencedHashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/gu)].map((match) => match[1]),
  )];
  if (referencedHashes.length !== 1) die(`page chunk reference parse failure: ${JSON.stringify(referencedHashes)}`);
  const currentHash = referencedHashes[0];
  if (currentHash.length < 8) die(`page chunk hash too short: ${currentHash}`);
  const chunkDirectory = path.join(PKG, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDirectory, `page-${currentHash}.js`);
  const serverPage = path.join(PKG, ".next", "server", "app", "page.js");
  if (!fs.existsSync(currentChunk) || !fs.existsSync(serverPage)) die("client or server page bundle missing");
  const clientSource = fs.readFileSync(currentChunk, "utf8");
  const serverSource = fs.readFileSync(serverPage, "utf8");
  if (clientSource.includes(MARK) && serverSource.includes(MARK)) {
    console.log(JSON.stringify({ status: "already-patched", pkg: PKG, chunk: path.basename(currentChunk) }));
    process.exit(0);
  }

  let client;
  let server;
  try {
    client = applyShowThinking(clientSource, "client", { browserMark: true });
    server = applyShowThinking(serverSource, "server-page");
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const fingerprint = crypto.createHash("sha1")
    .update(currentHash).update(":").update(PATCH_REVISION).update(":")
    .update(applyShowThinking.toString()).digest("hex");
  const nextHash = client.applied ? ("pwy" + fingerprint).slice(0, currentHash.length) : currentHash;
  const nextChunk = path.join(chunkDirectory, `page-${nextHash}.js`);
  if (currentHash !== nextHash && fs.existsSync(nextChunk) && !fs.readFileSync(nextChunk, "utf8").includes(MARK)) {
    die(`target chunk exists and is not this patch: ${nextChunk}`);
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
    if (referenceEdits.reduce((sum, edit) => sum + edit.count, 0) < 1) die("page chunk references missing; refusing rename");
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
    restoredFromHideThinkingV1: clientSource.includes(RETIRED_MARK),
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
  console.log(JSON.stringify(summary, null, 1));
}

const realPathOf = (candidate) => {
  try { return fs.realpathSync(candidate); }
  catch { return path.resolve(candidate); }
};
if (process.argv[1] && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()) main();
