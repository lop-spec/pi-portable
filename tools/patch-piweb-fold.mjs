#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：折叠历史过程，并从 Agent 消息中隐藏工具卡片（工具仍执行、会话仍留痕）。
// 用法: node patch-piweb-fold.mjs [--pkg <包目录>] [--backup <原始备份目录>] [--upgrade-backup <升级前备份目录>] [--check]
// 约束: 仅 0.8.11；任一锚点命中数不符 => 中止且零写入；可重入（v1-v3 自动补齐到 v4）。
// 回滚: upgrade-backup 整体拷回 .next 对应路径并删除 page-f01dc0de20260831.js；或用原始 backup 全量回滚；随后重启服务。旧 chunk 会保留，避免运行中的旧进程 404。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_BLOCK_FILTER = /\.filter\(\(\{block:([\w$]+)\}\)=>!([\w$]+)\(\1,\{isStreaming:([\w$]+)\}\)\)/g;
const PATCHED_TOOL_BLOCK_FILTER = /\.filter\(\(\{block:([\w$]+)\}\)=>!([\w$]+)\(\1,\{isStreaming:([\w$]+)\}\)&&"toolCall"!==\1\.type\)/g;

export function applyHideAgentToolCalls(src, label = "bundle") {
  const original = [...src.matchAll(TOOL_BLOCK_FILTER)];
  const patched = [...src.matchAll(PATCHED_TOOL_BLOCK_FILTER)];
  if (original.length === 0 && patched.length === 1) return { out: src, applied: false };
  if (original.length !== 1 || patched.length !== 0) {
    throw new Error(`${label}: R3 工具卡过滤锚点异常 original=${original.length} patched=${patched.length}`);
  }
  const out = src.replace(TOOL_BLOCK_FILTER, (_all, block, emptyThinking, streaming) =>
    `.filter(({block:${block}})=>!${emptyThinking}(${block},{isStreaming:${streaming}})&&"toolCall"!==${block}.type)`);
  return { out, applied: true };
}

function main() {
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const CHECK = args.includes("--check");
const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11"));
const UPGRADE_BACKUP = argVal("--upgrade-backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-hide-tools"));

const VERSION = "0.8.11";
const SW_MARK = "0.8.11-fold1";
const PAGE_OLD = "5a48501b9f03fa46", PAGE_V1 = "f01dc0de20260829", PAGE_V3 = "f01dc0de20260830", PAGE_NEW = "f01dc0de20260831";
const LAY_OLD = "e785b697cfbbe825", LAY_NEW = "f01dcafe20260829";
if ([PAGE_OLD, PAGE_V1, PAGE_V3].some((v) => v.length !== PAGE_NEW.length) || LAY_OLD.length !== LAY_NEW.length) throw new Error("tail length mismatch");

const die = (m) => { console.error("[ABORT] " + m); process.exit(1); };
const ID = "([\\w$]+)";
const applyR3 = (src, label) => {
  try { return applyHideAgentToolCalls(src, label); }
  catch (error) { die(error instanceof Error ? error.message : String(error)); }
};

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
if (pkgJson.version !== VERSION) die(`package version ${pkgJson.version} != ${VERSION}，拒绝执行`);

const chunkDir = path.join(PKG, ".next", "static", "chunks", "app");
const pageClientOld = path.join(chunkDir, `page-${PAGE_OLD}.js`);
const pageClientV1 = path.join(chunkDir, `page-${PAGE_V1}.js`);
const pageClientV3 = path.join(chunkDir, `page-${PAGE_V3}.js`);
const pageClientNew = path.join(chunkDir, `page-${PAGE_NEW}.js`);
const layoutOld = path.join(chunkDir, `layout-${LAY_OLD}.js`);
const layoutNew = path.join(chunkDir, `layout-${LAY_NEW}.js`);
const pageServer = path.join(PKG, ".next", "server", "app", "page.js");

