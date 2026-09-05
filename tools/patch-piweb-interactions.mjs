#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：
// 1) ChatInput 接收系统剪贴板中的文件。图片继续走原生图片附件链；普通文件复用
//    /api/files 上传到会话 cwd，随后在光标处插入 @文件引用。纯文本粘贴仍交给浏览器。
// 2) 聊天视口离开底部时显示轻量悬浮按钮，点击平滑回到底部，到底后自动隐藏。
// 3) 输入区增加目标/计划自动追问入口；模型选择器收成图标并移到入口右侧。
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
export const FOLLOWUP_MARK = "__pwFollowupModeV1";
export const FOLLOWUP_RELOAD_MARK = "__pwFollowupReloadV1";
export const PATCH_REVISION = "r5";
export const COMPOSER_MARK = "__pwComposerControlsV1";

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

function buildFollowupMenu(jsx, streaming, sendMode) {
  const action = (id, label, detail) =>
    `(0,${jsx}.jsxs)("button",{type:"button",role:"menuitem","data-lop-followup-action":${JSON.stringify(id)},` +
    `onClick:()=>{void ${sendMode}(${JSON.stringify(id)})},style:{display:"flex",flexDirection:"column",alignItems:"flex-start",` +
    `gap:2,minWidth:0,padding:"8px 10px",border:"1px solid var(--border)",borderRadius:6,background:"none",` +
    `color:"var(--text)",cursor:"pointer",textAlign:"left",transition:"background 0.12s ease-out, border-color 0.12s ease-out"},` +
    `onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.borderColor="color-mix(in srgb, var(--accent) 35%, var(--border))"},` +
    `onMouseLeave:e=>{e.currentTarget.style.background="none",e.currentTarget.style.borderColor="var(--border)"},children:[` +
    `(0,${jsx}.jsx)("span",{style:{fontSize:12,fontWeight:600,lineHeight:1.35},children:${JSON.stringify(label)}}),` +
    `(0,${jsx}.jsx)("span",{style:{fontSize:11,lineHeight:1.35,color:"var(--text-dim)",whiteSpace:"nowrap"},children:${JSON.stringify(detail)}})]})`;

  return `(0,${jsx}.jsxs)("div",{ref:__pwModeRef,style:{position:"relative",flexShrink:0},` +
    `onKeyDown:e=>{"Escape"===e.key&&__pwModeOpen&&(e.preventDefault(),e.stopPropagation(),__pwSetModeOpen(!1),__pwSetModeError(null))},` +
    `onBlur:e=>{e.currentTarget.contains(e.relatedTarget)||__pwSetModeOpen(!1)},children:[` +
    `(0,${jsx}.jsx)("button",{type:"button",disabled:${streaming},title:${streaming}?"模型运行中":"自动追问模式",` +
    `"aria-label":"自动追问模式","aria-haspopup":"menu","aria-expanded":__pwModeOpen,"data-lop-followup-mode":${JSON.stringify(FOLLOWUP_MARK)},` +
    `onClick:()=>{${streaming}||(__pwSetModeError(null),__pwSetModeOpen(e=>!e))},style:{display:"flex",alignItems:"center",justifyContent:"center",` +
    `width:32,height:32,padding:0,border:"none",borderRadius:8,background:__pwModeOpen?"var(--bg-hover)":"none",` +
    `color:"var(--text-muted)",cursor:${streaming}?"not-allowed":"pointer",opacity:${streaming}?.5:1,transition:"background 0.12s ease-out, color 0.12s ease-out"},` +
    `onMouseEnter:e=>{${streaming}||(e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color="var(--text)")},` +
    `onMouseLeave:e=>{e.currentTarget.style.background=__pwModeOpen?"var(--bg-hover)":"none",e.currentTarget.style.color="var(--text-muted)"},` +
    `children:(0,${jsx}.jsxs)("svg",{width:"15",height:"15",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.9",` +
    `strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":"true",children:[` +
    `(0,${jsx}.jsx)("line",{x1:"12",y1:"5",x2:"12",y2:"19"}),(0,${jsx}.jsx)("line",{x1:"5",y1:"12",x2:"19",y2:"12"})]})}),` +
    `__pwModeOpen&&(0,${jsx}.jsxs)("div",{role:"menu","aria-label":"自动追问模式",style:{position:"absolute",left:0,bottom:"calc(100% + 6px)",` +
    `zIndex:510,width:248,maxWidth:"calc(100vw - 24px)",padding:8,border:"1px solid var(--border)",borderRadius:8,background:"var(--bg)",` +
    `boxShadow:"0 -4px 16px rgba(0,0,0,0.10)"},children:[` +
    `(0,${jsx}.jsx)("div",{style:{padding:"2px 2px 6px",fontSize:11,fontWeight:600,color:"var(--text-muted)"},children:"目标"}),` +
    `(0,${jsx}.jsxs)("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4},children:[` +
    action("thorough", "彻底", "不够彻底") + `,` + action("target", "达标", "未达标") + `,` +
    action("root-cause", "根因", "非根因") + `,` + action("root-fix", "根治", "未根治") + `]}),` +
    `(0,${jsx}.jsx)("div",{style:{padding:"10px 2px 6px",fontSize:11,fontWeight:600,color:"var(--text-muted)"},children:"计划"}),` +
    action("plan", "校准并执行", "确认方案后自动执行") + `,` +
    `(0,${jsx}.jsx)("div",{style:{height:1,margin:"8px 0",background:"var(--border)"}}),` +
    `(0,${jsx}.jsx)("button",{type:"button",role:"menuitem","data-lop-followup-action":"off",onClick:()=>{void ${sendMode}("off")},` +
    `style:{width:"100%",padding:"7px 8px",border:"none",borderRadius:6,background:"none",color:"var(--text-muted)",cursor:"pointer",fontSize:12,textAlign:"left"},` +
    `onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color="var(--text)"},` +
    `onMouseLeave:e=>{e.currentTarget.style.background="none",e.currentTarget.style.color="var(--text-muted)"},children:"停止自动追问"}),` +
    `__pwModeError&&(0,${jsx}.jsx)("div",{role:"alert",style:{marginTop:6,padding:"6px 8px",borderRadius:6,background:"rgba(239,68,68,0.07)",` +
    `color:"#ef4444",fontSize:11,lineHeight:1.4},children:__pwModeError})]})]})`;
}

