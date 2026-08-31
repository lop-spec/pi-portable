#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：输入草稿持久化。
// 上游 lib/draft-store.ts 只用进程内 Map 存草稿，页面一重载（手机后台回收、PWA 冷启、
// 断网后重开、刷新、崩溃）已输入但未发送的文本全部丢失。本补丁把 draft-store 的存储后端
// 换成「内存 Map + localStorage 镜像」，调用方（ChatInput/ChatWindow/AppShell）零改动。
//
// 用法: node patch-piweb-draft-persist.mjs [--pkg <包目录>] [--backup <备份目录>] [--check]
// 约束: 仅 0.8.11；锚点命中数不符 => 中止且零写入；幂等可重入（已打则 already-patched）。
// 顺序: 若同时使用 patch-piweb-fold.mjs，必须 **先 fold 后本脚本**（fold 会按旧 chunk 名寻锚）。
// 回滚: 把 backup 目录内容按相对路径拷回 <pkg>，删除 page-<NEW_HASH>.js，重启 pi-web。
//       旧 chunk 一律保留，运行中的旧进程不会 404。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwDraftPersistV1";

const ID = "([\\w$]+)";
// minified 标识符可能是 `t$` 这类含正则元字符的名字，拼进正则前必须转义。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 上游 lib/draft-store.ts 编译后的整段：Map + cloneDraft + isEmptyDraft + getDraft + setDraft + clearDraft
const DRAFT_BLOCK = new RegExp(
  `let ${ID}=new Map;` +
  `function ${ID}\\(${ID}\\)\\{return\\{value:\\3\\.value,images:\\3\\.images\\.map\\(${ID}=>\\(\\{\\.\\.\\.\\4\\}\\)\\)\\}\\}` +
  `function ${ID}\\(${ID}\\)\\{return!\\6\\.value&&0===\\6\\.images\\.length\\}` +
  `function ${ID}\\(${ID}\\)\\{let ${ID}=\\1\\.get\\(\\8\\);return \\9\\?\\2\\(\\9\\):null\\}` +
  `function ${ID}\\(${ID},${ID}\\)\\{\\5\\(\\12\\)\\?\\1\\.delete\\(\\11\\):\\1\\.set\\(\\11,\\2\\(\\12\\)\\)\\}` +
  `function ${ID}\\(${ID}\\)\\{\\1\\.delete\\(\\14\\)\\}`,
  "g");

/**
 * 持久化运行时。要点：
 * - 只镜像文本，图片附件留在内存（单图上限 10MB，写 localStorage 必爆 5MB 配额）。
 * - key 归一化：新会话 draftKey=`new:<随机id>:<cwd>`，随机段每次重载都变，不归一化就对不上。
 * - 惰性水合 + typeof window 守卫：服务端 bundle 与 SSR 阶段零副作用。
 * - 输入防抖 150ms；pagehide/beforeunload/visibilitychange(hidden) 立即 flush（手机后台回收唯一保命路径）。
 * - 任何 localStorage 异常都静默降级为纯内存，绝不打断输入。
 */