// ---------- R1: compaction 摘要折叠（复用同 chunk 的 details.compaction-file-details 模式） ----------
const R1 = new RegExp(
  `\\(0,${ID}\\.jsx\\)\\("div",\\{style:\\{marginTop:3,marginBottom:10,color:"var\\(--text\\)",fontSize:14,lineHeight:1\\.5\\},children:${ID}\\("i18n\\.compactionDescription"\\)\\}\\),` +
  `${ID}\\.body\\?\\(0,\\1\\.jsx\\)\\(${ID},\\{className:"markdown-compaction-message",children:\\3\\.body\\}\\):` +
  `\\(0,\\1\\.jsx\\)\\("span",\\{style:\\{color:"var\\(--text-dim\\)",fontSize:12\\},children:\\2\\("i18n\\.noSummary"\\)\\}\\),` +
  `\\(0,\\1\\.jsx\\)\\(${ID},\\{readFiles:\\3\\.readFiles,modifiedFiles:\\3\\.modifiedFiles\\}\\)`, "g");
const r1New = (jsx, t, o, md, meta) =>
  `(0,${jsx}.jsxs)("details",{className:"compaction-file-details",children:[` +
  `(0,${jsx}.jsx)("summary",{children:${t}("i18n.compactionDescription")}),` +
  `${o}.body?(0,${jsx}.jsx)(${md},{className:"markdown-compaction-message",children:${o}.body}):` +
  `(0,${jsx}.jsx)("span",{style:{color:"var(--text-dim)",fontSize:12},children:${t}("i18n.noSummary")}),` +
  `(0,${jsx}.jsx)(${meta},{readFiles:${o}.readFiles,modifiedFiles:${o}.modifiedFiles})]})`;

// ---------- R2: 平铺条件拆分（live-tail 原样保留；-1 无终答段折叠进 ProcessDetailsGroup） ----------
const R2 = new RegExp(
  `if\\(-1===${ID}\\|\\|\\(${ID}\\|\\|${ID}\\.isStreaming\\)&&${ID}===${ID}\\.length&&${ID}===${ID}\\)` +
  `\\{for\\(let ${ID}=\\6;\\8<\\4;\\8\\+\\+\\)${ID}\\.push\\(${ID}\\(\\8\\)\\);\\8=\\4;continue\\}`, "g");
// 官方分组分支标识符采收（ProcessDetailsGroup/翻译/块统计等，直接复用=「抄自己」）
const HARVEST = new RegExp(
  `=\\(0,${ID}\\.jsxs\\)\\(${ID},\\{messageCount:[\\w$]+,defaultExpanded:!${ID},t:${ID},toolCallCount:function\\(${ID},${ID}\\)` +
  `\\{let ${ID}=0;for\\(let ${ID} of \\6\\)\\{let ${ID}=\\5\\[\\8\\];\\9\\?\\.role==="assistant"&&\\(\\7\\+=${ID}\\(${ID}\\(\\9\\)\\)\\)\\}return \\7\\}`);
const REFS = new RegExp(`\\.map\\(${ID}=>${ID}\\.get\\(\\1\\)\\)\\.find\\(${ID}=>"number"==typeof \\3\\)`);
const MREFS = new RegExp(`ref:void 0===${ID}\\?void 0:${ID}=>\\{${ID}\\.current\\[\\1\\]=\\2\\},children:${ID}\\},\`process-group-\\$\\{`);

// ---------- R2b: 无终答段的分组默认展开 => 默认折叠 ----------
// 真正主谋：findFinalAssistantIndex 有 assistant 兜底，极少走 -1 分支，
// 多数走分组分支但 defaultExpanded:!finalAnswer 在无终答时展开刷屏。
const R2B = /,defaultExpanded:!([\w$]+),t:([\w$]+),toolCallCount:function/;
function applyR2b(src, label) {
  const m = src.match(R2B); if (!m) die(label + ": R2b 锚点未命中");
  if (m[1] === "1") return { out: src, applied: false };
  return { out: src.replace(R2B, `,defaultExpanded:!1,t:${m[2]},toolCallCount:function`), applied: true };
}

