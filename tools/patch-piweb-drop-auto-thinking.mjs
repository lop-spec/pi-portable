#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：删除 thinking 的 "auto" 选项，并显示 pi 实际解析出的默认档位。
// 背景(2026-09-01 lop 裁决): 下拉中不再允许选 auto；随后发现新会话按钮仍把未显式选择
// 渲染成字面量 auto。实际启动优先级是 enabledModels 档位钉选 > modelThinkingLevels
// 按模型默认 > defaultThinkingLevel 全局默认 > SDK medium，最终还会按模型能力 clamp。
// 本补丁让 /api/models 返回每个可见模型的同口径有效默认值，首帧和切换模型时都显示该值；
// 同时把有效值回填到旧客户端已认识的 thinkingLevelPins，令补丁前已打开的标签页在下次
// 新建对话时也立即显示真实默认值，无需依赖强制刷新。展示态不写显式 override。
//
// 用法: node patch-piweb-drop-auto-thinking.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；每个锚点必须唯一，任一不符 => 中止且零写入；支持从 V1 原地升级并幂等重入。
// 顺序: 链尾(在 fold/draft/interactions/hide-thinking/hide-recovered 之后)。chunk 名包含补丁指纹，
//       任一上游 chunk 或本补丁代码变化都会换 URL，避免 PWA cacheFirst 复用旧内容。
// 回滚: --revert 按本轮独立备份目录整体拷回；旧/新 chunk 都保留，重启 pi-web 后生效。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwDropAutoThinkingV1";
export const DISPLAY_MARK = "__pwThinkingDefaultDisplayV2";
export const LEGACY_PIN_MARK = "__pwThinkingDefaultLegacyPinsV3";
// 参与 chunk 名指纹。需要强制客户端丢弃旧缓存时 bump 这个值。
export const PATCH_REVISION = "r3";

const ANCHOR = '["auto","off","minimal","low","medium","high","xhigh","max"]';
const REPLACEMENT = '["off","minimal","low","medium","high","xhigh","max"]';
const IDENT = "[A-Za-z_$][\\w$]*";

function only(matches, label) {
  if (matches.length !== 1) throw new Error(`${label}锚点命中 ${matches.length} 次(期望1)，拒绝写入`);
  return matches[0];
}

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

export function applyThinkingDefaultDisplay(src, label = "page", { browserMark = false } = {}) {
  if (src.includes(DISPLAY_MARK)) return { out: src, applied: false };

  const stateRe = /\.useState\)\("auto"\)/g;
  only([...src.matchAll(stateRe)], `${label}: thinking 初始状态`);

  const loadRe = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\.thinkingLevelPins\?\.\[`\$\{\2\.provider\}\/\$\{\2\.id\}`\];null===([A-Za-z_$][\w$]*)\.current&&([A-Za-z_$][\w$]*)\(\1\?\?"auto"\)/g;
  const load = only([...src.matchAll(loadRe)], `${label}: models 默认档位读取`);
  const [, valueVar, modelVar, responseVar, overrideRef, setThinking] = load;

  const modelChangeRe = new RegExp(`if\\((${IDENT})\\)\\{let (${IDENT})=\\{provider:(${IDENT}),modelId:(${IDENT})\\};`, "g");
  const modelChanges = [...src.matchAll(modelChangeRe)].filter((match) => (
    src.slice(match.index, match.index + 900).includes('type:"set_model"')
  ));
  const modelChange = only(modelChanges, `${label}: 新会话模型切换`);
  const [, , , providerVar, modelIdVar] = modelChange;

  let out = src.replace(stateRe, '.useState)("medium")');
  out = out.replace(loadRe, () => (
    `${overrideRef}.pwDefaults=${responseVar}.defaultThinkingLevels??{};`
    + `let ${valueVar}=${modelVar}&&${overrideRef}.pwDefaults?.[\`${`\${${modelVar}.provider}:\${${modelVar}.id}`}\`];`
    + `null===${overrideRef}.current&&${setThinking}(${valueVar}??"medium")`
  ));
  out = out.replace(modelChangeRe, (full, isNew, selected, provider, modelId, offset) => {
    const near = src.slice(offset, offset + 900);
    if (!near.includes('type:"set_model"')) return full;
    return `${full}null===${overrideRef}.current&&${setThinking}(`
      + `${overrideRef}.pwDefaults?.[\`${`\${${providerVar}}:\${${modelIdVar}}`}\`]??"medium");`;
  });

  const marker = browserMark
    ? `\n;typeof window<"u"&&(window.${DISPLAY_MARK}=!0);`
    : `\n/*${DISPLAY_MARK}*/`;
  return { out: out + marker, applied: true };
}