export function buildRuntime(mem) {
  return `var pwDS=function(){` +
    `var K="pi-web:drafts:v1",TTL=12096e5,MAXI=50,MAXL=2e5,MAXT=5e5,HY=!1,TM=null,LT=0,IV=null,IVN=0,TS=new Map;` +
    // 单调时间戳：同一毫秒内的连续编辑也要能分出先后，否则配额裁剪会留下最旧的那条。
    `function st(){var n=Date.now();return n<=LT&&(n=LT+1),LT=n,n}` +
    `function ss(){try{return typeof window<"u"&&window.localStorage?window.localStorage:null}catch(e){return null}}` +
    `function nk(k){if("string"!=typeof k)return k;var m=/^new:([^:]*):([\\s\\S]*)$/.exec(k);return m?"new::"+m[2]:k}` +
    `function rd(){var s=ss();if(!s)return null;try{var r=s.getItem(K);if(!r)return null;var d=JSON.parse(r);` +
    `return d&&1===d.v&&d.items&&"object"==typeof d.items?d.items:null}catch(e){return null}}` +
    // 首帧 autosize：composer 挂载时布局还没稳定，上游的 min(scrollHeight,200) 会量成 200px 上限。
    // 恢复出非空草稿时补一次重算（幂等，内容真需要 200px 时结果不变）。
    // 上游的 autosize 是 passive effect（paint 之后才跑），单靠 rAF 会赶在它前面，
    // 所以按几个退避点重算；每次都是幂等的 min(scrollHeight,200)。
    // clientWidth 为 0 = 页面还没布局（后台标签页 / 隐藏窗口），此时 scrollHeight 是按 1 字符宽
    // 折行算出来的垃圾值，量了只会把高度钉死在 200px 上限，所以直接跳过等下一次。
    `function fx1(){var d=!1;try{var l=document.querySelectorAll("textarea");` +
    `for(var i=0;i<l.length;i++){var t=l[i];if(!t.value||!t.style.height||t.clientWidth<80)continue;` +
    `t.style.height="auto";t.style.height=Math.min(t.scrollHeight,200)+"px";d=!0}}catch(e){}return d}` +
    // 一次性调度不够：AppShell 首次 render 会被 Suspense 丢弃重试，composer 真正挂载可能在几秒后。
    // 每次读到非空草稿就把窗口拉满，量准一次即停，最长 2s。
    `function fx(){try{IVN=0;if(IV)return;IV=setInterval(function(){` +
    `(fx1()||++IVN>39)&&(clearInterval(IV),IV=null)},50);` +
    `setTimeout(fx1,0);typeof requestAnimationFrame<"u"&&requestAnimationFrame(function(){requestAnimationFrame(fx1)})}catch(e){}}` +
    `function hy(){if(HY)return;HY=!0;var it=rd();if(!it)return;var now=Date.now(),n=0;` +
    `for(var k in it){var e=it[k];if(!e||"string"!=typeof e.t||!e.t)continue;var t="number"==typeof e.ts?e.ts:0;` +
    `if(now-t>TTL||${mem}.has(k))continue;${mem}.set(k,{value:e.t,images:[]});TS.set(k,t),t>LT&&(LT=t),n++}` +
    `n>0&&fx()}` +
    `function sz(lim){var rows=[];${mem}.forEach(function(v,k){var x=v&&v.value;` +
    `"string"==typeof x&&x&&x.length<=MAXL&&rows.push([k,x,TS.get(k)||0])});` +
    `rows.sort(function(a,b){return b[2]-a[2]});var o={},n=0,tot=0;` +
    `for(var i=0;i<rows.length&&n<lim;i++){if(tot+rows[i][1].length>MAXT)continue;` +
    `o[rows[i][0]]={t:rows[i][1],ts:rows[i][2]};n++;tot+=rows[i][1].length}return o}` +
    `function wr(){var s=ss();if(!s)return;for(var lim=MAXI;;){try{var o=sz(lim);` +
    `if(lim<1||0===Object.keys(o).length){s.removeItem(K);return}s.setItem(K,JSON.stringify({v:1,items:o}));return}` +
    `catch(e){if(lim<1)return;lim=lim>1?Math.floor(lim/2):0}}}` +
    `function fl(){if(null!=TM){clearTimeout(TM);TM=null}wr()}` +
    `function sc(){if(null!=TM)return;TM=setTimeout(function(){TM=null;wr()},150)}` +
    `if(typeof window<"u"&&!window.${MARK}){window.${MARK}=!0;try{` +
    `window.addEventListener("pagehide",fl);window.addEventListener("beforeunload",fl);` +
    // 回到前台时补一次高度重算：页面在后台加载时 composer 量不准，前台化后没人会再触发 autosize。
    `window.addEventListener("visibilitychange",function(){"hidden"===document.visibilityState?fl():fx()});` +
    `window.addEventListener("storage",function(e){if(e.key!==K)return;var it=rd();if(!it)return;` +
    `for(var k in it){var v=it[k];if(!v||"string"!=typeof v.t)continue;var t="number"==typeof v.ts?v.ts:0;` +
    `if(t<=(TS.get(k)||0))continue;var cur=${mem}.get(k);` +
    `${mem}.set(k,{value:v.t,images:cur&&cur.images||[]});TS.set(k,t),t>LT&&(LT=t)}});` +
    `}catch(e){}}` +
    `return{k:nk,h:hy,x:function(v){v&&fx()},t:function(k){TS.set(k,st());sc()},d:function(k){TS.delete(k);fl()},f:fl,` +
    `_dump:function(){hy();var o={};${mem}.forEach(function(v,k){o[k]=v.value});return o}}}();`;
}

