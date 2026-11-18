"use client";
// Adapted from Craft Agents WorkLog.tsx / ActivityRow.tsx (Apache-2.0).
// Host bindings use Pi messages and Cetus file previews, not Electron IPC.
import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleX, ChevronRight, Terminal, FileText, Search, Globe, Wrench, MessageSquareText, LoaderCircle, Minus, X, MoreHorizontal } from 'lucide-react';
import type { AssistantContentBlock, AssistantMessage, ToolResultMessage } from '@/lib/types';
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
type Props = {entries:PortableTimelineEntry[];toolResultEntryIds?:Map<string,string>;toolResults:Map<string,ToolResultMessage>;cwd?:string;sessionId?:string;searchEntryId?:string;searchBlock?:AssistantContentBlock;live?:boolean;modelNames?:Record<string,string>;collapseKey?:string;startedAt?:number;end?:TimelineEnd|null;phase?:string|null;streamingMessage?:AssistantMessage|null;onOpenFile?:(path:string,page?:number)=>void;onOpenSession?:(session:string)=>void};
type Activity = {excerpt?:string;id:string;entryId?:string;block:AssistantContentBlock;timestamp?:number;type:string;result?:ToolResultMessage;status:string;name:string;intent:string;input:string};
type WorkPhase = {id:string;name:string;status:string;items:Activity[];errors:number;toolCount:number};
const statusNames:Record<string,string> = {completed:'已完成',error:'错误',running:'进行中',stopped:'已停止',unknown:'待确认',waiting:'等你选择',blocked:'受阻',finished:'已结束'};
function ToolIcon({activity}:{activity:Activity}) {
  const name = activity.block.type === 'toolCall' ? activity.block.toolName.toLowerCase() : '';
  const Icon = activity.type === 'intermediate' ? MessageSquareText : /bash|shell|exec/.test(name) ? Terminal : /read|write|edit/.test(name) ? FileText : /grep|find|search/.test(name) ? Search : /browser|web/.test(name) ? Globe : Wrench;
  return <Icon size={14} aria-hidden="true"/>;
}
function ResultGlyph({status}:{status:string}) {
  const label = statusNames[status] ?? '待确认';
  const Icon = status === 'completed' ? Check : status === 'error' || status === 'blocked' ? CircleX : status === 'running' ? LoaderCircle : Minus;
  return <span className={'craft-result '+status} role="img" aria-label={label} title={label}>{['error','blocked','waiting','stopped','unknown','finished'].includes(status)&&<span>{label}</span>}<Icon size={14} aria-hidden="true"/></span>;
}
function Images({result}:{result?:ToolResultMessage}) {
  return <>{result?.content.map((block,index)=>{
    if(block.type!=='image')return null;
    const image=block as unknown as {source?:{url?:string;data?:string;media_type?:string};data?:string;mimeType?:string};
    const src=image.source?.url??(image.source?.data?`data:${image.source.media_type};base64,${image.source.data}`:image.data?`data:${image.mimeType};base64,${image.data}`:'');
    return src?<ImagePreview key={index} src={src}><img className="craft-output-image" src={src} alt="工具生成图片"/></ImagePreview>:null;
  })}</>;
}
function Details({activity,onClose,cwd,onOpenFile}:{activity:Activity;onClose:()=>void;cwd?:string;onOpenFile?:Props['onOpenFile']}) {
  const dialog=useRef<HTMLDialogElement>(null),title=useId();
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus({preventScroll:true});};},[]);
  return <dialog ref={dialog} className="craft-details" aria-labelledby={title} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section onClick={event=>event.stopPropagation()}>
      <header><ToolIcon activity={activity}/><h2 id={title}>{activity.name}</h2><ResultGlyph status={activity.status}/><button type="button" aria-label="关闭详情" onClick={onClose}><X size={18}/></button></header>
      <div className="craft-detail-content">
        {activity.block.type==='text'?<PortableTextBlock block={activity.block} cwd={cwd} onOpenFile={onOpenFile}/>:<pre data-call-result-excerpt>{activity.excerpt || (activity.status==='running'?'正在等工具返回结果':'这次调用没有可摘录的中文结果')}</pre>}
      </div>
    </section>
  </dialog>;
}
const choices=new Map<string,boolean>();
export const PortableProcessTimeline=memo(function PortableProcessTimeline(props:Props){
  const {entries,toolResults,live=false,end,searchEntryId,searchBlock,sessionId,collapseKey,cwd,onOpenFile}=props;
  const projection=useMemo(()=>projectCraftTurn(entries,toolResults,live,end),[entries,toolResults,live,end]);
  const activities=projection.activities as Activity[], responses=projection.responses as Activity[], phases=projection.phases as WorkPhase[];
  const key=`${sessionId??''}:${collapseKey??entries[0]?.key??''}`;
  const [choice,setChoice]=useState<boolean|undefined>(()=>choices.get(key));
  const [selected,setSelected]=useState<string|null>(null),[menu,setMenu]=useState(false),[copyError,setCopyError]=useState('');
  const [closedPhases,setClosedPhases]=useState<Set<string>>(()=>new Set());
  const list=useRef<HTMLDivElement>(null),follow=useRef(true),header=useRef<HTMLButtonElement>(null);
  const target=activities.find(a=>a.entryId===searchEntryId&&(!searchBlock||a.block===searchBlock));
  const [reveal,setReveal]=useState<string|undefined>();
  useEffect(()=>{setChoice(choices.get(key));setSelected(null);setMenu(false);setClosedPhases(new Set());},[key]);
  useEffect(()=>{if(target){setChoice(true);setReveal(target.id);const phase=phases.find(p=>p.items.some(a=>a.id===target.id));if(phase)setClosedPhases(previous=>{const next=new Set(previous);next.delete(phase.id);return next;});}},[target?.id,key]);
  const expanded=choice??true;
  useEffect(()=>{if(expanded&&live&&follow.current&&list.current)list.current.scrollTop=list.current.scrollHeight;},[activities.length,expanded,live]);
  useEffect(()=>{if(reveal&&expanded)list.current?.querySelector('[data-search-target="true"]')?.scrollIntoView({block:'nearest'});},[reveal,expanded]);
  const toggle=()=>{const next=!expanded;choices.set(key,next);if(choices.size>500)choices.delete(choices.keys().next().value!);setChoice(next);follow.current=true;};
  const current=phases.find(p=>p.status==='waiting')??phases.find(p=>p.status==='running')??phases.at(-1);
  const summary=end?.status==='stopped'?'已停止':end?.status==='error'?'受阻':live?(current?.status==='waiting'?'等你选择':'进行中'):phases.some(p=>p.status==='unknown')?'部分记录待确认':undefined;
  const active=activities.find(a=>a.id===selected);
  return <div className="craft-transcript" data-craft-transcript="1" data-timeline="craft">
    {activities.length>0&&<div className="craft-work-log">
      <div className="craft-log-header">
        <button ref={header} type="button" className="craft-summary" aria-expanded={expanded} onClick={toggle}>
          <ChevronRight size={14} aria-hidden="true" className={expanded?'craft-chevron open':'craft-chevron'}/>
          <span className="craft-summary-text"><strong>{phases.length} 个阶段</strong>{summary&&<><span> · </span>{summary}</>}</span>
          {phases.some(p=>p.status==='blocked')&&<span className="craft-failed-count">需要处理</span>}
        </button>
        <div className="craft-actions"><button type="button" aria-label="阶段操作" title="阶段操作" aria-expanded={menu} onClick={()=>setMenu(!menu)}><MoreHorizontal size={16}/></button>{menu&&<div className="craft-menu"><button type="button" onClick={()=>{void navigator.clipboard.writeText(phases.map(p=>`${statusNames[p.status]}：${p.name}`).join('\n')).then(()=>{setMenu(false);setCopyError('');}).catch(()=>setCopyError('复制失败'));}}>复制进度</button><button type="button" onClick={()=>{toggle();setMenu(false);}}>{expanded?'收起阶段':'展开阶段'}</button>{copyError&&<span role="alert">{copyError}</span>}</div>}</div>
      </div>
      {expanded&&<div ref={list} className="craft-log-body" onScroll={()=>{const el=list.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<32;}}>
        {phases.map(phase=><div key={phase.id} className="craft-phase" data-phase-status={phase.status}>
          <button type="button" className={'craft-phase-row '+phase.status} aria-expanded={!closedPhases.has(phase.id)} title={`${phase.name} · ${statusNames[phase.status]} · 展开或收起执行记录`} onClick={()=>setClosedPhases(previous=>{const next=new Set(previous);if(next.has(phase.id))next.delete(phase.id);else next.add(phase.id);return next;})}><ChevronRight size={14} aria-hidden="true" className={!closedPhases.has(phase.id)?'craft-chevron open':'craft-chevron'}/><span className="craft-tool-name">{phase.name}</span><ResultGlyph status={phase.status}/></button>
          {!closedPhases.has(phase.id)&&<div className="craft-phase-items">{phase.items.filter(activity=>activity.name).map(activity=><div key={activity.id} data-entry-id={activity.entryId} data-search-target={activity.id===target?.id||undefined} className="craft-row-wrap"><button type="button" className={'craft-activity-row '+activity.status} title={`${activity.name} · 点击查看详情`} aria-label={`${activity.name}：${statusNames[activity.status]}，查看详情`} onClick={()=>setSelected(activity.id)}><span className="craft-icon-slot"><ToolIcon activity={activity}/></span><span className="craft-tool-name" data-call-excerpt={activity.type==='tool'||undefined}>{activity.name}</span>{activity.type==='tool'&&<ResultGlyph status={activity.status}/>}</button></div>)}</div>}
        </div>)}
      </div>}
    </div>}
    {!activities.length&&live&&!responses.length&&<div className="craft-working" role="status"><LoaderCircle size={14}/>正在处理…</div>}
    {responses.map(activity=>activity.block.type==='text'?<div key={activity.id} className="craft-answer" data-entry-id={activity.entryId}><PortableTextBlock block={activity.block} isStreaming={live} cwd={cwd} onOpenFile={onOpenFile}/></div>:null)}
    {(projection.nodes as PortableTimelineEntry[]).map(entry=><Fragment key={entry.key}>{entry.kind==='node'?entry.node:entry.kind==='compaction'?<div className="craft-compaction">上下文已压缩</div>:entry.kind==='failure'?<InlineFailure failures={[{entryId:entry.entryId,raw:entry.message.errorMessage??'',truncated:entry.message.stopReason==='length',timestamp:entry.message.timestamp}]} continued={live}/>:null}</Fragment>)}
    <div className="craft-output-images">{activities.filter(a=>a.result?.content.some(b=>b.type==='image')).map(a=><Images key={a.id} result={a.result}/>)}</div>
    {active&&<Details key={active.id} activity={active} cwd={cwd} onOpenFile={onOpenFile} onClose={()=>setSelected(null)}/>}
  </div>;
});
