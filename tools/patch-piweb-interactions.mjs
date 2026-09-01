#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：
// 1) ChatInput 接收系统剪贴板中的文件。图片继续走原生图片附件链；普通文件复用
//    /api/files 上传到会话 cwd，随后在光标处插入 @文件引用。纯文本粘贴仍交给浏览器。
// 2) 聊天视口离开底部时显示轻量悬浮按钮，点击平滑回到底部，到底后自动隐藏。
//
// 用法: node patch-piweb-interactions.mjs [--pkg <包目录>] [--backup <备份目录>] [--check]
// 约束: 仅 0.8.11；所有锚点先完整校验，任一不符则零写入；幂等可重入。
// 顺序: patch-piweb-fold -> patch-piweb-draft-persist -> 本脚本。
// 回滚: --revert 恢复备份中的引用/原 chunk，生成的新 chunk 保留为无引用孤儿；重启 pi-web。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwPasteAndScrollV2";
export const PATCH_REVISION = "r2";

/**
 * 将浏览器 Clipboard/DataTransfer 归一化为一次粘贴计划。
 * - items 优先，files 仅作浏览器兼容回退，避免同一文件被枚举两次。
 * - 图片 MIME 为空时按扩展名补判（Windows Explorer/部分 Chromium 会这样暴露）。
 * - Electron 类壳若提供 File.path，或剪贴板同时给出绝对路径文本，则普通文件直接引用；
 *   常规浏览器拿不到绝对路径时由调用方上传文件内容。
 * - 文件管理器自动附带的“文件名/路径文本”会去重；真正的混合文本会保留。
 */
export function getClipboardPastePlan(clipboardData) {
  const items = Array.from(clipboardData?.items ?? []);
  const itemFiles = items
    .filter((item) => item?.kind === "file" || (typeof item?.getAsFile === "function" && item?.type !== "text/plain"))
    .map((item) => {
      try { return item.getAsFile(); } catch { return null; }
    })
    .filter((file) => file && typeof file.name === "string");
  const files = itemFiles.length > 0
    ? itemFiles
    : Array.from(clipboardData?.files ?? []).filter((file) => file && typeof file.name === "string");

  let rawText = "";
  try {
    rawText = clipboardData?.getData?.("text/plain") || clipboardData?.getData?.("text") || "";
  } catch {
    rawText = "";
  }

  const imageMimeByExtension = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    avif: "image/avif", heic: "image/heic", heif: "image/heif",
  };
  const normalizePath = (value) => String(value ?? "").trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
  const isAbsolutePath = (value) => /^[a-zA-Z]:\//.test(value) || value.startsWith("//") || value.startsWith("/");
  const fromFileUri = (value) => {
    if (!/^file:\/\//i.test(value)) return null;
    try {
      const url = new URL(value);
      let pathname = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
      return normalizePath(url.host ? `//${url.host}${pathname}` : pathname);
    } catch {
      return null;
    }
  };
  const textLines = rawText.trim()
    ? rawText.trim().split(/\r?\n/).map(normalizePath).filter(Boolean)
    : [];
  const absoluteTextPaths = textLines
    .map((line) => fromFileUri(line) ?? line)
    .filter(isAbsolutePath);
  const basename = (value) => normalizePath(value).replace(/\/+$/, "").split("/").pop() ?? "";
  const pathForFile = (file) => {
    const direct = normalizePath(file?.path);
    if (isAbsolutePath(direct)) return direct;
    const wanted = String(file?.name ?? "").toLowerCase();
    return absoluteTextPaths.find((candidate) => basename(candidate).toLowerCase() === wanted) ?? null;
  };

  const images = [];
  const others = [];
  const paths = [];
  for (const file of files) {
    const type = String(file.type ?? "").toLowerCase();
    const extension = String(file.name).toLowerCase().split(".").pop() ?? "";
    const inferredMime = imageMimeByExtension[extension] ?? "";
    const mimeType = type.startsWith("image/")
      ? type
      : ((!type || type === "application/octet-stream") ? inferredMime : "");
    if (mimeType) {
      images.push({ file, mimeType });
      continue;
    }
    const directPath = pathForFile(file);
    if (directPath) paths.push(directPath);
    else others.push(file);
  }

  const generatedNameText = textLines.length > 0
    && textLines.length <= files.length
    && textLines.every((line) => files.some((file) => {
      const name = String(file.name ?? "").toLowerCase();
      const normalized = normalizePath(fromFileUri(line) ?? line).toLowerCase();
      return normalized === name || (isAbsolutePath(normalized) && basename(normalized).toLowerCase() === name);
    }));

  return {
    files,
    images,
    others,
    paths,
    text: generatedNameText ? "" : rawText,
    shouldPreventDefault: files.length > 0,
  };
}

