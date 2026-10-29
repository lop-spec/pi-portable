"use client";
// Adapted from Craft Agents WorkLog.tsx / ActivityRow.tsx (Apache-2.0).
// Host bindings use Pi messages and Cetus file previews, not Electron IPC.
import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleX, ChevronRight, Terminal, FileText, Search, Globe, Wrench, MessageSquareText, LoaderCircle, Minus, X, Copy, MoreHorizontal } from 'lucide-react';
import type { AssistantContentBlock, AssistantMessage, ToolResultMessage, ToolCallContent } from '@/lib/types';
import { PortableTextBlock } from './MessageView';
import { InlineFailure } from './conversation/ErrorNotice';
import { ImagePreview } from './ImagePreview';
import { projectCraftTurn } from '@/lib/craft-transcript-model.mjs';
export type PortableTimelineEntry =
 | {kind:'node';key:string;node:ReactNode}
 | {kind:'assistant';key:string;entryId?:string;message:AssistantMessage;streaming?:boolean}
 | {kind:'compaction';key:string;entryId?:string;timestamp?:number}
 | {kind:'failure';key:string;entryId?:string;message:AssistantMessage};
export type TimelineEnd = {status:'done'|'error'|'stopped';at?:number};
type Props = {entries:PortableTimelineEntry[];toolResults:Map<string,ToolResultMessage>;cwd?:string;sessionId?:string;searchEntryId?:string;searchBlock?:AssistantContentBlock;live?:boolean;modelNames?:Record<string,string>;collapseKey?:string;startedAt?:number;end?:TimelineEnd|null;phase?:string|null;streamingMessage?:AssistantMessage|null;onOpenFile?:(path:string,page?:number)=>void;onOpenSession?:(session:string)=>void};
type Activity = {id:string;entryId?:string;block:AssistantContentBlock;timestamp?:number;type:string;result?:ToolResultMessage;status:string;name:string;intent:string;input:string};
function ToolIcon({activity}:{activity:Activity}) {
  const name = activity.block.type === 'toolCall' ? activity.block.toolName.toLowerCase() : '';
  const Icon = activity.type === 'intermediate' ? MessageSquareText : /bash|shell|exec/.test(name) ? Terminal : /read|write|edit/.test(name) ? FileText : /grep|find|search/.test(name) ? Search : /browser|web/.test(name) ? Globe : Wrench;
  return <Icon size={14} aria-hidden="true"/>;
}
function ResultGlyph({status}:{status:string}) {
  const label = ({completed:'已完成',error:'错误',running:'运行中',stopped:'已停止',unknown:'结果未记录'} as Record<string,string>)[status];
  const Icon = status === 'completed' ? Check : status === 'error' ? CircleX : status === 'running' ? LoaderCircle : Minus;
  return <span className={'craft-result '+status} role="img" aria-label={label} title={label}>{status==='error'&&<span>错误</span>}<Icon size={14} aria-hidden="true"/></span>;
}
function Images({result}:{result?:ToolResultMessage}) {
  return <>{result?.content.map((block,index)=>{
    if(block.type!=='image')return null;
    const image=block as unknown as {source?:{url?:string;data?:string;media_type?:string};data?:string;mimeType?:string};
    const src=image.source?.url??(image.source?.data?`data:${image.source.media_type};base64,${image.source.data}`:image.data?`data:${image.mimeType};base64,${image.data}`:'');
    return src?<ImagePreview key={index} src={src}><img className="craft-output-image" src={src} alt="工具生成图片"/></ImagePreview>:null;
  })}</>;
}
function Details({activity,onClose,cwd,onOpenFile,onOpenSession}:{activity:Activity;onClose:()=>void;cwd?:string;onOpenFile?:Props['onOpenFile'];onOpenSession?:Props['onOpenSession']}) {
  const dialog=useRef<HTMLDialogElement>(null),title=useId();const [copyState,setCopyState]=useState('复制');
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus({preventScroll:true});};},[]);
  const block=activity.block, result=activity.result;
  const output=result?.content.filter((b):b is {type:'text';text:string}=>b.type==='text').map(b=>b.text).join('\n')??(activity.status==='running'?'工具正在执行…':'没有记录到工具结果');
  const input=block.type==='toolCall'?Object.fromEntries(Object.entries(block.input??{}).filter(([key])=>!key.startsWith('_'))):{};
  const details=result?.details as {sessionId?:string;diff?:string}|undefined;
  return <dialog ref={dialog} className="craft-details" aria-labelledby={title} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section onClick={event=>event.stopPropagation()}>
      <header><ToolIcon activity={activity}/><h2 id={title}>{activity.name}</h2><ResultGlyph status={activity.status}/><button type="button" aria-label="关闭详情" title="关闭详情（Esc）" onClick={onClose}><X size={18}/></button></header>
      <div className="craft-detail-content">
        {activity.intent&&<p>{activity.intent}</p>}
        {block.type==='text'?<PortableTextBlock block={block} cwd={cwd} onOpenFile={onOpenFile}/>:<>
          <div className="craft-detail-heading"><h3>输入</h3><button type="button" onClick={()=>{void navigator.clipboard.writeText(JSON.stringify(input,null,2)+'\n\n'+output).then(()=>setCopyState('已复制')).catch(()=>setCopyState('复制失败'));}}><Copy size={14}/>{copyState}</button></div>
          <pre>{JSON.stringify(input,null,2)}</pre>
          {typeof input.path==='string'&&onOpenFile&&<button type="button" className="craft-file-link" onClick={()=>{onClose();onOpenFile(input.path as string);}}>打开文件：{input.path}</button>}
          <h3>输出</h3><pre>{output}</pre>
          {details?.diff&&<><h3>文件差异</h3><pre>{details.diff}</pre></>}
          {details?.sessionId&&onOpenSession&&<button type="button" onClick={()=>{onClose();onOpenSession(details.sessionId!);}}>打开子会话</button>}
          <Images result={result}/>
        </>}
      </div>
    </section>
  </dialog>;
}
const choices=new Map<string,boolean>();
export const PortableProcessTimeline=memo(function PortableProcessTimeline(props:Props){
  const {entries,toolResults,live=false,end,searchEntryId,searchBlock,sessionId,collapseKey,cwd,onOpenFile,onOpenSession}=props;
  const projection=useMemo(()=>projectCraftTurn(entries,toolResults,live,end),[entries,toolResults,live,end]);
  const activities=projection.activities as Activity[], responses=projection.responses as Activity[];
  const key=`${sessionId??''}:${collapseKey??entries[0]?.key??''}`;
  const [choice,setChoice]=useState<boolean|undefined>(()=>choices.get(key));
  const [selected,setSelected]=useState<string|null>(null),[menu,setMenu]=useState(false),[copyError,setCopyError]=useState('');
  const list=useRef<HTMLDivElement>(null),follow=useRef(true),header=useRef<HTMLButtonElement>(null);
  const target=activities.find(a=>a.entryId===searchEntryId&&(!searchBlock||a.block===searchBlock));
  const [reveal,setReveal]=useState<string|undefined>();
  useEffect(()=>{if(target){setChoice(true);setReveal(target.id);}},[target?.id]);
  useEffect(()=>{setChoice(choices.get(key));setSelected(null);setMenu(false);},[key]);
  const expanded=choice??live;
  useEffect(()=>{if(expanded&&live&&follow.current&&list.current)list.current.scrollTop=list.current.scrollHeight;},[activities.length,expanded,live]);
  useEffect(()=>{if(reveal&&expanded)list.current?.querySelector('[data-search-target="true"]')?.scrollIntoView({block:'nearest'});},[reveal,expanded]);
  const toggle=()=>{const next=!expanded;choices.set(key,next);if(choices.size>500)choices.delete(choices.keys().next().value!);setChoice(next);follow.current=true;};
  const current=activities.find(a=>a.status==='running')??activities.at(-1);
  const summary=end?.status==='stopped'?'已停止':end?.status==='error'?'执行失败':live?(current?.intent||current?.name||'正在处理…'):activities.some(a=>a.status==='unknown')?'部分结果未记录':undefined;
  const active=activities.find(a=>a.id===selected);
  return <div className="craft-transcript" data-craft-transcript="1">
    {activities.length>0&&<div className="craft-work-log">
      <div className="craft-log-header">
        <button ref={header} type="button" className="craft-summary" aria-expanded={expanded} onClick={toggle}>
          <ChevronRight size={14} aria-hidden="true" className={expanded?'craft-chevron open':'craft-chevron'}/>
          <span className="craft-summary-text"><strong>{activities.length} 个步骤{summary?'':'已完成'}</strong>{summary&&<><span> · </span>{summary}</>}</span>
          {projection.failedCount>0&&<span className="craft-failed-count">{projection.failedCount} 个失败</span>}
        </button>
        <div className="craft-actions"><button type="button" aria-label="步骤操作" title="步骤操作" aria-expanded={menu} onClick={()=>setMenu(!menu)}><MoreHorizontal size={16}/></button>{menu&&<div className="craft-menu"><button type="button" onClick={()=>{void navigator.clipboard.writeText(activities.map(a=>`${a.name} ${a.intent} ${a.input} [${a.status}]`).join('\n')).then(()=>{setMenu(false);setCopyError('');}).catch(()=>setCopyError('复制失败'));}}>复制步骤</button><button type="button" onClick={()=>{toggle();setMenu(false);}}>{expanded?'收起步骤':'展开步骤'}</button>{copyError&&<span role="alert">{copyError}</span>}</div>}</div>
      </div>
      {expanded&&<div ref={list} className="craft-log-body" onScroll={()=>{const el=list.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<32;}}>
        {activities.map(activity=><div key={activity.id} data-entry-id={activity.entryId} data-search-target={activity.id===target?.id||undefined} className="craft-row-wrap"><button type="button" className={'craft-activity-row '+activity.status} title={[activity.name,activity.intent,activity.input].filter(Boolean).join(' · ')} aria-label={`${activity.name}：${activity.status==='completed'?'已完成':activity.status==='error'?'错误':activity.status==='running'?'运行中':'未完成'}，查看详情`} onClick={()=>setSelected(activity.id)}><span className="craft-icon-slot"><ToolIcon activity={activity}/></span><span className="craft-tool-name">{activity.name}</span><span className="craft-object">{activity.intent&&<span>{activity.intent}</span>}{activity.input&&<code>{activity.input}</code>}</span>{activity.type==='tool'&&<ResultGlyph status={activity.status}/>}</button></div>)}
        {live&&!activities.some(a=>a.status==='running')&&<div className="craft-working" role="status"><LoaderCircle size={14}/>正在处理…</div>}
      </div>}
    </div>}
    {!activities.length&&live&&!responses.length&&<div className="craft-working" role="status"><LoaderCircle size={14}/>正在处理…</div>}
    {responses.map(activity=>activity.block.type==='text'?<div key={activity.id} className="craft-answer" data-entry-id={activity.entryId}><PortableTextBlock block={activity.block} isStreaming={live} cwd={cwd} onOpenFile={onOpenFile}/></div>:null)}
    {(projection.nodes as PortableTimelineEntry[]).map(entry=><Fragment key={entry.key}>{entry.kind==='node'?entry.node:entry.kind==='compaction'?<div className="craft-compaction">上下文已压缩</div>:entry.kind==='failure'?<InlineFailure failures={[{entryId:entry.entryId,raw:entry.message.errorMessage??'',truncated:entry.message.stopReason==='length',timestamp:entry.message.timestamp}]} continued={live}/>:null}</Fragment>)}
    <div className="craft-output-images">{activities.filter(a=>a.result?.content.some(b=>b.type==='image')).map(a=><Images key={a.id} result={a.result}/>)}</div>
    {active&&<Details key={active.id} activity={active} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} onClose={()=>setSelected(null)}/>}
  </div>;
});