// ---------- R2c: 前导无锚过程段折叠 ----------
// 懒加载把窗口切在段中间时，锚点(user/compaction)不在窗口内，外层循环对无锚消息逐条直排刷屏。
// 处理：live-tail(运行中触底)保持平铺；其余把过程类消息(无答案 assistant/custom)折进
// ProcessDetailsGroup，带答案或错误的 assistant 消息保持独立渲染，不隐藏任何回答。
const LOOPHEAD = new RegExp(
  `${ID}=\\[\\];for\\(let ${ID}=0;\\2<${ID}\\.length;\\)\\{if\\(!${ID}\\(\\3\\[\\2\\]\\)\\)\\{\\1\\.push\\(${ID}\\(\\2\\)\\),\\2\\+=1;continue\\}`);
const BUSYSTRM = new RegExp(`if\\(\\(${ID}\\|\\|${ID}\\.isStreaming\\)&&[\\w$]+===[\\w$]+\\.length&&[\\w$]+===[\\w$]+\\)\\{for\\(let `);
const EVH = new RegExp(`,${ID}=${ID}\\[${ID}\\],${ID}=${ID}\\(\\1\\),[\\w$]+=\\4\\.processBlocks\\.length>0\\?`);
const EXH = new RegExp(`\\.answerBlocks\\.length>0\\|\\|${ID}\\([\\w$]+\\)\\?`);
function applyR2c(src, label) {
  if (src.includes('"process-group-lead-"')) return { out: src, applied: false };
  const lh = src.match(LOOPHEAD); if (!lh) die(label + ": R2c LOOPHEAD 未命中");
  const bs = src.match(BUSYSTRM); if (!bs) die(label + ": R2c BUSYSTRM 未命中(需先应用 R2)");
  const evh = src.match(EVH); if (!evh) die(label + ": R2c EV 未命中");
  const exh = src.match(EXH); if (!exh) die(label + ": R2c EX 未命中");
  const h = src.match(HARVEST); if (!h) die(label + ": R2c HARVEST 未命中");
  const refs = src.match(REFS), mrefs = src.match(MREFS);
  if (!refs || !mrefs) die(label + ": R2c REFS/MREFS 未命中");
  const [, coll, idx, msgs, anch, ren] = lh;
  const busy = bs[1], strm = bs[2], ev = evh[5], ex = exh[1];
  const jsx = h[1], pdg = h[2], tr = h[4], ey = h[10], em = h[11];
  const rmap = refs[2], mref = mrefs[3];
  const body =
    `let pwE2=${idx};for(;pwE2<${msgs}.length&&!${anch}(${msgs}[pwE2]);)pwE2++;` +
    `if((${busy}||${strm}.isStreaming)&&pwE2===${msgs}.length){for(;${idx}<pwE2;${idx}++)${coll}.push(${ren}(${idx}));continue}` +
    `let pwG=[],pwFl=()=>{if(!pwG.length)return;` +
    `let pwR=pwG.map(pwK=>${rmap}.get(pwK)).find(pwV=>"number"==typeof pwV),pwT=0;` +
    `for(let pwK of pwG){let pwM=${msgs}[pwK];pwM?.role==="assistant"&&(pwT+=${ey}(${em}(pwM)))}` +
    `${coll}.push((0,${jsx}.jsx)("div",{ref:void 0===pwR?void 0:pwEl=>{${mref}.current[pwR]=pwEl},` +
    `children:(0,${jsx}.jsx)(${pdg},{messageCount:pwG.length,defaultExpanded:!1,t:${tr},toolCallCount:pwT,` +
    `children:pwG.map(pwK=>${ren}(pwK,{attachRef:!1,keyPrefix:"process"}))})},"process-group-lead-"+pwG[0]));pwG=[]};` +
    `for(;${idx}<pwE2;${idx}++){let pwM=${msgs}[${idx}];` +
    `"assistant"===pwM.role?(${ev}(pwM).answerBlocks.length>0||${ex}(pwM)?(pwFl(),${coll}.push(${ren}(${idx}))):${em}(pwM).length>0&&pwG.push(${idx})):` +
    `"custom"===pwM.role?pwG.push(${idx}):${coll}.push(${ren}(${idx}))}` +
    `pwFl();continue`;
  const out = src.replace(LOOPHEAD, `${coll}=[];for(let ${idx}=0;${idx}<${msgs}.length;){if(!${anch}(${msgs}[${idx}])){${body}}`);
  return { out, applied: true };
}