export function normalizeClipboardImages(entries) {
  return entries.map(({ file, mimeType }) => {
    if (file.type === mimeType || typeof File !== "function") return file;
    try {
      return new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
    } catch {
      return file;
    }
  });
}

export function formatAtMentions(paths) {
  return paths.map((filePath) => {
    const normalized = (/^[a-zA-Z]:[\\/]/.test(filePath) || String(filePath).startsWith("\\\\"))
      ? String(filePath).replace(/\\/g, "/")
      : String(filePath);
    const escaped = normalized.replace(/"/g, '\\"');
    return /\s/.test(escaped) ? `@"${escaped}"` : `@${escaped}`;
  }).join(" ");
}

/** 上传普通剪贴板文件到当前 cwd；冲突时只改本次上传名，绝不覆盖已有资产。 */
export async function uploadClipboardFiles(files, cwd, options = {}) {
  if (!cwd) throw new Error("请先打开项目，再粘贴普通文件");
  const fetcher = options.fetch ?? fetch;
  const FormDataCtor = options.FormData ?? FormData;
  const now = options.now ?? Date.now;
  const maxSingleBytes = 25 * 1024 * 1024;
  const maxTotalBytes = 100 * 1024 * 1024;
  const tooLarge = files.find((file) => Number(file.size) > maxSingleBytes);
  if (tooLarge) throw new Error(`${tooLarge.name} 超过 25 MB 上传上限`);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (totalBytes > maxTotalBytes) throw new Error("本次粘贴文件总大小超过 100 MB 上传上限");

  const encodedCwd = String(cwd).replace(/\\/g, "/")
    .split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const send = async (names) => {
    const body = new FormDataCtor();
    files.forEach((file, index) => body.append("files", file, names[index]));
    const response = await fetcher(`/api/files/${encodedCwd}?type=upload&conflict=error`, {
      method: "POST",
      body,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };
  const originalNames = files.map((file) => file.name);
  let result = await send(originalNames);
  if (result.response.status === 409) {
    const stamp = String(now());
    const conflictSafeNames = originalNames.map((name, index) => {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      return `${base}.pasted-${stamp}-${index + 1}${extension}`;
    });
    result = await send(conflictSafeNames);
  }
  if (!result.response.ok) {
    throw new Error(result.data.error ?? `文件上传失败 (HTTP ${result.response.status})`);
  }
  const errors = Array.isArray(result.data.errors)
    ? result.data.errors.map((item) => typeof item === "string" ? item : `${item.name ?? "file"}: ${item.error ?? "upload failed"}`)
    : [];
  return {
    uploaded: Array.isArray(result.data.uploaded) ? result.data.uploaded : [],
    errors,
  };
}

export function isAwayFromBottom(scrollTop, clientHeight, scrollHeight, tolerance = 8) {
  return scrollTop + clientHeight < scrollHeight - tolerance;
}

export function buildInteractionRuntime() {
  return `function(){var ${MARK}=1;return{` +
    `plan:${getClipboardPastePlan.toString()},` +
    `normalizeImages:${normalizeClipboardImages.toString()},` +
    `mentions:${formatAtMentions.toString()},` +
    `upload:${uploadClipboardFiles.toString()}` +
    `}}()`;
}

const PASTE_HANDLER = /([\w$]+)=\(0,([\w$]+)\.useCallback\)\(([\w$]+)=>\{let ([\w$]+)=Array\.from\(\3\.clipboardData\?\.items\?\?\[\]\)\.filter\(([\w$]+)=>\5\.type\.startsWith\("image\/"\)\);\4\.length&&\(\3\.preventDefault\(\),([\w$]+)\(\4\.map\(([\w$]+)=>\7\.getAsFile\(\)\)\.filter\(([\w$]+)=>null!==\8\)\)\)\},\[\6\]\)/g;
const INSERT_METHOD = /insertText\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\.current;if\(!\2\)return void ([\w$]+)\([\w$]+=>[\s\S]{0,900}?([\w$]+)\.current=([\w$]+),\4\(\6\),([\w$]+)\(null\),requestAnimationFrame/g;
const CWD_FETCH = /fetch\(`\/api\/skills\?cwd=\$\{encodeURIComponent\(([\w$]+)\)\}`\)/g;
const MODEL_BANNERS = /\(0,([\w$]+)\.jsx\)\(([\w$]+),\{error:([\w$]+)\}\),\(0,\1\.jsx\)\(([\w$]+),\{warnings:([\w$]+)\}\),/g;
const SCROLL_STATE = /([\w$]+)=\(0,([\w$]+)\.useCallback\)\(\(\)=>\{([\w$]+)\(([\w$]+)=>Math\.max\(\4,2\*([\w$]+)\.length\)\)\},\[\5\.length\]\),([\w$]+)=([\w$]+)&&0===\5\.length&&!([\w$]+)\.isStreaming&&!([\w$]+),([\w$]+)=!!\8\.streamingMessage\?\.content\.length/g;
const SCROLL_CONTAINER = /ref:([\w$]+),className:"min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 \[scrollbar-width:none\]"/g;
const PROMPT_LAYOUT_EFFECT = /;\(0,([\w$]+)\.useLayoutEffect\)\(\(\)=>\{let ([\w$]+)=([\w$]+)\.current;if\(!([\w$]+)\|\|!([\w$]+)\)/g;
const VIEWPORT_TAIL = /,([\w$]+)\?null:\(0,([\w$]+)\.jsx\)\(([\w$]+),\{messages:([\w$]+),streamingMessage:([\w$]+)\.streamingMessage,scrollContainer:([\w$]+),messageRefs:([\w$]+),onRevealHistory:([\w$]+)\}\)\]\}\)/g;

function requireOne(src, regex, label) {
  regex.lastIndex = 0;
  const matches = [...src.matchAll(regex)];
  if (matches.length !== 1) throw new Error(`${label} 锚点命中 ${matches.length} 次(期望1)，拒绝写入`);
  return matches[0];
}

export function applyPiWebInteractions(src, label = "bundle") {
  if (src.includes(MARK)) return { out: src, applied: false, idents: null };

  // 先收齐全部锚点，任何失败都发生在构造 edits 前，保证调用方零写入。
  const paste = requireOne(src, PASTE_HANDLER, `${label}: 文件粘贴 handler`);
  const insert = requireOne(src, INSERT_METHOD, `${label}: 输入插入方法`);
  const banners = requireOne(src, MODEL_BANNERS, `${label}: 输入状态栏`);
  const scrollState = requireOne(src, SCROLL_STATE, `${label}: 聊天状态`);
  const scrollContainer = requireOne(src, SCROLL_CONTAINER, `${label}: 滚动容器`);
  const promptEffect = requireOne(src, PROMPT_LAYOUT_EFFECT, `${label}: 布局 effect`);
  const viewportTail = requireOne(src, VIEWPORT_TAIL, `${label}: 视口尾部`);

  const cwdWindow = src.slice(paste.index, paste.index + 6000);
  const cwdRelative = requireOne(cwdWindow, CWD_FETCH, `${label}: ChatInput cwd`);
  const cwd = cwdRelative[1];

  const pasteName = paste[1];
  const react = paste[2];
  const event = paste[3];
  const addImages = paste[6];
  const textareaRef = insert[3];
  const setValue = insert[4];
  const valueRef = insert[5];
  const setAtQuery = insert[7];

  if (scrollState[2] !== react || promptEffect[1] !== react) {
    throw new Error(`${label}: React 标识符不一致，拒绝写入`);
  }
  const messages = scrollState[5];
  const isEmptyNew = scrollState[6];
  const streamState = scrollState[8];
  const hasStreamingContent = scrollState[10];
  const scrollRef = scrollContainer[1];
  if (viewportTail[2] !== banners[1] || viewportTail[4] !== messages || viewportTail[5] !== streamState || viewportTail[6] !== scrollRef || viewportTail[8] !== scrollState[1]) {
    throw new Error(`${label}: 滚动视口标识符交叉校验失败，拒绝写入`);
  }

  const insertCallback =
    `pwPasteRuntime=${buildInteractionRuntime()},` +
    `pwPasteState=(0,${react}.useState)({busy:!1,error:null}),pwPasteStatus=pwPasteState[0],pwSetPasteStatus=pwPasteState[1],` +
    `pwPasteSeq=(0,${react}.useRef)(0),` +
    `pwPasteInsert=(0,${react}.useCallback)((e,t=!1)=>{if(!e)return;let n=${textareaRef}.current;` +
    `if(!n){${setValue}(n=>{let r=t&&n&&!/\\s$/.test(n)?" ":"",i=n+r+e;return ${valueRef}.current=i,i}),${setAtQuery}(null);return}` +
    `let r=n.selectionStart??n.value.length,i=n.selectionEnd??n.value.length,o=n.value.slice(0,r),s=n.value.slice(i),` +
    `l=t&&o&&!/\\s$/.test(o)?" ":"",a=t&&s&&!/^\\s/.test(s)?" ":"",d=o+l+e+a+s,c=o.length+l.length+e.length;` +
    `${valueRef}.current=d,${setValue}(d),${setAtQuery}(null),requestAnimationFrame(()=>{n.isConnected&&(n.focus(),n.setSelectionRange(c,c),` +
    `n.style.height="auto",n.style.height=Math.min(n.scrollHeight,200)+"px")})},[]),` +
    `${pasteName}=(0,${react}.useCallback)(async ${event}=>{let pwPayload=pwPasteRuntime.plan(${event}.clipboardData);` +
    `if(!pwPayload.shouldPreventDefault)return;${event}.preventDefault();let pwSeq=++pwPasteSeq.current;` +
    `pwSetPasteStatus({busy:!1,error:null}),pwPayload.text&&pwPasteInsert(pwPayload.text),` +
    `pwPayload.images.length&&${addImages}(pwPasteRuntime.normalizeImages(pwPayload.images)),` +
    `pwPayload.paths.length&&pwPasteInsert(pwPasteRuntime.mentions(pwPayload.paths),!0);` +
    `if(!pwPayload.others.length)return;pwSetPasteStatus({busy:!0,error:null});try{` +
    `let pwResult=await pwPasteRuntime.upload(pwPayload.others,${cwd});` +
    `pwResult.uploaded.length&&pwPasteInsert(pwPasteRuntime.mentions(pwResult.uploaded),!0),` +
    `pwSeq===pwPasteSeq.current&&pwSetPasteStatus({busy:!1,error:pwResult.errors.length?pwResult.errors.join("; "):null})` +
    `}catch(pwError){pwSeq===pwPasteSeq.current&&pwSetPasteStatus({busy:!1,error:pwError instanceof Error?pwError.message:String(pwError)})}` +
    `},[${addImages},${cwd},pwPasteInsert])`;

  const jsx = banners[1];
  const statusBanner = banners[0] +
    `(pwPasteStatus.busy||pwPasteStatus.error)&&(0,${jsx}.jsx)("div",{role:pwPasteStatus.error?"alert":"status","aria-live":"polite",` +
    `style:{maxHeight:80,marginBottom:8,padding:"7px 10px",overflowY:"auto",border:"1px solid "+` +
    `(pwPasteStatus.error?"rgba(239,68,68,0.3)":"var(--border)"),borderRadius:6,background:pwPasteStatus.error?` +
    `"rgba(239,68,68,0.07)":"var(--bg-panel)",color:pwPasteStatus.error?"rgb(239,68,68)":"var(--text-muted)",fontSize:11,lineHeight:1.45},` +
    `children:pwPasteStatus.error?"文件粘贴失败："+pwPasteStatus.error:"正在粘贴文件…"}),`;

  const scrollPrefix = scrollState[0].slice(0, scrollState[0].lastIndexOf(`,${hasStreamingContent}=`));
  const scrollBindings = scrollPrefix +
    `,pwScrollAway=${isAwayFromBottom.toString()},pwScrollState=(0,${react}.useState)(!1),` +
    `pwShowScroll=pwScrollState[0],pwSetScroll=pwScrollState[1],` +
    `pwScrollCheck=(0,${react}.useCallback)(()=>{let e=${scrollRef}.current;pwSetScroll(!!e&&pwScrollAway(e.scrollTop,e.clientHeight,e.scrollHeight))},[${scrollRef}]),` +
    `pwScrollGo=(0,${react}.useCallback)(()=>{let e=${scrollRef}.current;e&&e.scrollTo({top:e.scrollHeight,behavior:"smooth"})},[${scrollRef}]),` +
    `${hasStreamingContent}=!!${streamState}.streamingMessage?.content.length`;

  const scrollEffects =
    `;(0,${react}.useEffect)(()=>{let e=${scrollRef}.current;if(!e)return pwSetScroll(!1),void 0;let t=null,n=()=>{` +
    `null===t&&(t=requestAnimationFrame(()=>{t=null,pwScrollCheck()}))};e.addEventListener("scroll",n,{passive:!0});` +
    `let r="undefined"==typeof ResizeObserver?null:new ResizeObserver(n);return r?.observe(e),e.firstElementChild&&r?.observe(e.firstElementChild),n(),()=>{` +
    `e.removeEventListener("scroll",n),r?.disconnect(),null!==t&&cancelAnimationFrame(t)}},[${isEmptyNew},${messages}.length,${scrollRef},pwScrollCheck]);` +
    `(0,${react}.useEffect)(()=>{let e=requestAnimationFrame(pwScrollCheck);return()=>cancelAnimationFrame(e)},` +
    `[${messages}.length,${streamState}.streamingMessage,pwScrollCheck])`;

  const minimapGuard = viewportTail[1];
  const minimapComponent = viewportTail[3];
  const messageRefs = viewportTail[7];
  const revealHistory = viewportTail[8];
  const scrollButton =
    `,pwShowScroll&&(0,${jsx}.jsx)("button",{type:"button","data-pw-scroll-bottom":"true",onClick:pwScrollGo,title:"回到底部","aria-label":"回到底部",` +
    `style:{position:"absolute",left:"50%",bottom:12,zIndex:30,display:"flex",alignItems:"center",justifyContent:"center",width:30,height:30,` +
    `padding:0,transform:"translateX(-50%)",border:"1px solid var(--border)",borderRadius:8,background:"color-mix(in srgb, var(--bg-panel) 92%, transparent)",` +
    `color:"var(--text-muted)",boxShadow:"0 4px 14px rgba(0,0,0,0.16)",cursor:"pointer",transition:"background 0.12s,color 0.12s,border-color 0.12s"},` +
    `onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color="var(--text)"},` +
    `onMouseLeave:e=>{e.currentTarget.style.background="color-mix(in srgb, var(--bg-panel) 92%, transparent)",e.currentTarget.style.color="var(--text-muted)"},` +
    `children:(0,${jsx}.jsx)("svg",{width:"15",height:"15",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",` +
    `strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":"true",children:(0,${jsx}.jsx)("polyline",{points:"6 9 12 15 18 9"})})}),` +
    `${minimapGuard}?null:(0,${jsx}.jsx)(${minimapComponent},{messages:${messages},streamingMessage:${streamState}.streamingMessage,` +
    `scrollContainer:${scrollRef},messageRefs:${messageRefs},onRevealHistory:${revealHistory}})]})`;

  const edits = [
    { start: paste.index, end: paste.index + paste[0].length, text: insertCallback, label: "paste" },
    { start: banners.index, end: banners.index + banners[0].length, text: statusBanner, label: "status" },
    { start: scrollState.index, end: scrollState.index + scrollState[0].length, text: scrollBindings, label: "scroll-state" },
    { start: promptEffect.index, end: promptEffect.index, text: scrollEffects, label: "scroll-effects" },
    { start: viewportTail.index, end: viewportTail.index + viewportTail[0].length, text: scrollButton, label: "scroll-button" },
  ].sort((a, b) => b.start - a.start);

  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) {
      throw new Error(`${label}: 补丁区间重叠 ${edits[index - 1].label}/${edits[index].label}，拒绝写入`);
    }
  }
  let out = src;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  if (!out.includes(MARK) || !out.includes('"data-pw-scroll-bottom":"true"')) {
    throw new Error(`${label}: 补丁后标记校验失败，拒绝写入`);
  }

  return {
    out,
    applied: true,
    idents: { react, addImages, cwd, textareaRef, setValue, valueRef, setAtQuery, scrollRef, messages, streamState },
  };
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const CHECK = args.includes("--check");
  const PKG = argVal("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const BACKUP = argVal("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", "backup-0.8.11-pre-interactions"));
  const VERSION = "0.8.11";
  const die = (message) => { console.error("[ABORT] " + message); process.exit(1); };

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
        if (entry.isDirectory()) { walk(source); continue; }
        const relative = path.relative(BACKUP, source);
        const destination = path.join(PKG, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        restored.push(relative);
      }
    })(BACKUP);
    console.log(JSON.stringify({ status: "reverted", pkg: PKG, restored, note: "重启 pi-web 后生效" }, null, 1));
    process.exit(0);
  }

  const manifest = path.join(PKG, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("找不到 page_client-reference-manifest.js");
  const refHashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/g)].map((match) => match[1]),
  )];
  if (refHashes.length !== 1) die(`page chunk 引用解析异常: ${JSON.stringify(refHashes)}`);
  const currentHash = refHashes[0];
  if (currentHash.length < 8) die(`page chunk hash 过短，无法安全改名: ${currentHash}`);

  const fingerprint = crypto.createHash("sha1")
    .update(PATCH_REVISION)
    .update(buildInteractionRuntime())
    .update(isAwayFromBottom.toString())
    .update(applyPiWebInteractions.toString())
    .digest("hex");
  const nextHash = ("pwi" + fingerprint).slice(0, currentHash.length);
  const chunkDirectory = path.join(PKG, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDirectory, `page-${currentHash}.js`);
  if (!fs.existsSync(currentChunk)) die("当前 page chunk 不存在: " + currentChunk);
  const source = fs.readFileSync(currentChunk, "utf8");

  if (source.includes(MARK)) {
    console.log(JSON.stringify({ status: "already-patched", pkg: PKG, chunk: path.basename(currentChunk) }));
    process.exit(0);
  }

  let patched;
  try { patched = applyPiWebInteractions(source, "client"); }
  catch (error) { die(error instanceof Error ? error.message : String(error)); }

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
        if (entry.isDirectory()) walk(candidate); else candidates.push(candidate);
      }
    })(path.join(PKG, ".next", "server", "app"));
    for (const name of ["build-manifest.json", "app-build-manifest.json", "react-loadable-manifest.json"]) {
      const candidate = path.join(PKG, ".next", name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
    for (const file of candidates) {
      const text = fs.readFileSync(file, "utf8");
      const count = text.split(currentHash).length - 1;
      if (count > 0) referenceEdits.push({ file, count, out: text.replaceAll(currentHash, nextHash) });
    }
    if (referenceEdits.reduce((sum, edit) => sum + edit.count, 0) < 1) die("page chunk 引用未找到，拒绝改名（会 404）");
  }

  const summary = {
    status: CHECK ? "check-ok" : "patched",
    pkg: PKG,
    version: VERSION,
    chunk: { from: `page-${currentHash}.js`, to: `page-${nextHash}.js`, renamed: currentHash !== nextHash },
    idents: patched.idents,
    draftPatchDetected: source.includes("__pwDraftPersistV1"),
    foldPatchDetected: source.includes('"process-group-lead-"'),
    refEdits: referenceEdits.map((edit) => ({ file: path.relative(PKG, edit.file), count: edit.count })),
    backup: BACKUP,
  };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); process.exit(0); }

  for (const file of [currentChunk, ...referenceEdits.map((edit) => edit.file)]) {
    const destination = path.join(BACKUP, path.relative(PKG, file));
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  fs.writeFileSync(nextChunk, patched.out);
  for (const edit of referenceEdits) fs.writeFileSync(edit.file, edit.out);
  // 旧 chunk 保留，避免运行中的 Next 进程或旧标签页请求旧 URL 时 404。
  console.log(JSON.stringify(summary, null, 1));
}

const realPathOf = (candidate) => { try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); } };
if (process.argv[1] && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()) main();
