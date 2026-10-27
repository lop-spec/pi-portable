// Browser-host binding of PI-Desktop HostToolRow's ordinary tool branch.
// The head/body JSX and disclosure rules follow ToolRow.tsx @ c099b6a.
import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import type { AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";
import type { UiMessage } from "./model";
import { adaptTool } from "./model";
import { getToolAction, getToolDisplayName, getToolSummary, getToolSummaryValue } from "./tool-display";
import { buildToolPresentation, hasToolDetails, runOutcome, toolResultChips } from "./tool-presentation";
import { ToolChips, ToolDetailBlocks } from "./ToolDetails";
import { useTranslation, HostContext, useOpenPreviewTarget, MessageContext } from "./host";
import { IconChevronRight, IconCircleAlert } from "./icons";
import { disclosureKey, useAutomaticDisclosure } from "./disclosure";
import { DisclosureCollapseRail, ToolActionIcon, ToolCommandCopy, TOOL_ACTION_KEYS, TOOL_RUNNING_KEYS, useMessageRevealRequest } from "./shared";

type View={entryUrl?:string;truncated?:boolean};
export const ToolRow=memo(function ToolRow({message:preview,onUserInteraction}:{message:UiMessage;onUserInteraction?:()=>void}){
  const {t}=useTranslation();const host=useContext(HostContext),detailsId=useId();
  const revealRequest=useMessageRevealRequest(preview.id);
  const disclosure=useAutomaticDisclosure(false,revealRequest,disclosureKey("tool",preview.id));
  const {open}=disclosure;
  const [full,setFull]=useState<{key:string;message:UiMessage}|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0);
  const source=preview.sourceBlock as ToolCallContent;
  const callUrl=(source as ToolCallContent&{chatView?:View})?.chatView?.entryUrl;
  const resultUrl=(preview.sourceResult as (ToolResultMessage&{chatView?:View})|undefined)?.chatView?.entryUrl;
  const sourceKey=[callUrl,resultUrl].join("|");
  const loaded=full?.key===sourceKey?full.message:null;
  const message=loaded??preview;
  useEffect(()=>{
    if(!open||loaded||(!callUrl&&!resultUrl))return;
    const controller=new AbortController();setError("");
    const load=async(url:string|undefined)=>{if(!url)return null;const r=await fetch(url,{signal:controller.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);return (await r.json()).message;};
    void Promise.all([load(callUrl),load(resultUrl)]).then(([call,paired])=>{
      if(controller.signal.aborted)return;
      const actual=call?.role==="assistant"?(call as AssistantMessage).content.find(b=>b.type==="toolCall"&&b.toolCallId===source.toolCallId):source;
      if(!actual||actual.type!=="toolCall"||(resultUrl&&paired?.role!=="toolResult"))throw new Error("工具原文不完整");
      setFull({key:sourceKey,message:adaptTool(actual,paired??preview.sourceResult,Date.parse(preview.createdAt)||undefined,preview.toolStatus==="running")});
    }).catch(e=>{if(!controller.signal.aborted)setError(String(e));});
    return()=>controller.abort();
  },[open,loaded,callUrl,resultUrl,sourceKey,source,preview,retry]);
  const toggle=useCallback(()=>{onUserInteraction?.();disclosure.toggle();},[onUserInteraction,disclosure.toggle]);
  const collapse=useCallback(()=>{onUserInteraction?.();disclosure.collapse();},[onUserInteraction,disclosure.collapse]);
  const status=message.toolStatus,action=getToolAction(message.toolName),run=action==="run"?runOutcome(message):null;
  const failed=status==="error"||run==="failed";
  const runHead=action==="run",summary=getToolSummary(message.toolName,message.toolArgs),rawName=getToolDisplayName(message.toolName);
  const args=message.toolArgs as Record<string,unknown>|undefined;
  const path=String(args?.path??args?.file_path??"");const url=String(args?.url??"");
  const previewTarget=(["read","write","edit"].includes(action)&&path)?{kind:"file",path}:action==="fetch"&&/^https?:/.test(url)?{kind:"url",url}:null;
  const openTarget=useOpenPreviewTarget();
  const command=runHead?getToolSummaryValue(message.toolName,message.toolArgs):"";
  const hasDetails=hasToolDetails(message)||Boolean(callUrl||resultUrl);
  const blocks=useMemo(()=>open&&hasDetails?buildToolPresentation(message,{hideSummaryArg:true}):null,[open,hasDetails,message]);
  const chips=toolResultChips(message);
  const statusLabel=run==="running"?t("chat.running"):run==="failed"?t("chat.toolFailed"):run==="denied"?t("chat.toolDenied"):run==="ok"?t("chat.toolCompleted"):run?"":status==="running"?t("chat.running"):status==="error"?t("chat.toolFailed"):status==="denied"?t("chat.toolDenied"):status==="success"?t("chat.toolCompleted"):"";
  const tone=status==="running"?"is-running":failed?"is-error":status==="denied"?"is-denied":"is-done";
  useLayoutEffect(()=>{if(status!=="running"||!open)return;for(const el of disclosure.bodyRef.current?.querySelectorAll<HTMLElement>(".tool-row-content")??[]){if(el.scrollHeight-el.scrollTop-el.clientHeight<40)el.scrollTop=el.scrollHeight;}},[status,open,message,disclosure.bodyRef]);
  return <MessageContext.Provider value={message}><div className={`tool-row ${open?"open":""} status-${status??"unknown"}`} role="region" data-message-id={message.id} aria-label={`${t("chat.toolCall")}: ${rawName}${statusLabel?`, ${statusLabel}`:""}`}>
    <div className={`tool-row-head${runHead?" is-run":""}`}>
      <button ref={disclosure.titleRef} type="button" className="tool-row-header" aria-expanded={open} aria-controls={hasDetails?detailsId:undefined} disabled={!hasDetails} title={summary||rawName} onClick={()=>hasDetails&&toggle()}>
        <span className="tool-row-icon"><ToolActionIcon action={action}/></span>
        <span className={`tool-row-name ${status==="running"?"running":""}`}>{t((status==="running"?TOOL_RUNNING_KEYS:TOOL_ACTION_KEYS)[action])}</span>
        {status==="running"?<span className="activity-marker" aria-hidden/>:null}
        {summary?<span className={`tool-row-summary${previewTarget?" linked":""}`} title={previewTarget?t(previewTarget.kind==="file"?"chat.previewFile":"chat.previewUrl"):undefined} onClick={previewTarget?(event)=>{event.stopPropagation();openTarget(previewTarget);}:undefined}>{summary}</span>:null}
        <ToolChips chips={chips}/>
        {runHead&&statusLabel?<span className={`tool-row-state ${tone}`} role="status" aria-live="polite"><span className="tool-row-state-dot" aria-hidden/>{statusLabel}</span>:status==="running"?<span className="tool-spinner" aria-label={t("chat.running")}/>:status==="error"?<span className="tool-row-status error" aria-label={t("chat.toolFailed")}><IconCircleAlert size={13}/>{t("chat.toolFailed")}</span>:status==="denied"?<span className="tool-row-status">{t("chat.toolDenied")}</span>:null}
        {runHead&&statusLabel?null:<span className="sr-only" role="status" aria-live="polite">{statusLabel}</span>}
        {!runHead&&hasDetails?<span className="tool-row-caret" aria-hidden><IconChevronRight size={12}/></span>:null}
      </button>
      {runHead&&command?<ToolCommandCopy command={command}/>:null}
      {runHead&&hasDetails?<button type="button" className="tool-row-caret is-toggle" aria-hidden="true" tabIndex={-1} onClick={toggle}><IconChevronRight size={12}/></button>:null}
    </div>
    {open?<div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
      <DisclosureCollapseRail label={t("chat.collapseToolOutput")} onCollapse={collapse}/>
      {(callUrl||resultUrl)&&!loaded?<div role={error?"alert":"status"}>{error?<button type="button" onClick={()=>setRetry(v=>v+1)}>加载失败，重试</button>:"正在加载工具原文…"}</div>:null}
      {blocks&&blocks.length>0?<ToolDetailBlocks blocks={blocks} plain={runHead} streaming={status==="running"}/>:null}
    </div>:null}
  </div></MessageContext.Provider>;
});