// ---------- 可重入升级：v1-v3 补齐语义补丁，并换 page chunk URL 绕过 SW cacheFirst ----------
const stage = [
  { name: "v4", file: pageClientNew, hash: PAGE_NEW },
  { name: "v3", file: pageClientV3, hash: PAGE_V3 },
  { name: "v1", file: pageClientV1, hash: PAGE_V1 },
].find((candidate) => fs.existsSync(candidate.file));
if (stage) {
  let cs = fs.readFileSync(stage.file, "utf8");
  let ss = fs.readFileSync(pageServer, "utf8");
  const edits = [];
  const legacyPageWrites = [];
  for (const [get, set, label] of [[() => cs, (v) => (cs = v), "client"], [() => ss, (v) => (ss = v), "server"]]) {
    const b = applyR2b(get(), label); set(b.out); b.applied && edits.push(label + "-r2b");
    const c = applyR2c(get(), label); set(c.out); c.applied && edits.push(label + "-r2c");
    const h = applyR3(get(), label); set(h.out); h.applied && edits.push(label + "-r3-hide-tools");
  }

  // 运行中的 Next 可能继续返回旧 hash；旧 page chunk 也只加 R3，确保当前进程立即生效。
  for (const file of [pageClientOld, pageClientV1, pageClientV3]) {
    if (!fs.existsSync(file)) continue;
    const legacy = applyR3(fs.readFileSync(file, "utf8"), `legacy-${path.basename(file)}`);
    if (legacy.applied) legacyPageWrites.push({ file, out: legacy.out });
  }

  const needsRename = stage.hash !== PAGE_NEW;
  const refEdits = [];
  if (needsRename) {
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (path.resolve(p) === path.resolve(pageServer)) continue;
        const s = fs.readFileSync(p, "utf8");
        const count = s.split(stage.hash).length - 1;
        if (count > 0) refEdits.push({ file: p, count, out: s.replaceAll(stage.hash, PAGE_NEW) });
      }
    })(path.join(PKG, ".next", "server", "app"));
    if (refEdits.reduce((sum, item) => sum + item.count, 0) < 1) die(`${stage.name}: page chunk 引用未找到，拒绝改名`);
    ss = ss.replaceAll(stage.hash, PAGE_NEW);
  }

  if (CHECK) {
    console.log(JSON.stringify({ status: "check-ok", mode: "reentrant", from: stage.name, target: "v4", edits, legacyPageEdits: legacyPageWrites.length, needsRename, refFiles: refEdits.length }));
    process.exit(0);
  }
  if (!edits.length && !legacyPageWrites.length && !needsRename) {
    console.log(JSON.stringify({ status: "already-patched", mode: "v4", hideAgentToolCalls: true, legacyPagesPatched: true, pkg: PKG }));
    process.exit(0);
  }

  // 增量备份保留 v3 折叠行为，便于只回滚“隐藏工具卡”；已有备份绝不覆盖。
  for (const file of [stage.file, pageServer, ...legacyPageWrites.map((item) => item.file), ...refEdits.map((item) => item.file)]) {
    const rel = path.relative(PKG, file);
    const dst = path.join(UPGRADE_BACKUP, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
  }

  fs.writeFileSync(pageClientNew, cs);
  fs.writeFileSync(pageServer, ss);
  for (const item of legacyPageWrites) fs.writeFileSync(item.file, item.out);
  for (const item of refEdits) fs.writeFileSync(item.file, item.out);
  // 不删 stage.file：运行中的 Next 进程可能仍返回旧 hash；保留旧 chunk 才能零中断。
  console.log(JSON.stringify({
    status: "upgraded", from: stage.name, target: "v4", edits,
    hideAgentToolCalls: true, pageRenamed: needsRename, previousPageRetained: needsRename,
    legacyPagesPatched: legacyPageWrites.length, refFilesRenamed: refEdits.length, upgradeBackup: UPGRADE_BACKUP, pkg: PKG,
  }));
  process.exit(0);
}
for (const f of [pageClientOld, layoutOld, pageServer]) if (!fs.existsSync(f)) die("目标文件不存在: " + f);