export function applyDraftPersistence(src, label = "bundle") {
  if (src.includes(MARK)) return { out: src, applied: false, idents: null };
  const hits = [...src.matchAll(DRAFT_BLOCK)];
  if (hits.length !== 1) {
    throw new Error(`${label}: draft-store 锚点命中 ${hits.length} 次(期望1)，拒绝写入`);
  }
  const m = hits[0];
  const [, mem, clone, , , empty, , get, , , set, , , del] = m;
  const idents = { mem, clone, empty, get, set, del };

  const head =
    `let ${mem}=new Map;` +
    `function ${clone}(e){return{value:e.value,images:e.images.map(e=>({...e}))}}` +
    `function ${empty}(e){return!e.value&&0===e.images.length}`;
  const tail =
    buildRuntime(mem) +
    `function ${get}(e){pwDS.h();let t=${mem}.get(pwDS.k(e));return t?(pwDS.x(t.value),${clone}(t)):null}` +
    `function ${set}(e,t){pwDS.h();let k=pwDS.k(e);${empty}(t)?(${mem}.delete(k),pwDS.d(k)):(${mem}.set(k,${clone}(t)),pwDS.t(k))}` +
    `function ${del}(e){pwDS.h();let k=pwDS.k(e);${mem}.delete(k),pwDS.d(k)}`;

  let out = src.slice(0, m.index) + head + tail + src.slice(m.index + m[0].length);

  // rekeyDraft 的同键短路必须按归一化后的 key 判断，否则 `new:a:cwd` -> `new:b:cwd`
  // 会走合并分支，把同一份草稿和自己拼成 "foo\n\nfoo"。
  const REKEY = new RegExp(
    `function ${ID}\\(${ID},${ID},${ID}\\)\\{if\\(\\2===\\3\\)return \\4\\?${esc(clone)}\\(\\4\\):${esc(get)}\\(\\3\\);`,
    "g");
  const rekeyHits = [...out.matchAll(REKEY)];
  if (rekeyHits.length !== 1) {
    throw new Error(`${label}: rekeyDraft 锚点命中 ${rekeyHits.length} 次(期望1)，拒绝写入`);
  }
  out = out.replace(REKEY, (_all, fn, prev, next, cur) =>
    `function ${fn}(${prev},${next},${cur}){if(pwDS.k(${prev})===pwDS.k(${next}))return ${cur}?${clone}(${cur}):${get}(${next});`);

  // useAgentSession 的 unmount cleanup 会主动丢弃「未发送的新会话」草稿——这正是
  // “在新对话里写了一半、去看别的会话、回来就没了”的通道。发送成功走的是 clearInput，
  // 手动清空走的是 setDraft(empty)，两条都还会正常删除，所以这里只停掉自动丢弃。
  const ABANDON = new RegExp(
    `(queueMicrotask\\(\\(\\)=>\\{${ID}\\.current\\|\\|${ID}\\.current\\|\\|)${esc(del)}\\(${ID}\\)(\\}\\))`,
    "g");
  const abandonHits = [...out.matchAll(ABANDON)];
  if (abandonHits.length !== 1) {
    throw new Error(`${label}: 新会话草稿丢弃锚点命中 ${abandonHits.length} 次(期望1)，拒绝写入`);
  }
  out = out.replace(ABANDON, (_all, head, _mounted, _promoted, _key, tail) => `${head}void 0${tail}`);

  return { out, applied: true, idents };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-draft"));

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

  // 当前生效的 page chunk 以 server 侧引用为准（fold 补丁可能已改过名）
  const manifest = path.join(PKG, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("找不到 page_client-reference-manifest.js");
  const refHashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/g)].map((m) => m[1]),
  )];
  if (refHashes.length !== 1) die(`page chunk 引用解析异常: ${JSON.stringify(refHashes)}`);
  const CUR_HASH = refHashes[0];
  if (CUR_HASH.length < 8) die(`page chunk hash 过短，无法安全改名: ${CUR_HASH}`);
  // chunk 名派生自注入代码本身：补丁内容一变，URL 就变，SW 的 /_next/static cacheFirst
  // 才会去取新文件（同名换内容会让老客户端永远吃缓存）。长度对齐原 hash，引用替换是等长的。
  const patchFingerprint = crypto.createHash("sha1")
    .update(buildRuntime("MEM"))
    .update(applyDraftPersistence.toString())
    .digest("hex");
  const NEW_HASH = ("pwd" + patchFingerprint).slice(0, CUR_HASH.length);

  const chunkDir = path.join(PKG, ".next", "static", "chunks", "app");
  const curChunk = path.join(chunkDir, `page-${CUR_HASH}.js`);
  if (!fs.existsSync(curChunk)) die("当前 page chunk 不存在: " + curChunk);
  const src = fs.readFileSync(curChunk, "utf8");

  if (src.includes(MARK)) {
    console.log(JSON.stringify({ status: "already-patched", pkg: PKG, chunk: path.basename(curChunk) }));
    process.exit(0);
  }
  const foldApplied = src.includes('"process-group-lead-"');

  let patched;
  try { patched = applyDraftPersistence(src, "client"); }
  catch (error) { die(error instanceof Error ? error.message : String(error)); }

  const newChunk = path.join(chunkDir, `page-${NEW_HASH}.js`);
  // --revert 只恢复引用、不删文件，所以目标名可能残留上一轮的孤儿 chunk：带本补丁标记的可安全覆盖。
  if (CUR_HASH !== NEW_HASH && fs.existsSync(newChunk) && !fs.readFileSync(newChunk, "utf8").includes(MARK)) {
    die(`目标 chunk 已存在且不是本补丁产物，拒绝覆盖: ${newChunk}`);
  }

  // 改名绕过 SW 对 /_next/static/ 的 cacheFirst；引用替换覆盖 server/app 全树 + 根 manifest
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
      const s = fs.readFileSync(f, "utf8");
      const count = s.split(CUR_HASH).length - 1;
      if (count > 0) refEdits.push({ file: f, count, out: s.replaceAll(CUR_HASH, NEW_HASH) });
    }
    if (refEdits.reduce((a, e) => a + e.count, 0) < 1) die("page chunk 引用未找到，拒绝改名（会 404）");
  }

  const summary = {
    status: CHECK ? "check-ok" : "patched",
    pkg: PKG, version: VERSION,
    chunk: { from: `page-${CUR_HASH}.js`, to: `page-${NEW_HASH}.js`, renamed: CUR_HASH !== NEW_HASH },
    idents: patched.idents,
    foldPatchDetected: foldApplied,
    refEdits: refEdits.map((e) => ({ file: path.relative(PKG, e.file), count: e.count })),
    backup: BACKUP,
  };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }
  if (!foldApplied) console.error("[WARN] 未检测到 fold 补丁标记；若之后再跑 patch-piweb-fold.mjs，需重新执行本脚本。");

  for (const f of [curChunk, ...refEdits.map((e) => e.file)]) {
    const dst = path.join(BACKUP, path.relative(PKG, f));
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
  }

  fs.writeFileSync(newChunk, patched.out);
  for (const e of refEdits) fs.writeFileSync(e.file, e.out);
  // 旧 chunk 保留：运行中的 Next 进程可能仍按旧 hash 派发请求。
  console.log(JSON.stringify(summary, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
