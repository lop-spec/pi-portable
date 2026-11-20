"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { getFileName } from "@/lib/file-paths";
import { artifactsPopoverPlacement } from "@/lib/artifacts-popover-placement.mjs";
import "../app/session-experience.css";

type Artifact = {filePath:string; extension:string; source:"written"|"referenced"};
export function SessionArtifacts({sessionId,onOpenFile,mobile=false}:{sessionId:string|null;onOpenFile?:(path:string)=>void;mobile?:boolean}) {
  const root=useRef<HTMLDivElement>(null), [open,setOpen]=useState(false), [files,setFiles]=useState<Artifact[]>([]);
  const [filter,setFilter]=useState("md"), [loading,setLoading]=useState(false), [error,setError]=useState("");
  const [refresh,setRefresh]=useState(0), [position,setPosition]=useState({left:12,top:48,width:300});
  useEffect(()=>{
    if(!open)return;
    const place=()=>{const rect=root.current?.getBoundingClientRect();if(rect)setPosition(artifactsPopoverPlacement(rect,window.innerWidth,window.innerHeight));};
    place();window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
    return ()=>{window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);};
  },[open]);
  useEffect(()=>{setOpen(false);setFiles([]);setError("");setFilter("md");},[sessionId]);
  useEffect(()=>{
    if(!open || !sessionId) return;
    const controller=new AbortController();setLoading(true);setError("");
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,{cache:"no-store",signal:controller.signal}).then(async r=>{
      const data=await r.json();if(!r.ok)throw Error(data.error||"读取失败");setFiles(Array.isArray(data.files)?data.files:[]);
    }).catch(e=>{if(e.name!=="AbortError")setError(e.message||"读取失败");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,sessionId,refresh]);
  useEffect(()=>{
    if(!open)return;
    const click=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false);};
    document.addEventListener("mousedown",click);document.addEventListener("keydown",key);
    return ()=>{document.removeEventListener("mousedown",click);document.removeEventListener("keydown",key);};
  },[open]);
  const formats=useMemo(()=>[...new Set(files.map(file=>file.extension).filter(Boolean).filter(ext=>ext!=="md"))].sort(),[files]);
  const visible=files.filter(file=>filter==="*"||file.extension===filter);
  return <div ref={root} className="pw-session-artifacts">
    <button type="button" className={mobile?"pw-tb-btn is-icon":"pw-tb-btn"} disabled={!sessionId} title="当前会话产物" aria-label="当前会话产物" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h11l5 5v11H4z"/><path d="M14 4v6h6M8 14h8M8 17h6"/></svg>{!mobile&&<span className="pw-tb-label">产物</span>}
    </button>
    {open&&<div className="pw-artifacts-panel" style={{position:"fixed",left:position.left,top:position.top,width:position.width,maxHeight:`calc(100dvh - ${position.top+12}px)`}} role="dialog" aria-label="当前会话产物">
      <div className="pw-artifacts-head"><strong>会话产物</strong><label>格式 <select aria-label="产物格式" value={filter} onChange={e=>setFilter(e.target.value)}><option value="md">MD</option><option value="*">全部</option>{formats.map(ext=><option value={ext} key={ext}>{ext.toUpperCase()}</option>)}</select></label><button type="button" className="pw-icon-btn" title="刷新产物" aria-label="刷新产物" onClick={()=>setRefresh(v=>v+1)}>↻</button></div>
      {loading?<p role="status">正在读取…</p>:error?<p role="alert">{error}</p>:visible.length===0?<p>此格式暂无产物</p>:<ul>{visible.map(file=><li key={file.filePath}><button type="button" title={file.filePath} onClick={()=>{onOpenFile?.(file.filePath);setOpen(false);}}><span>{getFileName(file.filePath)}</span><small>{file.source==="written"?"会话写入":"回复引用"}</small></button></li>)}</ul>}
    </div>}
  </div>;
}