// ---------- 全新打补丁（异机/重装后一次到位） ----------
function patchBundle(src, label) {
  const h = src.match(HARVEST); if (!h) die(label + ": HARVEST 未命中");
  const refs = src.match(REFS); if (!refs) die(label + ": REFS 未命中");
  const mrefs = src.match(MREFS); if (!mrefs) die(label + ": MREFS 未命中");
  const [, jsx, pdg, , tr, , , , , , ey, em] = h;
  const refsMap = refs[2], msgRefs = mrefs[3];

  let n1 = 0;
  let out = src.replace(R1, (...m) => { n1++; return r1New(m[1], m[2], m[3], m[4], m[5]); });
  if (n1 !== 1) die(label + `: R1 命中 ${n1} 次(期望1)`);

  let n2 = 0;
  out = out.replace(R2, (...m) => {
    n2++;
    const [, fin, busy, stream, end, msgs, anchor, last, loop, coll, render] = m;
    const flat = `if((${busy}||${stream}.isStreaming)&&${end}===${msgs}.length&&${anchor}===${last})` +
      `{for(let ${loop}=${anchor};${loop}<${end};${loop}++)${coll}.push(${render}(${loop}));${loop}=${end};continue}`;
    const fold = `if(-1===${fin}){${coll}.push(${render}(${anchor}));` +
      `let pwF=[];for(let pwK=${anchor}+1;pwK<${end};pwK++){let pwM=${msgs}[pwK];` +
      `("assistant"===pwM.role?${em}(pwM).length>0:"custom"===pwM.role)&&pwF.push(pwK)}` +
      `if(pwF.length>0){let pwR=pwF.map(pwK=>${refsMap}.get(pwK)).find(pwV=>"number"==typeof pwV),pwT=0;` +
      `for(let pwK of pwF){let pwM=${msgs}[pwK];pwM?.role==="assistant"&&(pwT+=${ey}(${em}(pwM)))}` +
      `${coll}.push((0,${jsx}.jsx)("div",{ref:void 0===pwR?void 0:pwE=>{${msgRefs}.current[pwR]=pwE},` +
      `children:(0,${jsx}.jsx)(${pdg},{messageCount:pwF.length,defaultExpanded:!1,t:${tr},toolCallCount:pwT,` +
      `children:pwF.map(pwK=>${render}(pwK,{attachRef:!1,keyPrefix:"process"}))})},"process-group-"+${anchor}+"--1"))}` +
      `${loop}=${end};continue}`;
    return flat + fold;
  });
  if (n2 !== 1) die(label + `: R2 命中 ${n2} 次(期望1)`);
  out = applyR2b(out, label).out;
  const r2c = applyR2c(out, label);
  if (!r2c.applied) die(label + ": R2c 未生效");
  out = r2c.out;
  const r3 = applyR3(out, label);
  if (!r3.applied) die(label + ": R3 工具卡过滤未生效");
  out = r3.out;
  return { out, idents: { jsx, pdg, tr, ey, em, refsMap, msgRefs }, hideAgentToolCalls: true };
}