export function applyModelsDefaultThinkingLevels(src, label = "models-route") {
  if (src.includes(DISPLAY_MARK)) return { out: src, applied: false };

  const settingsRe = new RegExp(`(${IDENT})=(${IDENT})\\.settingsManager,${IDENT}=await`, "g");
  const settings = only([...src.matchAll(settingsRe)], `${label}: SettingsManager`)[1];
  const scopeRe = new RegExp(`\\{visible:(${IDENT}),thinkingLevelPins:(${IDENT}),warnings:(${IDENT})\\}=(${IDENT});for`, "g");
  const scope = only([...src.matchAll(scopeRe)], `${label}: model scope`);
  const pins = scope[2];
  const supportedRe = new RegExp(`(${IDENT})\\[(${IDENT})\\]=\\(0,(${IDENT})\\.getSupportedThinkingLevels\\)\\((${IDENT})\\),\\4\\.thinkingLevelMap&&\\((${IDENT})\\[\\2\\]=\\4\\.thinkingLevelMap\\)`, "g");
  const supported = only([...src.matchAll(supportedRe)], `${label}: thinking levels`);
  const [, levels, key, piAi, model, maps] = supported;

  const responseAnchor = `thinkingLevelMaps:${maps},thinkingLevelPins:${pins}`;
  const responseHits = src.split(responseAnchor).length - 1;
  if (responseHits !== 1) throw new Error(`${label}: 成功响应锚点命中 ${responseHits} 次(期望1)，拒绝写入`);
  const emptyAnchor = "thinkingLevelMaps:{},thinkingLevelPins:{}";
  const emptyHits = src.split(emptyAnchor).length - 1;
  if (emptyHits !== 1) throw new Error(`${label}: 空响应锚点命中 ${emptyHits} 次(期望1)，拒绝写入`);

  let out = src.replace(scopeRe, (full) => full.replace(";for", ";let pwActualThinkingDefaults={};for"));
  out = out.replace(supportedRe, () => (
    `${levels}[${key}]=(0,${piAi}.getSupportedThinkingLevels)(${model}),`
    + `pwActualThinkingDefaults[${key}]=(0,${piAi}.clampThinkingLevel)(${model},`
    + `${pins}[\`${`\${${model}.provider}/\${${model}.id}`}\`]??`
    + `${settings}.getModelThinkingLevel(${model}.provider,${model}.id)??`
    + `${settings}.getDefaultThinkingLevel()??"medium"),`
    + `${model}.thinkingLevelMap&&(${maps}[${key}]=${model}.thinkingLevelMap)`
  ));
  out = out.replace(responseAnchor, `${responseAnchor},defaultThinkingLevels:pwActualThinkingDefaults`);
  out = out.replace(emptyAnchor, `${emptyAnchor},defaultThinkingLevels:{}`);
  return { out: `${out}\n/*${DISPLAY_MARK}:models*/`, applied: true };
}