function buildModeSend(slashCommands, loadSlashCommands, builtinCommand, audioUnlock) {
  return `__pwModeSend=async pwAction=>{__pwSetModeError(null);try{let pwCommands=Array.isArray(${slashCommands})?${slashCommands}:[],` +
    `pwReloadMarker=${JSON.stringify(FOLLOWUP_RELOAD_MARK)};` +
    `pwCommands.some(e=>"lop-followup"===e?.name&&"extension"===e?.source)||(pwCommands="function"==typeof ${loadSlashCommands}?await ${loadSlashCommands}():[]);` +
    `if(!pwCommands.some(e=>"lop-followup"===e?.name&&"extension"===e?.source)&&"function"==typeof ${builtinCommand}){` +
    `let pwReload=await ${builtinCommand}("/reload");if(pwReload?.error)throw Error(pwReload.error);` +
    `pwCommands="function"==typeof ${loadSlashCommands}?await ${loadSlashCommands}():[]}` +
    `if(!pwCommands.some(e=>"lop-followup"===e?.name&&"extension"===e?.source))throw Error("自动追问扩展未加载");` +
    `${audioUnlock}?.();if("function"!=typeof ${builtinCommand})throw Error("命令通道不可用");` +
    `let pwResult=await ${builtinCommand}(\`/lop-followup-ui \${pwAction}\`);` +
    `if(!pwResult?.handled)throw Error("自动追问命令未处理");if(pwResult.error)throw Error(pwResult.error);` +
    `__pwSetModeOpen(!1)}catch(pwError){console.error("[lop-followup-ui] command failed:",pwError),` +
    `__pwSetModeError(pwError instanceof Error?pwError.message:String(pwError))}}`;
}

