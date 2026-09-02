#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：所有桌面会话显示完整的对话节点侧栏。
//
// 节点语义：真实用户问题各一个 Q 节点；仅 stopReason=stop 的助手终答各一个 A
// 节点。toolUse/error/aborted 等模型小轮次不进入节点。run-supervisor 的普通恢复
// 指令不是用户问题；首条消息未落盘时，transient recovery 中保存的“原始请求”会被还原
// 为 Q 节点。预览统一清洗为一行。
//
// 为避免把超长会话的全部工具结果装进聊天 DOM，本补丁复用 context API 的 nodes=1
// 轻量模式一次返回完整分支中的 user/stop 消息；点击尚未加载的旧节点时，聊天历史按
// 1000 条一页按需加载，直到目标消息可定位。失败路径始终 console.error 留痕。
//
// 用法: node patch-piweb-conversation-nodes.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；任一锚点数量不符即零写入中止；client/server/route 三面一起改。
// 顺序: Pi Web 补丁链最末端。chunk 名含上游 hash 与本补丁实现指纹，避免 PWA 旧缓存。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwConversationNodesV1";
export const PATCH_REVISION = "r2";

const IDENT = "[A-Za-z_$][\\w$]*";
const CONTEXT_PARAMS = 'new URLSearchParams({deferThinking:"1",deferMedia:"1"})';

function only(matches, label) {
  if (matches.length !== 1) {
    throw new Error(`${label}锚点命中 ${matches.length} 次(期望1)，拒绝写入`);
  }
  return matches[0];
}

function countOf(source, needle) {
  return source.split(needle).length - 1;
}

export function conversationMessageText(message, assistantOnly = false) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  const text = message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text || assistantOnly) return text;
  return message.content.some((block) => block && (block.type === "image" || block.type === "image_url"))
    ? "图片"
    : "";
}

