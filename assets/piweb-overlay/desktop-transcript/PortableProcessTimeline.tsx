"use client";

import { Fragment, memo, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import type { AssistantContentBlock, AssistantMessage, ToolResultMessage } from "@/lib/types";
import { PortableTextBlock } from "./MessageView";
import { InlineFailure } from "./conversation/ErrorNotice";
import { TurnProcess } from "./desktop-transcript/TurnProcess";
import { ProcessActivityGroup } from "./desktop-transcript/ProcessActivityGroup";
import { ThinkingRow } from "./desktop-transcript/shared";
import { ToolRow } from "./desktop-transcript/ToolRow";
import { DisclosureAnchorContext } from "./desktop-transcript/disclosure-anchor-context";
import { TranscriptDisclosureProvider, disclosureKey, useAutomaticDisclosure } from "./desktop-transcript/disclosure";
import { HostContext, MessageContext, TranscriptSearchContext, Markdown } from "./desktop-transcript/host";
import { segmentTurnProcess, projectTurnProcess } from "./desktop-transcript/turn-process";
import { activityGroupStartsOpen } from "./desktop-transcript/activity-group-folding";
import { adaptTool, type AssistantActivityItem, type AssistantTurnPart, type UiMessage } from "./desktop-transcript/model";
import { ImagePreview } from "./ImagePreview";
import { MessageBubble } from "./desktop-transcript/MessageBubble";

export type PortableTimelineEntry=
 |{kind:"node";key:string;node:ReactNode}
 |{kind:"assistant";key:string;entryId?:string;message:AssistantMessage;streaming?:boolean}
 |{kind:"compaction";key:string;entryId?:string;timestamp?:number}
 |{kind:"failure";key:string;entryId?:string;message:AssistantMessage};
export type TimelineEnd={status:"done"|"error"|"stopped";at?:number};
type Props={entries:PortableTimelineEntry[];toolResults:Map<string,ToolResultMessage>;cwd?:string;sessionId?:string;searchEntryId?:string;searchBlock?:AssistantContentBlock;live?:boolean;modelNames?:Record<string,string>;collapseKey?:string;startedAt?:number;end?:TimelineEnd|null;phase?:string|null;streamingMessage?:AssistantMessage|null;onOpenFile?:(path:string,page?:number)=>void;onOpenSession?:(session:string)=>void};
export function buildDesktopParts(entries:PortableTimelineEntry[],toolResults:Map<string,ToolResultMessage>,live=false){
  const parts:AssistantTurnPart[]=[];const nodes=new Map<string,ReactNode>();
  const activity=(item:AssistantActivityItem)=>{const previous=parts.at(-1);if(previous?.kind==="activity")previous.items.push(item);else parts.push({kind:"activity",items:[item]});};
  for(const entry of entries){
    if(entry.kind!=="assistant"){
      const message:UiMessage={id:entry.key,role:"system",content:"",createdAt:entry.kind==="compaction"&&entry.timestamp?new Date(entry.timestamp).toISOString():"",entryId:"entryId" in entry?entry.entryId:undefined};
      nodes.set(entry.key,entry.kind==="node"?entry.node:entry.kind==="compaction"?<div className="transcript-compaction-row">上下文已压缩</div>:<InlineFailure failures={[{entryId:entry.entryId,raw:entry.message.errorMessage??"",truncated:entry.message.stopReason==="length",timestamp:entry.message.timestamp}]} continued={live}/>);
      parts.push({kind:"message",message});continue;
    }
    for(let index=0;index<entry.message.content.length;index++){
      const block=entry.message.content[index],streaming=Boolean(live&&entry.streaming&&index===entry.message.content.length-1);
      const id=`${entry.entryId??entry.key}:${index}`;
      const base:UiMessage={id,role:"assistant",content:"",createdAt:entry.message.timestamp?new Date(entry.message.timestamp).toISOString():"",status:entry.message.stopReason==="aborted"?"aborted":streaming?"streaming":"completed",entryId:entry.entryId,sourceBlock:block,blockIndex:index};
      if(block.type==="toolCall"){
        const message={...adaptTool(block,toolResults.get(block.toolCallId),entry.message.timestamp,live),entryId:entry.entryId,blockIndex:index};
        activity({kind:"tool",message});
      }else if(block.type==="thinking"&&(block.thinking.trim()||streaming)){
        activity({kind:"thinking",message:{...base,thinking:block.thinking}});
      }else if(block.type==="text"&&block.text.trim()){
        parts.push({kind:"message",message:{...base,content:block.text}});
      }
    }
  }
  return {parts,nodes};
}
function Activity({items,live,active,searchId}:{items:AssistantActivityItem[];live:boolean;active:boolean;searchId?:string}){
  const search=useContext(TranscriptSearchContext);
  const reveal=items.some(item=>item.message.id===searchId)?search?.requestId:undefined;
  const disclosure=useAutomaticDisclosure(activityGroupStartsOpen(items,{subagentTopology:false,turnActive:live,groupActive:active}),reveal,disclosureKey("activity",items[0]?.message.id??""));
  return <ProcessActivityGroup items={items} active={active} disclosure={disclosure}>
    {items.map(item=><div key={item.message.id} data-entry-id={item.message.entryId} data-search-target={item.message.id===searchId||undefined}>
      {item.kind==="tool"?<ToolRow message={item.message} onUserInteraction={disclosure.claim}/>:<MessageContext.Provider value={item.message}><ThinkingRow message={item.message} streaming={active&&item.message.status==="streaming"} autoOpen onUserInteraction={disclosure.claim}/></MessageContext.Provider>}
    </div>)}
  </ProcessActivityGroup>;
}
function Process(props:Props){
  const {entries,toolResults,live=false,searchEntryId,searchBlock,end,collapseKey,sessionId,cwd,onOpenFile}=props;
  const {parts,nodes}=useMemo(()=>buildDesktopParts(entries,toolResults,live),[entries,toolResults,live]);
  // Desktop's trailing live text stays outside the process until another tool
  // establishes that it was progress. Finished answers are already split by ChatWindow.
  const projection=useMemo(()=>live?projectTurnProcess({kind:"assistant-turn",id:collapseKey??"turn",parts}):{process:parts,responses:[]},[parts,live,collapseKey]);
  const segments=useMemo(()=>segmentTurnProcess(projection.process,"fully-folded"),[projection]);
  const messages=parts.flatMap(part=>part.kind==="message"?[part.message]:part.items.map(item=>item.message));
  const target=messages.find(message=>message.entryId===searchEntryId&&(!searchBlock||message.sourceBlock===searchBlock));
  const request=useRef({id:"",value:0});if(request.current.id!==(target?.id??""))request.current={id:target?.id??"",value:request.current.value+1};
  const search=useMemo(()=>target?{messageId:target.id,requestId:request.current.value}:null,[target?.id]);
  const host=useMemo(()=>({cwd,sessionId,onOpenFile}),[cwd,sessionId,onOpenFile]);
  // Recorded end timing belongs to the whole turn, including its separate answer.
  const turnParts:AssistantTurnPart[]=end?.at?[...parts,{kind:"message",message:{id:"turn-end",role:"assistant",content:"",createdAt:new Date(end.at).toISOString(),status:end.status==="stopped"?"aborted":"completed"}}]:parts;
  const visibleSteps=projection.process.reduce((n,part)=>n+(part.kind==="activity"?part.items.length:1),0);
  const tail=parts.at(-1);const activeItem=live&&tail?.kind==="activity"?tail.items.at(-1)?.message.id:undefined;
  const anchor=useCallback((title:HTMLElement|null)=>{
    if(!title)return;const scroller=title.closest<HTMLElement>('[data-chat-scroll],.pw-chat-scroll,.chat-scroll-container');
    const before=title.getBoundingClientRect().top;if(scroller)requestAnimationFrame(()=>{scroller.scrollTop+=title.getBoundingClientRect().top-before;});
  },[]);
  const renderMessage=(message:UiMessage)=>nodes.get(message.id)??<MessageBubble message={message} target={message.id===target?.id}/>;
  const images=messages.flatMap(message=>(message.sourceResult?.content??[]).flatMap((block,index)=>{
    if(block.type!=="image")return [];
    const image=block as unknown as {source?:{type:string;url?:string;data?:string;media_type?:string};data?:string;mimeType?:string};
    const src=image.source?.url??(image.source?.data?`data:${image.source.media_type};base64,${image.source.data}`:image.data?`data:${image.mimeType};base64,${image.data}`:"");
    return src?[<ImagePreview key={`${message.id}:${index}`} src={src}><img src={src} alt="工具生成图片" style={{maxWidth:"100%",maxHeight:420}}/></ImagePreview>]:[];
  }));
  return <HostContext.Provider value={host}><TranscriptSearchContext.Provider value={search}><DisclosureAnchorContext.Provider value={anchor}>
    <div className="pd-transcript" data-pi-desktop-transcript="0.21.0"><div className="message-row assistant"><div className="message-col">
      <TurnProcess turnId={collapseKey??"turn"} processParts={projection.process} turnParts={turnParts} visibleSteps={visibleSteps} isActive={live} failed={end?.status==="error"}>
        {segments.map(segment=>segment.kind==="run"?<ToolRow key={segment.key} message={segment.item.message}/>:<Fragment key={segment.key}>{segment.parts.map((part,index)=>part.kind==="activity"?<Activity key={part.items[0]?.message.id??index} items={part.items} live={live} active={Boolean(activeItem&&part.items.at(-1)?.message.id===activeItem)} searchId={target?.id}/>:<Fragment key={part.message.id}>{renderMessage(part.message)}</Fragment>)}</Fragment>)}
      </TurnProcess>
      {live&&!visibleSteps&&!projection.responses.length?<div className="working-indicator" role="status"><span className="working-indicator-mark"><span/><span/><span/></span><span>运行中</span></div>:null}
      {projection.responses.map(part=><Fragment key={part.message.id}>{renderMessage(part.message)}</Fragment>)}
      {images.length?<div className="prose-chat">{images}</div>:null}
    </div></div></div>
  </DisclosureAnchorContext.Provider></TranscriptSearchContext.Provider></HostContext.Provider>;
}
export const PortableProcessTimeline=memo(function PortableProcessTimeline(props:Props){
  return <TranscriptDisclosureProvider key={props.sessionId} sessionId={props.sessionId}><Process {...props}/></TranscriptDisclosureProvider>;
});