const clientSrc = fs.readFileSync(pageClientOld, "utf8");
const serverSrc = fs.readFileSync(pageServer, "utf8");
const layoutSrc = fs.readFileSync(layoutOld, "utf8");

const client = patchBundle(clientSrc, "client");
const server = patchBundle(serverSrc, "server");
const legacyClient = applyR3(clientSrc, "legacy-client");
if (!legacyClient.applied) die("legacy-client: R3 工具卡过滤未生效");

const SW_OLD = `encodeURIComponent("${VERSION}")`;
const swCount = layoutSrc.split(SW_OLD).length - 1;
if (swCount !== 1) die(`layout: SW 版本锚点命中 ${swCount} 次(期望1)`);
const layoutPatched = layoutSrc.replace(SW_OLD, `encodeURIComponent("${SW_MARK}")`);

// ---------- R4: 等长改名 + 全量引用替换（绕过 SW 对 /_next/static 的 cacheFirst） ----------
const refCandidates = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else refCandidates.push(p);
  }
})(path.join(PKG, ".next", "server", "app"));
for (const n of ["build-manifest.json", "app-path-routes-manifest.json", "react-loadable-manifest.json", "prerender-manifest.json"]) {
  const p = path.join(PKG, ".next", n);
  if (fs.existsSync(p)) refCandidates.push(p);
}

const refEdits = [];
for (const f of refCandidates) {
  if (path.resolve(f) === path.resolve(pageServer)) continue; // 单独处理
  const s = fs.readFileSync(f, "utf8");
  const cPage = s.split(PAGE_OLD).length - 1, cLay = s.split(LAY_OLD).length - 1;
  if (cPage + cLay === 0) continue;
  refEdits.push({ f, cPage, cLay, out: s.replaceAll(PAGE_OLD, PAGE_NEW).replaceAll(LAY_OLD, LAY_NEW) });
}
const totPage = refEdits.reduce((a, e) => a + e.cPage, 0), totLay = refEdits.reduce((a, e) => a + e.cLay, 0);
if (totPage < 1) die("page chunk 引用未找到，改名会引发 404");
const serverOut = server.out.replaceAll(PAGE_OLD, PAGE_NEW).replaceAll(LAY_OLD, LAY_NEW);

const summary = {
  status: CHECK ? "check-ok" : "patched",
  pkg: PKG, version: VERSION, mark: SW_MARK,
  idents: { client: client.idents, server: server.idents },
  hideAgentToolCalls: client.hideAgentToolCalls && server.hideAgentToolCalls,
  legacyPagesPatched: legacyClient.applied,
  swAnchor: swCount,
  rename: { [`page-${PAGE_OLD}`]: `page-${PAGE_NEW}`, [`layout-${LAY_OLD}`]: `layout-${LAY_NEW}` },
  refEdits: refEdits.map((e) => ({ file: path.relative(PKG, e.f), page: e.cPage, layout: e.cLay })),
  refTotals: { page: totPage, layout: totLay },
};
if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }

// ---------- 备份（保留相对路径；已存在则不覆盖，保证首个备份=原始态） ----------
const toBackup = [pageClientOld, layoutOld, pageServer, ...refEdits.map((e) => e.f)];
for (const f of toBackup) {
  const rel = path.relative(PKG, f);
  const dst = path.join(BACKUP, rel);
  if (fs.existsSync(dst)) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f, dst);
}

// ---------- 落盘（新名写入→引用替换；旧 chunk 同样隐藏工具卡并保留给运行中的旧进程） ----------
fs.writeFileSync(pageClientNew, client.out);
fs.writeFileSync(pageClientOld, legacyClient.out);
fs.writeFileSync(layoutNew, layoutPatched);
fs.writeFileSync(pageServer, serverOut);
for (const e of refEdits) fs.writeFileSync(e.f, e.out);

console.log(JSON.stringify(summary, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