export function toConversationNodeLine(value, maxLength = 140) {
  const clean = String(value ?? "")
    .replace(/```(?:[^\n]*\n)?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/(^|\s)(?:#{1,6}|[-+>*])\s+/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!Number.isFinite(maxLength) || maxLength < 2 || clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

export function conversationUserQuestion(message) {
  const raw = conversationMessageText(message);
  if (!raw) return "";
  if (/^\[lop-run-supervisor recovery\]/i.test(raw)) {
    const original = raw.match(/(?:^|\r?\n)原始请求[：:]\s*(?:\r?\n)?([\s\S]*)$/);
    if (!original) return "";
    return original[1]
      .replace(/\r?\n<(?:rules-resolved|deterministic-current-evidence|deterministic-final-draft)\b[\s\S]*$/i, "")
      .trim();
  }
  if (/^<(?:rules-resolved|system-reminder|deterministic-current-evidence|deterministic-final-draft)\b/i.test(raw)) {
    return "";
  }
  return raw;
}

export function collectConversationNodeRecords(messages, entryIds = []) {
  const records = [];
  for (let sourceIndex = 0; sourceIndex < (Array.isArray(messages) ? messages.length : 0); sourceIndex += 1) {
    const message = messages[sourceIndex];
    let role = "";
    let raw = "";
    if (message?.role === "user") {
      role = "user";
      raw = conversationUserQuestion(message);
    } else if (message?.role === "assistant" && message.stopReason === "stop") {
      role = "assistant";
      raw = conversationMessageText(message, true);
    }
    if (!role || !raw) continue;
    const fullText = toConversationNodeLine(raw, 4000);
    if (!fullText) continue;
    records.push({
      role,
      text: toConversationNodeLine(fullText),
      fullText,
      message,
      entryId: entryIds?.[sourceIndex] ?? null,
      sourceIndex,
    });
  }
  return records;
}

export function mergeConversationNodeRecords(
  historyMessages,
  historyEntryIds,
  loadedMessages,
  loadedEntryIds,
) {
  const byKey = new Map();
  let anonymous = 0;
  const add = (record, loadedSourceIndex) => {
    const key = record.entryId ? `id:${record.entryId}` : `anonymous:${anonymous++}`;
    const next = loadedSourceIndex === undefined ? record : { ...record, loadedSourceIndex };
    byKey.set(key, next);
  };
  for (const record of collectConversationNodeRecords(historyMessages, historyEntryIds)) add(record);
  for (const record of collectConversationNodeRecords(loadedMessages, loadedEntryIds)) {
    if (record.entryId && byKey.has(`id:${record.entryId}`)) {
      byKey.set(`id:${record.entryId}`, { ...record, loadedSourceIndex: record.sourceIndex });
    } else {
      add(record, record.sourceIndex);
    }
  }
  return [...byKey.values()];
}

function helperSource({ browserMark }) {
  const functions = [
    conversationMessageText,
    toConversationNodeLine,
    conversationUserQuestion,
    collectConversationNodeRecords,
    mergeConversationNodeRecords,
  ].map((fn) => fn.toString()).join("\n");
  const marker = browserMark
    ? `typeof window<"u"&&(window.${MARK}=!0,window.__pwCollectConversationNodeRecords=collectConversationNodeRecords);`
    : `/*${MARK}*/`;
  return `${functions}\n${marker}\n`;
}

function replaceSecond(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  const second = first < 0 ? -1 : source.indexOf(needle, first + needle.length);
  const third = second < 0 ? -1 : source.indexOf(needle, second + needle.length);
  if (first < 0 || second < 0 || third >= 0) {
    throw new Error(`${label}锚点命中 ${countOf(source, needle)} 次(期望2)，拒绝写入`);
  }
  return source.slice(0, second) + replacement + source.slice(second + needle.length);
}

export function applyConversationNodes(src, label = "page", { browserMark = false } = {}) {
  if (src.includes(MARK)) return { out: src, applied: false };

  const stateRe = new RegExp(
    `function (${IDENT})\\(\\{messages:(${IDENT}),streamingMessage:(${IDENT}),scrollContainer:(${IDENT}),messageRefs:(${IDENT}),onRevealHistory:(${IDENT})\\}\\)\\{let\\[(${IDENT}),(${IDENT})\\]=\\(0,(${IDENT})\\.useState\\)\\(!1\\),\\[(${IDENT}),(${IDENT})\\]=\\(0,\\9\\.useState\\)\\(\\[\\]\\)`,
    "g",
  );
  const state = only([...src.matchAll(stateRe)], `${label}: minimap state`);
  const [
    stateAnchor,
    component,
    messagesProp,
    ,
    ,
    ,
    revealHistoryProp,
    visible,
    ,
    react,
    nodes,
  ] = state;

  const measureRe = new RegExp(
    `let (${IDENT})=(${IDENT})\\.current,(${IDENT})=(${IDENT})\\.getBoundingClientRect\\(\\),(${IDENT})=\\[\\],(${IDENT})=0,(${IDENT})=null;for\\(let (${IDENT}) of (${IDENT})\\.current\\)\\{if\\("user"!==\\8\\.role&&"assistant"!==\\8\\.role\\)continue;[\\s\\S]*?\\}let (${IDENT})=\\5\\.map\\(`,
    "g",
  );
  const measure = only([...src.matchAll(measureRe)], `${label}: minimap measure`);
  const [
    measureAnchor,
    refs,
    messageRefsProp,
    containerRect,
    scrollElement,
    turns,
    refIndex,
    ,
    loopMessage,
    allMessagesRef,
    mappedNodes,
  ] = measure;

  const invocationRe = new RegExp(
    `\\(0,(${IDENT})\\.jsx\\)\\(${component},\\{messages:(${IDENT}),streamingMessage:([^,]+),scrollContainer:(${IDENT}),messageRefs:(${IDENT}),onRevealHistory:(${IDENT})\\}\\)`,
    "g",
  );
  const invocation = only([...src.matchAll(invocationRe)], `${label}: minimap invocation`);

  const sessionRe = new RegExp(
    `\\{loading:${IDENT},error:${IDENT},messages:(${IDENT}),entryIds:(${IDENT}),historyCursor:(${IDENT}),hasEarlierMessages:(${IDENT}),[\\s\\S]{0,3000}?sessionIdRef:(${IDENT}),messagesEndRef:${IDENT},scrollContainerRef:(${IDENT}),[\\s\\S]{0,3000}?loadContext:(${IDENT}),activeLeafId:(${IDENT})\\}=function\\(`,
    "g",
  );
  const session = only([...src.matchAll(sessionRe)], `${label}: chat history state`);
  const [
    ,
    chatMessages,
    chatEntryIds,
    historyCursor,
    hasEarlierMessages,
    sessionIdRef,
    chatScrollRef,
    loadContext,
    activeLeafId,
  ] = session;

  if (countOf(src, CONTEXT_PARAMS) !== 2) {
    throw new Error(`${label}: context 参数锚点命中 ${countOf(src, CONTEXT_PARAMS)} 次(期望2)，拒绝写入`);
  }

  const componentHeader = stateAnchor.slice(0, stateAnchor.indexOf("{let"));
  const nextHeader = componentHeader.replace(
    `onRevealHistory:${revealHistoryProp}})`,
    `onRevealHistory:${revealHistoryProp},entryIds:pwLoadedEntryIds=[],sessionId:pwSessionId,activeLeafId:pwActiveLeafId})`,
  );
  if (nextHeader === componentHeader) {
    throw new Error(`${label}: minimap props 锚点命中 0 次(期望1)，拒绝写入`);
  }

  let out = src.replace(stateAnchor, stateAnchor.replace(componentHeader, nextHeader));

  const allMessagesAssignment = `${allMessagesRef}.current=`;
  const assignmentRe = new RegExp(`${allMessagesRef}\\.current=(${IDENT});`, "g");
  const assignment = only([...out.matchAll(assignmentRe)], `${label}: minimap messages ref`);
  const allMessages = assignment[1];
  const nodeState = browserMark
    ? `let[pwNodeHistory,pwSetNodeHistory]=(0,${react}.useState)({messages:[],entryIds:[]});`
      + `(0,${react}.useEffect)(()=>{if(!pwSessionId){pwSetNodeHistory({messages:[],entryIds:[]});return}`
      + `let pwCancelled=!1,pwAbort=new AbortController;`
      + `(async()=>{let pwMessages=[],pwEntryIds=[],pwBefore=null,pwSeen=new Set;for(;;){`
      + `let pwParams=new URLSearchParams({nodes:"1",deferThinking:"1",deferMedia:"1",tail:"1000"});`
      + `pwActiveLeafId&&pwParams.set("leafId",pwActiveLeafId);pwBefore&&pwParams.set("before",pwBefore);`
      + `let pwResponse=await fetch(\`/api/sessions/\${encodeURIComponent(pwSessionId)}/context?\${pwParams}\`,{signal:pwAbort.signal});`
      + `if(!pwResponse.ok)throw Error(\`HTTP \${pwResponse.status}\`);let pwData=await pwResponse.json(),pwContext=pwData.context??{},pwPageMessages=pwContext.messages??[],pwPageEntryIds=pwContext.entryIds??[];`
      + `pwMessages=[...pwPageMessages,...pwMessages];pwEntryIds=[...pwPageEntryIds,...pwEntryIds];`
      + `if(!pwContext.hasMore)break;let pwOldest=pwContext.oldestEntryId;if(!pwOldest||pwSeen.has(pwOldest))throw Error("conversation node pagination stalled");pwSeen.add(pwOldest);pwBefore=pwOldest}`
      + `if(!pwCancelled)pwSetNodeHistory({messages:pwMessages,entryIds:pwEntryIds})})()`
      + `.catch(pwError=>{if(!pwCancelled&&"AbortError"!==pwError?.name)console.error("[pi-web] conversation node index load failed:",pwError)});`
      + `return()=>{pwCancelled=!0;pwAbort.abort()}},[pwSessionId,pwActiveLeafId]);`
    : "";
  const visibilityExpression = browserMark
    ? `mergeConversationNodeRecords(pwNodeHistory.messages,pwNodeHistory.entryIds,${allMessagesRef}.current,pwLoadedEntryIds).length>0`
    : `collectConversationNodeRecords(${allMessagesRef}.current,pwLoadedEntryIds).length>0`;
  out = out.replace(
    assignment[0],
    `${allMessagesRef}.current=${allMessages};${nodeState}${visible}=${visibilityExpression};`,
  );

  const measureReplacement = browserMark
    ? `let ${refs}=${messageRefsProp}.current,${containerRect}=${scrollElement}.getBoundingClientRect(),${turns}=[],${refIndex}=0,pwElementByEntryId=new Map,pwElementBySourceIndex=new Map,pwLoadedSourceIndex=-1;`
      + `for(let ${loopMessage} of ${allMessagesRef}.current){pwLoadedSourceIndex+=1;if("user"!==${loopMessage}.role&&"assistant"!==${loopMessage}.role)continue;let pwElement=${refs}?.[${refIndex}];${refIndex}+=1;let pwEntryId=pwLoadedEntryIds?.[pwLoadedSourceIndex];pwEntryId&&pwElementByEntryId.set(pwEntryId,pwElement);pwElementBySourceIndex.set(pwLoadedSourceIndex,pwElement)}`
      + `let pwRecords=mergeConversationNodeRecords(pwNodeHistory.messages,pwNodeHistory.entryIds,${allMessagesRef}.current,pwLoadedEntryIds);`
      + `for(let pwRecord of pwRecords){let pwElement=pwRecord.entryId?pwElementByEntryId.get(pwRecord.entryId):pwElementBySourceIndex.get(pwRecord.loadedSourceIndex),pwRect=pwElement?.getBoundingClientRect();${turns}.push({userMessage:pwRecord.message,assistantPreviews:[],scrollTop:pwRect?pwRect.top-${containerRect}.top+${scrollElement}.scrollTop:null,nodeRole:pwRecord.role,previewText:pwRecord.text,fullText:pwRecord.fullText,entryId:pwRecord.entryId})}`
      + `let ${mappedNodes}=${turns}.map(`
    : `let ${refs}=${messageRefsProp}.current,${containerRect}=${scrollElement}.getBoundingClientRect(),${turns}=[],${refIndex}=0,pwLoadedSourceIndex=-1,pwElementByEntryId=new Map,pwElementBySourceIndex=new Map;`
      + `for(let ${loopMessage} of ${allMessagesRef}.current){pwLoadedSourceIndex+=1;if("user"!==${loopMessage}.role&&"assistant"!==${loopMessage}.role)continue;let pwElement=${refs}?.[${refIndex}];${refIndex}+=1;let pwEntryId=pwLoadedEntryIds?.[pwLoadedSourceIndex];pwEntryId&&pwElementByEntryId.set(pwEntryId,pwElement);pwElementBySourceIndex.set(pwLoadedSourceIndex,pwElement)}`
      + `let pwRecords=collectConversationNodeRecords(${allMessagesRef}.current,pwLoadedEntryIds);`
      + `for(let pwRecord of pwRecords){let pwElement=pwRecord.entryId?pwElementByEntryId.get(pwRecord.entryId):pwElementBySourceIndex.get(pwRecord.sourceIndex),pwRect=pwElement?.getBoundingClientRect();${turns}.push({userMessage:pwRecord.message,assistantPreviews:[],scrollTop:pwRect?pwRect.top-${containerRect}.top+${scrollElement}.scrollTop:null,nodeRole:pwRecord.role,previewText:pwRecord.text,fullText:pwRecord.fullText,entryId:pwRecord.entryId})}`
      + `let ${mappedNodes}=${turns}.map(`;
  out = out.replace(measureAnchor, measureReplacement);

  const recordsNeedle = browserMark
    ? "let pwRecords=mergeConversationNodeRecords"
    : "let pwRecords=collectConversationNodeRecords";
  const recordsIndex = out.indexOf(recordsNeedle);
  const firstEffectIndex = recordsIndex < 0 || !browserMark
    ? -1
    : out.indexOf(`;(0,${react}.useEffect)`, recordsIndex);
  if (recordsIndex < 0 || (browserMark && firstEffectIndex < 0)) {
    throw new Error(`${label}: minimap callback 边界锚点命中 0 次(期望1)，拒绝写入`);
  }
  const callbackSegment = out.slice(recordsIndex, browserMark ? firstEffectIndex : recordsIndex + 12000);
  const callbackDepsRe = new RegExp(`\\},\\[(${IDENT}(?:,${IDENT})*)\\]\\)`, "g");
  const callbackDepsMatches = [...callbackSegment.matchAll(callbackDepsRe)];
  if (callbackDepsMatches.length < 1) {
    throw new Error(`${label}: minimap callback deps锚点命中 0 次(期望至少1)，拒绝写入`);
  }
  const callbackDeps = callbackDepsMatches[0];
  const callbackDepsStart = recordsIndex + callbackDeps.index;
  const callbackDepsOut = `},[${callbackDeps[1]},pwLoadedEntryIds${browserMark ? ",pwNodeHistory" : ""}])`;
  out = out.slice(0, callbackDepsStart) + callbackDepsOut + out.slice(callbackDepsStart + callbackDeps[0].length);

  const pendingRe = new RegExp(`if\\(null===(${IDENT})\\)return;(${IDENT})\\.current=null`, "g");
  const pendingCandidates = [...out.matchAll(pendingRe)].filter((match) => {
    const start = Math.max(0, match.index - 1200);
    return out.slice(start, match.index).includes("targetTurn.assistantPreviews");
  });
  const pending = only(pendingCandidates, `${label}: unloaded node navigation`);
  out = out.replace(pending[0], `if(null===${pending[1]}){${revealHistoryProp}();return}${pending[2]}.current=null`);

  const railRe = new RegExp(`"data-minimap-node-index":(${IDENT})\\.index,`, "g");
  const rail = only([...out.matchAll(railRe)], `${label}: rail node`);
  out = out.replace(rail[0], `"data-minimap-node-index":${rail[1]}.index,"data-conversation-node-role":${rail[1]}.targetTurn.nodeRole,`);

  const turnRe = new RegExp(`className:(${IDENT})\\(\\)\\.turn,"data-minimap-preview-index":(${IDENT})\\.index,`, "g");
  const turn = only([...out.matchAll(turnRe)], `${label}: preview row`);
  out = out.replace(
    turn[0],
    `className:${turn[1]}().turn,"data-minimap-preview-index":${turn[2]}.index,"data-conversation-node-role":${turn[2]}.targetTurn.nodeRole,style:{minHeight:36,padding:"4px 8px",gridTemplateColumns:"24px minmax(0,1fr)",alignItems:"center"},`,
  );

  const numberRe = new RegExp(`children:String\\((${IDENT})\\.index\\+1\\)\\.padStart\\(2,"0"\\)`, "g");
  const number = only([...out.matchAll(numberRe)], `${label}: preview role badge`);
  out = out.replace(number[0], `children:"assistant"===${number[1]}.targetTurn.nodeRole?"A":"Q"`);

  const buttonRe = new RegExp(`"data-minimap-preview-user":(${IDENT})\\.index,onClick:`, "g");
  const button = only([...out.matchAll(buttonRe)], `${label}: preview button`);
  out = out.replace(
    button[0],
    `"data-minimap-preview-user":${button[1]}.index,"data-conversation-node-role":${button[1]}.targetTurn.nodeRole,title:${button[1]}.targetTurn.fullText,"aria-label":${button[1]}.targetTurn.fullText,style:{height:30,minHeight:30,maxHeight:30,padding:"4px 8px",display:"flex",alignItems:"center",width:"100%"},onClick:`,
  );

  const previewRe = new RegExp(
    `children:\\(0,(${IDENT})\\.jsx\\)\\("span",\\{className:(${IDENT})\\(\\)\\.userText,children:[\\s\\S]*?\\}\\)\\}\\),(${IDENT})\\.targetTurn\\.assistantPreviews`,
    "g",
  );
  const preview = only([...out.matchAll(previewRe)], `${label}: one-line preview`);
  out = out.replace(
    preview[0],
    `children:(0,${preview[1]}.jsx)("span",{className:${preview[2]}().userText,style:{display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",width:"100%"},children:${preview[3]}.targetTurn.previewText})}),${preview[3]}.targetTurn.assistantPreviews`,
  );

  const invocationProps = `${invocation[0].slice(0, -2)},entryIds:${chatEntryIds},sessionId:${sessionIdRef}.current??void 0,activeLeafId:${activeLeafId}})`;
  out = out.replace(invocation[0], invocationProps);

  // Only loadContext (the second URLSearchParams site) needs a large page. Initial chat remains lazy.
  out = replaceSecond(out, CONTEXT_PARAMS, 'new URLSearchParams({deferThinking:"1",deferMedia:"1",tail:"1000"})', `${label}: context params`);

  if (browserMark) {
    const refsRe = new RegExp(
      `let\\[(${IDENT}),(${IDENT})\\]=\\(0,(${IDENT})\\.useState\\)\\(50\\),(${IDENT})=\\(0,\\3\\.useRef\\)\\(null\\),(${IDENT})=\\(0,\\3\\.useRef\\)\\(null\\),(${IDENT})=\\(0,\\3\\.useRef\\)\\(!1\\);`,
      "g",
    );
    const historyRefs = only([...out.matchAll(refsRe)], `${label}: lazy history refs`);
    const [, , setVisibleCount, historyReact, , previousScrollDistance, historyLoading] = historyRefs;

    const revealRe = new RegExp(
      `(${IDENT})=\\(0,${historyReact}\\.useCallback\\)\\(\\(\\)=>\\{${setVisibleCount}\\((${IDENT})=>Math\\.max\\(\\2,2\\*${chatMessages}\\.length\\)\\)\\},\\[${chatMessages}\\.length\\]\\)`,
      "g",
    );
    const reveal = only([...out.matchAll(revealRe)], `${label}: reveal history callback`);
    out = out.replace(
      reveal[0],
      `${reveal[1]}=(0,${historyReact}.useCallback)(()=>{${setVisibleCount}(${reveal[2]}=>Math.max(${reveal[2]},2*${chatMessages}.length));`
        + `if(${historyLoading}.current||!${hasEarlierMessages}||!${historyCursor})return;let pwSid=${sessionIdRef}.current;if(!pwSid)return;`
        + `let pwContainer=${chatScrollRef}.current;pwContainer&&(${previousScrollDistance}.current=pwContainer.scrollHeight-pwContainer.scrollTop);${historyLoading}.current=!0;`
        + `Promise.resolve(${loadContext}(pwSid,${activeLeafId},${historyCursor})).catch(pwError=>console.error("[pi-web] conversation node history load failed:",pwError)).finally(()=>{${historyLoading}.current=!1})},`
        + `[${chatMessages}.length,${hasEarlierMessages},${historyCursor},${activeLeafId},${loadContext},${sessionIdRef},${chatScrollRef}])`,
    );

    const measureDepsRe = new RegExp(`\\[${messagesProp}\\.length,(${IDENT}),(${IDENT})\\]`, "g");
    const measureDeps = only([...out.matchAll(measureDepsRe)], `${label}: minimap refresh deps`);
    out = out.replace(measureDeps[0], `[${messagesProp}.length,${measureDeps[1]},${measureDeps[2]},pwNodeHistory]`);
  }

  const componentFunction = `function ${component}(`;
  if (countOf(out, componentFunction) !== 1) {
    throw new Error(`${label}: minimap helper 注入点命中 ${countOf(out, componentFunction)} 次(期望1)，拒绝写入`);
  }
  out = out.replace(componentFunction, `${helperSource({ browserMark })}${componentFunction}`);

  return { out, applied: true };
}

export function applyConversationNodesRoute(src, label = "nodes-route") {
  if (src.includes(`${MARK}:nodes-route`)) return { out: src, applied: false };

  const queryRe = new RegExp(
    `(${IDENT})=(${IDENT})\\.searchParams\\.has\\("deferMedia"\\),(${IDENT})=Number\\(\\2\\.searchParams\\.get\\("tail"\\)\\),(${IDENT})=Number\\.isFinite\\(\\3\\)&&\\3>0\\?Math\\.min\\(\\3,1e3\\):50,(${IDENT})=\\2\\.searchParams\\.get\\("before"\\)\\?\\?void 0;`,
    "g",
  );
  const query = only([...src.matchAll(queryRe)], `${label}: query`);
  const [, deferMedia, url, rawTail, tail, before] = query;
  let out = src.replace(
    query[0],
    `${deferMedia}=${url}.searchParams.has("deferMedia"),pwNodesOnly=${url}.searchParams.has("nodes"),${rawTail}=Number(${url}.searchParams.get("tail")),${tail}=pwNodesOnly?Number.MAX_SAFE_INTEGER:Number.isFinite(${rawTail})&&${rawTail}>0?Math.min(${rawTail},1e3):50,${before}=${url}.searchParams.get("before")??void 0;`,
  );

  const responseRe = new RegExp(
    `return (${IDENT})\\.NextResponse\\.json\\(\\{context:(${IDENT}),tail:(${IDENT}),before:(${IDENT})\\?\\?null\\}\\)`,
    "g",
  );
  const responses = [...out.matchAll(responseRe)].filter((match) => match[3] === tail && match[4] === before);
  const response = only(responses, `${label}: response`);
  const context = response[2];
  const filter = `if(pwNodesOnly){let pwMessages=[],pwEntryIds=[];for(let pwIndex=0;pwIndex<${context}.messages.length;pwIndex+=1){let pwMessage=${context}.messages[pwIndex];if("user"===pwMessage.role||"assistant"===pwMessage.role&&"stop"===pwMessage.stopReason){pwMessages.push(pwMessage);pwEntryIds.push(${context}.entryIds?.[pwIndex]??null)}}${context}={...${context},messages:pwMessages,entryIds:pwEntryIds,hasMore:!1,oldestEntryId:pwEntryIds[0]??null}}`;
  out = out.replace(response[0], `${filter}${response[0]}`);
  out += `\n/*${MARK}:nodes-route*/`;
  return { out, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argValue = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const check = args.includes("--check");
  const pkg = argValue(
    "--pkg",
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"),
  );
  const portablePackage = path.resolve(pkg).toLowerCase().includes(`${path.sep}portable${path.sep}app${path.sep}`);
  const backup = argValue(
    "--backup",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "pi-web",
      `backup-0.8.11-pre-conversation-nodes-v1${portablePackage ? "" : "-global"}`,
    ),
  );
  const die = (message) => {
    console.error(`[ABORT] ${message}`);
    process.exit(1);
  };

  const pkgJsonPath = path.join(pkg, "package.json");
  if (!fs.existsSync(pkgJsonPath)) die(`包目录不存在: ${pkg}`);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.version !== "0.8.11") die(`package version ${pkgJson.version} != 0.8.11，拒绝执行`);

  if (args.includes("--revert")) {
    if (!fs.existsSync(backup)) die(`备份目录不存在: ${backup}`);
    const restored = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(source);
          continue;
        }
        const relative = path.relative(backup, source);
        const target = path.join(pkg, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        restored.push(relative);
      }
    })(backup);
    console.log(JSON.stringify({
      status: "reverted",
      pkg,
      restored,
      note: "新 chunk 文件保留为无引用孤儿；重启 pi-web 后生效",
    }, null, 1));
    process.exit(0);
  }

  const manifest = path.join(pkg, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("找不到 page_client-reference-manifest.js");
  const hashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/g)]
      .map((match) => match[1]),
  )];
  if (hashes.length !== 1) die(`page chunk 引用解析异常: ${JSON.stringify(hashes)}`);
  const currentHash = hashes[0];
  if (currentHash.length < 8) die(`page chunk hash 过短，无法安全改名: ${currentHash}`);

  const chunkDirectory = path.join(pkg, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDirectory, `page-${currentHash}.js`);
  const serverPage = path.join(pkg, ".next", "server", "app", "page.js");
  const nodesRoute = path.join(pkg, ".next", "server", "app", "api", "sessions", "[id]", "context", "route.js");
  for (const file of [currentChunk, serverPage, nodesRoute]) {
    if (!fs.existsSync(file)) die(`补丁目标不存在: ${file}`);
  }

  const clientSource = fs.readFileSync(currentChunk, "utf8");
  const serverSource = fs.readFileSync(serverPage, "utf8");
  const routeSource = fs.readFileSync(nodesRoute, "utf8");
  if (
    clientSource.includes(MARK)
    && serverSource.includes(MARK)
    && routeSource.includes(`${MARK}:nodes-route`)
  ) {
    console.log(JSON.stringify({ status: "already-patched", pkg, chunk: path.basename(currentChunk) }));
    process.exit(0);
  }

  let client;
  let server;
  let route;
  try {
    client = applyConversationNodes(clientSource, "client", { browserMark: true });
    server = applyConversationNodes(serverSource, "server-page", { browserMark: false });
    route = applyConversationNodesRoute(routeSource, "nodes-route");
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const clientChanged = client.applied;
  const serverChanged = server.applied;
  const routeChanged = route.applied;
  const fingerprint = crypto.createHash("sha1")
    .update(currentHash).update(":")
    .update(PATCH_REVISION).update(":")
    .update(applyConversationNodes.toString()).update(":")
    .update(applyConversationNodesRoute.toString()).update(":")
    .update(collectConversationNodeRecords.toString())
    .digest("hex");
  const nextHash = clientChanged ? (`pwn${fingerprint}`).slice(0, currentHash.length) : currentHash;
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
    })(path.join(pkg, ".next", "server", "app"));
    for (const name of ["build-manifest.json", "app-build-manifest.json", "react-loadable-manifest.json"]) {
      const candidate = path.join(pkg, ".next", name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
    for (const file of candidates) {
      const source = path.resolve(file) === path.resolve(serverPage) ? server.out : fs.readFileSync(file, "utf8");
      const count = countOf(source, currentHash);
      if (count > 0) referenceEdits.push({ file, count, out: source.replaceAll(currentHash, nextHash) });
    }
    if (referenceEdits.reduce((sum, edit) => sum + edit.count, 0) < 1) {
      die("page chunk 引用未找到，拒绝改名（会 404）");
    }
  }
  if (serverChanged && !referenceEdits.some((edit) => path.resolve(edit.file) === path.resolve(serverPage))) {
    referenceEdits.push({ file: serverPage, count: 0, out: server.out });
  }

  const summary = {
    status: check ? "check-ok" : "patched",
    pkg,
    version: pkgJson.version,
    chunk: {
      from: `page-${currentHash}.js`,
      to: `page-${nextHash}.js`,
      renamed: currentHash !== nextHash,
    },
    applied: {
      client: clientChanged,
      serverPage: serverChanged,
      nodesRoute: routeChanged,
    },
    behavior: {
      userQuestionNodes: true,
      assistantStopNodes: true,
      interimAssistantNodes: false,
      oneLinePreview: true,
      allBranchNodes: true,
      historyPageSize: 1000,
    },
    upstreamPatches: {
      fold: clientSource.includes('"process-group-lead-"'),
      draft: clientSource.includes("__pwDraftPersistV1"),
      interactions: clientSource.includes("__pwPasteAndScrollV2"),
      hideThinking: clientSource.includes("__pwHideThinkingV1"),
      hideRecovered: clientSource.includes("__pwHideRecoveredV1"),
      thinkingDefault: clientSource.includes("__pwThinkingDefaultDisplayV2"),
      hideHiddenExtensionMessages: clientSource.includes("__pwHideHiddenExtensionMessagesV1"),
    },
    refEdits: referenceEdits.map((edit) => ({ file: path.relative(pkg, edit.file), count: edit.count })),
    backup,
  };
  if (check) {
    console.log(JSON.stringify(summary, null, 1));
    process.exit(0);
  }

  for (const file of new Set([currentChunk, serverPage, nodesRoute, ...referenceEdits.map((edit) => edit.file)])) {
    const destination = path.join(backup, path.relative(pkg, file));
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }

  if (clientChanged) fs.writeFileSync(nextChunk, client.out);
  for (const edit of referenceEdits) fs.writeFileSync(edit.file, edit.out);
  if (routeChanged) fs.writeFileSync(nodesRoute, route.out);
  console.log(JSON.stringify(summary, null, 1));
}

const realPathOf = (candidate) => {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
};
if (
  process.argv[1]
  && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()
) main();