export function applyLegacyThinkingDefaultPins(src, label = "models-route") {
  if (src.includes(LEGACY_PIN_MARK)) return { out: src, applied: false };
  if (!src.includes(`${DISPLAY_MARK}:models`)) {
    throw new Error(`${label}: 有效默认值前置标记缺失，拒绝写入`);
  }

  const scopeRe = new RegExp(`\\{visible:(${IDENT}),thinkingLevelPins:(${IDENT}),warnings:(${IDENT})\\}=(${IDENT});let pwActualThinkingDefaults=\\{\\};for`, "g");
  const scope = only([...src.matchAll(scopeRe)], `${label}: legacy pin model scope`);
  const pins = scope[2];
  const defaultAssignmentRe = new RegExp(`pwActualThinkingDefaults\\[(${IDENT})\\]=\\(0,${IDENT}\\.clampThinkingLevel\\)\\((${IDENT}),`, "g");
  const defaultAssignment = only([...src.matchAll(defaultAssignmentRe)], `${label}: legacy pin effective default`);
  const key = defaultAssignment[1];
  const model = defaultAssignment[2];
  const assignmentTail = `??"medium"),${model}.thinkingLevelMap`;
  const tailHits = src.split(assignmentTail).length - 1;
  if (tailHits !== 1) throw new Error(`${label}: legacy pin 赋值尾锚点命中 ${tailHits} 次(期望1)，拒绝写入`);
  const responseAnchor = `thinkingLevelPins:${pins},defaultThinkingLevels:pwActualThinkingDefaults`;
  const responseHits = src.split(responseAnchor).length - 1;
  if (responseHits !== 1) throw new Error(`${label}: legacy pin 响应锚点命中 ${responseHits} 次(期望1)，拒绝写入`);

  let out = src.replace(scopeRe, (full) => full.replace(
    "let pwActualThinkingDefaults={};for",
    `let pwActualThinkingDefaults={},pwEffectiveThinkingPins={...${pins}};for`,
  ));
  out = out.replace(
    assignmentTail,
    `??"medium"),pwEffectiveThinkingPins[\`${`\${${model}.provider}/\${${model}.id}`}\`]=pwActualThinkingDefaults[${key}],${model}.thinkingLevelMap`,
  );
  out = out.replace(responseAnchor, `thinkingLevelPins:pwEffectiveThinkingPins,defaultThinkingLevels:pwActualThinkingDefaults`);
  return { out: `${out}\n/*${LEGACY_PIN_MARK}:models*/`, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const portablePackage = path.resolve(PKG).toLowerCase().includes(`${path.sep}portable${path.sep}app${path.sep}`);
  const backupLeaf = `backup-0.8.11-pre-thinking-default-legacy-pin-v3${portablePackage ? "" : "-global"}`;
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", backupLeaf));

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
  const modelsRoute = path.join(PKG, ".next", "server", "app", "api", "models", "route.js");
  if (!fs.existsSync(curChunk)) die("当前 page chunk 不存在: " + curChunk);
  if (!fs.existsSync(pageServer)) die("server page.js 不存在: " + pageServer);
  if (!fs.existsSync(modelsRoute)) die("models route.js 不存在: " + modelsRoute);
  const clientSrc = fs.readFileSync(curChunk, "utf8");
  const serverSrc = fs.readFileSync(pageServer, "utf8");
  const modelsSrc = fs.readFileSync(modelsRoute, "utf8");

  if (
    clientSrc.includes(MARK) && serverSrc.includes(MARK)
    && clientSrc.includes(DISPLAY_MARK) && serverSrc.includes(DISPLAY_MARK)
    && modelsSrc.includes(DISPLAY_MARK) && modelsSrc.includes(LEGACY_PIN_MARK)
  ) {
    console.log(JSON.stringify({ status: "already-patched", pkg: PKG, chunk: path.basename(curChunk) }));
    process.exit(0);
  }

  let clientDrop, serverDrop, client, server, modelsDefault, models;
  try {
    clientDrop = applyDropAutoThinking(clientSrc, "client", { browserMark: true });
    serverDrop = applyDropAutoThinking(serverSrc, "server-page");
    client = applyThinkingDefaultDisplay(clientDrop.out, "client", { browserMark: true });
    server = applyThinkingDefaultDisplay(serverDrop.out, "server-page");
    modelsDefault = applyModelsDefaultThinkingLevels(modelsSrc, "models-route");
    models = applyLegacyThinkingDefaultPins(modelsDefault.out, "models-route");
  } catch (error) { die(error instanceof Error ? error.message : String(error)); }
  const clientChanged = clientDrop.applied || client.applied;
  const serverChanged = serverDrop.applied || server.applied;
  const modelsChanged = modelsDefault.applied || models.applied;

  // chunk 名指纹 = 当前 chunk hash + 本补丁代码：上游链一换名，本补丁产物名自动跟着换；
  // 本补丁代码一变 URL 也变。绝不同名换内容（SW 对 /_next/static 是 cacheFirst）。
  const patchFingerprint = crypto.createHash("sha1")
    .update(CUR_HASH).update(":")
    .update(PATCH_REVISION).update(":")
    .update(applyDropAutoThinking.toString()).update(":")
    .update(applyThinkingDefaultDisplay.toString()).update(":")
    .update(applyModelsDefaultThinkingLevels.toString()).update(":")
    .update(applyLegacyThinkingDefaultPins.toString())
    .digest("hex");
  const NEW_HASH = clientChanged ? ("pwa" + patchFingerprint).slice(0, CUR_HASH.length) : CUR_HASH;

  const newChunk = path.join(chunkDir, `page-${NEW_HASH}.js`);
  if (CUR_HASH !== NEW_HASH && fs.existsSync(newChunk) && !fs.readFileSync(newChunk, "utf8").includes(DISPLAY_MARK)) {
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
  if (serverChanged && !refEdits.some((e) => path.resolve(e.file) === path.resolve(pageServer))) {
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
    applied: {
      dropAutoClient: clientDrop.applied,
      dropAutoServerPage: serverDrop.applied,
      actualDefaultClient: client.applied,
      actualDefaultServerPage: server.applied,
      actualDefaultModelsApi: modelsDefault.applied,
      legacyClientEffectivePinsApi: models.applied,
    },
    upstreamApplied,
    refEdits: refEdits.map((e) => ({ file: path.relative(PKG, e.file), count: e.count })),
    backup: BACKUP,
  };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }
  if (!upstreamApplied.hideRecovered) console.error("[WARN] 未检测到 hide-recovered 补丁标记；本补丁应在补丁链尾运行，否则上游补丁改名会让本补丁产物名失去跟随。");

  for (const f of new Set([curChunk, pageServer, modelsRoute, ...refEdits.map((e) => e.file)])) {
    const dst = path.join(BACKUP, path.relative(PKG, f));
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
  }

  if (clientChanged) fs.writeFileSync(newChunk, client.out);
  for (const e of refEdits) fs.writeFileSync(e.file, e.out);
  if (modelsChanged) fs.writeFileSync(modelsRoute, models.out);
  // 旧 chunk 保留：运行中的 Next 进程可能仍按旧 hash 派发请求。
  console.log(JSON.stringify(summary, null, 1));
}

// junction 布局下 argv[1] 是链接路径而 import.meta.url 是真实路径,字面比较必不等 → 静默 exit 0 假成功;两侧都过 realpath。
const realPathOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()) main();