const CHAT_INPUT_HEAD = /let ([\w$]+)=\(0,([\w$]+)\.forwardRef\)\(function\(\{onSend:([\w$]+),[\s\S]{0,250}?isStreaming:([\w$]+),[\s\S]{0,800}?slashCommands:([\w$]+),slashCommandsLoading:[\w$]+,onLoadSlashCommands:([\w$]+),onBuiltinCommand:([\w$]+),[\s\S]{0,180}?onAudioUnlock:([\w$]+),[\s\S]{0,120}?\},[\w$]+\)\{let /g;
const CHAT_INPUT_HOOK_BOUNDARY = /([\w$]+\.current=[\w$]+,[\w$]+\.current=[\w$]+),\(0,([\w$]+)\.useImperativeHandle\)/g;
const CHAT_MODEL_RENDER = /\(([\w$]+)\.length>0\|\|([\w$]+)\|\|([\w$]+)\)&&([\w$]+)&&\(0,([\w$]+)\.jsx\)\(([\w$]+),\{options:\1,value:\2,onChange:\4,disabled:([\w$]+),busy:([\w$]+),isAutoSelection:([\w$]+)\}\)/g;
const MODEL_TOOLBAR_STYLE = /:\{display:"flex",alignItems:"center",justifyContent:([\w$]+)\?"flex-start":void 0,gap:6,width:\1\?"100%":void 0,maxWidth:\1\?"100%":220,height:32,padding:\1\?"8px 10px":"8px 12px",overflow:"hidden",border:"none",borderRadius:9,background:([\w$]+)\?"var\(--bg-hover\)":"none",color:"var\(--text-muted\)",cursor:([\w$]+)\?"not-allowed":"pointer",fontSize:12,opacity:\3\?\.5:1,transition:"background 0\.12s, color 0\.12s"\}/g;
const MODEL_ROOT_STYLE = /style:\{position:"relative",width:"field"===([\w$]+)\|\|([\w$]+)\?"100%":void 0,minWidth:0,flex:"toolbar"===\1&&\2\?"1 1 auto":void 0\}/g;
const MODEL_BUTTON_ACCESSIBILITY = /"aria-label":([\w$]+),"aria-haspopup":"listbox","aria-expanded":([\w$]+),"aria-busy":([\w$]+)\|\|void 0,disabled:([\w$]+),title:\3\?"Switching model":\4\?([\w$]+):([\w$]+)\.length>0\|\|([\w$]+)\?"Change model":"No available models"/g;
const MODEL_NAME_SPAN = /\(0,([\w$]+)\.jsx\)\("span",\{style:\{flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"\},children:([\w$]+)\}\),"field"===([\w$]+)&&/g;
const BUILTIN_COMMAND_DEFAULT = /default:return\{handled:!1\}/g;
const EXTENSION_STATUS_SETTER = /void 0!==([\w$]+)\.state\.extensionStatuses&&([\w$]+)\(\1\.state\.extensionStatuses\?\?\[\]\)/g;
const MODE_SEND_BLOCK = /__pwModeSend=async pwAction=>\{[\s\S]{0,1600}?\}\},\(0,([\w$]+)\.useImperativeHandle\)/g;

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

export function applyFollowupModeUi(src, label = "bundle") {
  if (src.includes(FOLLOWUP_MARK)) {
    if (src.includes(FOLLOWUP_RELOAD_MARK)) return { out: src, applied: false, idents: null };
    const head = requireOne(src, CHAT_INPUT_HEAD, `${label}: ChatInput 参数`);
    const oldSend = requireOne(src, MODE_SEND_BLOCK, `${label}: 自动追问旧命令发现逻辑`);
    if (oldSend[1] !== head[2]) throw new Error(`${label}: 自动追问迁移 React 标识符不一致，拒绝写入`);
    const modeSend = buildModeSend(head[5], head[6], head[7], head[8]);
    const out = src.slice(0, oldSend.index) + modeSend + `,(0,${oldSend[1]}.useImperativeHandle)` + src.slice(oldSend.index + oldSend[0].length);
    if (!out.includes(FOLLOWUP_RELOAD_MARK)) throw new Error(`${label}: 自动追问迁移后标记校验失败，拒绝写入`);
    return { out, applied: true, idents: { migratedCommandDiscovery: true, react: head[2] } };
  }

  const head = requireOne(src, CHAT_INPUT_HEAD, `${label}: ChatInput 参数`);
  const hookBoundary = requireOne(src, CHAT_INPUT_HOOK_BOUNDARY, `${label}: ChatInput hooks`);
  const modelRender = requireOne(src, CHAT_MODEL_RENDER, `${label}: 模型选择器调用`);
  const toolbarStyle = requireOne(src, MODEL_TOOLBAR_STYLE, `${label}: 模型工具栏样式`);
  const rootStyle = requireOne(src, MODEL_ROOT_STYLE, `${label}: 模型选择器根样式`);
  const accessibility = requireOne(src, MODEL_BUTTON_ACCESSIBILITY, `${label}: 模型按钮无障碍属性`);
  const nameSpan = requireOne(src, MODEL_NAME_SPAN, `${label}: 模型名称`);
  const commandDefault = requireOne(src, BUILTIN_COMMAND_DEFAULT, `${label}: 内置命令 switch`);
  const statusSetter = requireOne(src, EXTENSION_STATUS_SETTER, `${label}: 扩展状态 setter`);

  const react = head[2];
  const streaming = head[4];
  const slashCommands = head[5];
  const loadSlashCommands = head[6];
  const builtinCommand = head[7];
  const audioUnlock = head[8];
  const jsx = modelRender[5];
  if (hookBoundary[2] !== react || modelRender[7] !== streaming) {
    throw new Error(`${label}: ChatInput 标识符交叉校验失败，拒绝写入`);
  }
  if (toolbarStyle[1] !== rootStyle[2]) {
    throw new Error(`${label}: ModelSelector 移动端标识符不一致，拒绝写入`);
  }
  if (accessibility[5] !== nameSpan[2] || rootStyle[1] !== nameSpan[3] || nameSpan[1] !== jsx) {
    throw new Error(`${label}: ModelSelector 名称/variant 标识符不一致，拒绝写入`);
  }

  const commandWindow = src.slice(Math.max(0, commandDefault.index - 4000), commandDefault.index);
  const commandContextMatches = [...commandWindow.matchAll(
    /let\[,([\w$]+),([\w$]+)=""\]=([\w$]+),([\w$]+)=\2\.trim\(\),([\w$]+)=[\w$]+\.current\?\?await ([\w$]+)\(\),([\w$]+)=[\w$]+=>[\s\S]{0,350}?;try\{switch\(\1\)\{/g,
  )];
  if (commandContextMatches.length !== 1) {
    throw new Error(`${label}: 内置命令上下文命中 ${commandContextMatches.length} 次(期望1)，拒绝写入`);
  }
  const commandContext = commandContextMatches[0];
  const commandName = commandContext[1];
  const commandArgs = commandContext[4];
  const commandSession = commandContext[5];
  const commandComplete = commandContext[7];
  const reloadMatches = [...commandWindow.matchAll(
    /case"reload":if\(!([\w$]+)\)return ([\w$]+)\(\{handled:!0,error:"No active session to reload"\}\);return await ([\w$]+)\(\1,\{type:"reload"\}\)/g,
  )];
  if (reloadMatches.length !== 1) {
    throw new Error(`${label}: sendAgentCommand 标识符命中 ${reloadMatches.length} 次(期望1)，拒绝写入`);
  }
  const sendAgentCommand = reloadMatches[0][3];
  if (reloadMatches[0][1] !== commandSession || reloadMatches[0][2] !== commandComplete) {
    throw new Error(`${label}: 内置命令 session/complete 标识符不一致，拒绝写入`);
  }
  const setExtensionStatuses = statusSetter[2];

  const modeSend = buildModeSend(slashCommands, loadSlashCommands, builtinCommand, audioUnlock);

  const toolbarReplacement =
    `:{display:"flex",alignItems:"center",justifyContent:"center",gap:0,width:32,maxWidth:32,height:32,padding:0,` +
    `overflow:"hidden",border:"none",borderRadius:8,background:${toolbarStyle[2]}?"var(--bg-hover)":"none",` +
    `color:"var(--text-muted)",cursor:${toolbarStyle[3]}?"not-allowed":"pointer",fontSize:12,opacity:${toolbarStyle[3]}?.5:1,` +
    `transition:"background 0.12s, color 0.12s"}`;
  const rootReplacement =
    `style:{position:"relative",width:"field"===${rootStyle[1]}?"100%":void 0,minWidth:0,flex:void 0}`;
  const accessibilityReplacement =
    `"aria-label":${accessibility[1]}??\`当前模型：\${${accessibility[5]}}\`,"aria-haspopup":"listbox",` +
    `"aria-expanded":${accessibility[2]},"aria-busy":${accessibility[3]}||void 0,disabled:${accessibility[4]},` +
    `title:${accessibility[3]}?"Switching model":${accessibility[4]}?${accessibility[5]}:` +
    `${accessibility[6]}.length>0||${accessibility[7]}?\`Change model: \${${accessibility[5]}}\`:"No available models"`;
  const nameSpanReplacement =
    `"field"===${nameSpan[3]}&&(0,${nameSpan[1]}.jsx)("span",{style:{flex:1,minWidth:0,overflow:"hidden",` +
    `textOverflow:"ellipsis",whiteSpace:"nowrap"},children:${nameSpan[2]}}),"field"===${nameSpan[3]}&&`;
  const modeCommandCase =
    `case"lop-followup-ui":{if(!${commandSession})return ${commandComplete}({handled:!0,error:"自动追问会话不可用"});` +
    `if(!["thorough","target","root-cause","root-fix","plan","off"].includes(${commandArgs}))return ${commandComplete}({handled:!0,error:"自动追问模式无效"});` +
    `await ${sendAgentCommand}(${commandSession},{type:"prompt",message:\`/lop-followup \${${commandArgs}}\`});` +
    `let __pwModeState=await ${sendAgentCommand}(${commandSession},{type:"get_state"});` +
    `void 0!==__pwModeState.extensionStatuses&&${setExtensionStatuses}(__pwModeState.extensionStatuses??[]);` +
    `return ${commandComplete}({handled:!0,message:"off"===${commandArgs}?"自动追问已停止":"自动追问模式已选择"})}`;

  const menu = buildFollowupMenu(jsx, streaming, "__pwModeSend");
  const edits = [
    {
      start: head.index + head[0].length,
      end: head.index + head[0].length,
      text: "__pwModeOpen,__pwSetModeOpen,__pwModeError,__pwSetModeError,__pwModeRef,__pwModeSend,",
      label: "mode-bindings",
    },
    {
      start: hookBoundary.index,
      end: hookBoundary.index + hookBoundary[0].length,
      text: `[__pwModeOpen,__pwSetModeOpen]=(0,${react}.useState)(!1),` +
        `[__pwModeError,__pwSetModeError]=(0,${react}.useState)(null),__pwModeRef=(0,${react}.useRef)(null),` +
        `${hookBoundary[1]},${modeSend},(0,${react}.useImperativeHandle)`,
      label: "mode-hooks",
    },
    { start: modelRender.index, end: modelRender.index, text: `${menu},`, label: "mode-menu" },
    { start: toolbarStyle.index, end: toolbarStyle.index + toolbarStyle[0].length, text: toolbarReplacement, label: "model-toolbar" },
    { start: rootStyle.index, end: rootStyle.index + rootStyle[0].length, text: rootReplacement, label: "model-root" },
    { start: accessibility.index, end: accessibility.index + accessibility[0].length, text: accessibilityReplacement, label: "model-accessibility" },
    { start: nameSpan.index, end: nameSpan.index + nameSpan[0].length, text: nameSpanReplacement, label: "model-name" },
    { start: commandDefault.index, end: commandDefault.index, text: modeCommandCase, label: "mode-command" },
  ].sort((a, b) => b.start - a.start);

  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) {
      throw new Error(`${label}: 自动追问补丁区间重叠 ${edits[index - 1].label}/${edits[index].label}，拒绝写入`);
    }
  }
  let out = src;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  if (!out.includes(FOLLOWUP_MARK) || !out.includes(FOLLOWUP_RELOAD_MARK) || !out.includes('case"lop-followup-ui"') || !out.includes('"data-lop-followup-action":"plan"')) {
    throw new Error(`${label}: 自动追问补丁后标记校验失败，拒绝写入`);
  }

  return {
    out,
    applied: true,
    idents: { react, jsx, streaming, slashCommands, loadSlashCommands, builtinCommand, commandName, commandSession, sendAgentCommand, setExtensionStatuses },
  };
}

export function applyComposerControls(src, label = "bundle") {
  const fullMark = "__pwFullToolDefaultV1";
  let defaultApplied = false;
  if (!src.includes(fullMark)) {
    const preference = requireOne(src, /function\(([\w$]+)=([\w$]+)\(\)\)\{if\(!\1\)return"default";try\{let ([\w$]+)=\1\.getItem\(([\w$]+)\);return\(0,([\w$]+)\.([\w$]+)\)\(\3\)\?\3:"default"\}catch\{return"default"\}\}\(\)/g, `${label}: saved tool default`);
    src = src.slice(0, preference.index) + `function(){/*${fullMark}*/return"full"}()` + src.slice(preference.index + preference[0].length);
    defaultApplied = true;
  }
  if (src.includes(COMPOSER_MARK)) return { out: src, applied: defaultApplied };
  const model = requireOne(src, CHAT_MODEL_RENDER, `${label}: composer model`);
  const right = requireOne(src, /marginLeft:([\w$]+)\?0:"auto"\},children:\[/g, `${label}: composer right controls`);
  const tools = requireOne(src, /!([\w$]+)&&([\w$]+)&&\(0,([\w$]+)\.jsxs\)\("div",\{ref:([\w$]+),style:\{position:"relative"\},children:\[\(0,\3\.jsxs\)\("button",\{onClick:\(\)=>!\1&&([\w$]+)\(e=>!e\),disabled:\1,title:([\w$]+)\("chat.changeToolPreset"\)/g, `${label}: composer tools`);
  const sound = requireOne(src, /void 0!==([\w$]+)&&\(0,([\w$]+)\.jsx\)\("button",\{onClick:\1,title:([\w$]+)\?([\w$]+)\("chat.disableSound"\)/g, `${label}: composer sound`);
  const audio = requireOne(src, /let ([\w$]+)=localStorage\.getItem\("pi-sound-enabled"\);return null===\1\|\|"true"===\1/g, `${label}: audio default`);
  const preset = requireOne(src, /\[([\w$]+),([\w$]+)\]=\(0,([\w$]+)\.useState\)\("default"\)/g, `${label}: tool default`);
  const edits = [
    { start: model.index, end: model.index + model[0].length, text: 'null' },
    { start: right.index, end: right.index + right[0].length, text: `${right[0]}${model[0]},` },
    { start: tools.index, end: tools.index + tools[0].length, text: tools[0].replace(/^![\w$]+&&[\w$]+&&/, '!1&&') },
    { start: sound.index, end: sound.index + sound[0].length, text: sound[0].replace(/^void 0!==[\w$]+&&/, '!1&&') },
    { start: audio.index, end: audio.index + audio[0].length, text: `/*${COMPOSER_MARK}*/return!1` },
    { start: preset.index, end: preset.index + preset[0].length, text: preset[0].replace('("default")', '("full")') },
  ].sort((a, b) => b.start - a.start);
  let out = src;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { out, applied: true };
}

export function applyPiWebInteractions(src, label = "bundle") {
  if (src.includes(MARK)) {
    const followup = applyFollowupModeUi(src, label);
    const composer = applyComposerControls(followup.out, label);
    return { out: composer.out, applied: followup.applied || composer.applied, idents: followup.idents ? { followup: followup.idents } : null };
  }

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
  const followup = applyFollowupModeUi(out, label);
  out = applyComposerControls(followup.out, label).out;
  if (!out.includes(MARK) || !out.includes(FOLLOWUP_MARK) || !out.includes(FOLLOWUP_RELOAD_MARK) || !out.includes('"data-pw-scroll-bottom":"true"')) {
    throw new Error(`${label}: 补丁后标记校验失败，拒绝写入`);
  }

  return {
    out,
    applied: true,
    idents: {
      react, addImages, cwd, textareaRef, setValue, valueRef, setAtQuery, scrollRef, messages, streamState,
      followup: followup.idents,
    },
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
    .update(buildFollowupMenu.toString())
    .update(buildModeSend.toString())
    .update(applyFollowupModeUi.toString())
    .update(applyPiWebInteractions.toString())
    .update(applyComposerControls.toString())
    .digest("hex");
  const nextHash = ("pwi" + fingerprint).slice(0, currentHash.length);
  const chunkDirectory = path.join(PKG, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDirectory, `page-${currentHash}.js`);
  if (!fs.existsSync(currentChunk)) die("当前 page chunk 不存在: " + currentChunk);
  const source = fs.readFileSync(currentChunk, "utf8");

  if (source.includes(MARK) && source.includes(FOLLOWUP_MARK) && source.includes(FOLLOWUP_RELOAD_MARK) && source.includes(COMPOSER_MARK) && source.includes("__pwFullToolDefaultV1")) {
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
        if (entry.isDirectory()) {
          if (entry.name !== "_历史版本") walk(candidate);
        } else if (!entry.name.includes(".bak-")) candidates.push(candidate);
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
    followupModeAdded: !source.includes(FOLLOWUP_MARK),
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
