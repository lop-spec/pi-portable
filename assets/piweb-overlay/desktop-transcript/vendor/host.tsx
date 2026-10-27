// Browser bindings for the vendored Desktop UI. No Electron/host-core imports.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { getChatRemarkPlugins, getChatRehypePlugins, markdownUrlTransform } from "@/lib/markdown";
import { HighlightedCode } from "./syntax";
const markdownRemarkPlugins=getChatRemarkPlugins("");
const markdownRehypePlugins=getChatRehypePlugins(undefined,true,"pending");
import { portableLoadThinkingContent } from "../MessageView";
import { zhCN } from "./zh-CN";
import type { UiMessage } from "./model";
import { IconCheck, IconCopy } from "./icons";
import { MAX_SYNC_MARKDOWN_CODE_UNITS } from "./render-content-limits";
import { resolveLocalFileHref } from "@/lib/file-links";
export const TranscriptSearchContext=createContext<{messageId:string;requestId:number}|null>(null);
export const HostContext=createContext<{cwd?:string;sessionId?:string;onOpenFile?:(path:string,page?:number)=>void}>({});
export const MessageContext=createContext<UiMessage|null>(null);
const catalog=zhCN as unknown as Record<string,unknown>;
const translate=(key:string,params:Record<string,unknown>={})=>{
  const get=(name:string)=>name.split(".").reduce<unknown>((o,k)=>o&&typeof o==="object"?(o as Record<string,unknown>)[k]:undefined,catalog);
  const value=(typeof params.count==="number"?get(key+(params.count===1?"_one":"_other")):undefined)??get(key)??params.defaultValue??key;
  return String(value).replace(/\{\{(\w+)\}\}/g,(_,name)=>String(params[name]??""));
};
export const useTranslation=()=>({t:translate});
export const cx=(...values:Array<unknown>)=>values.filter(Boolean).join(" ");
export function TooltipButton({ariaLabel,tooltip,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{ariaLabel?:string;tooltip?:string}){
  return <button type="button" {...props} aria-label={ariaLabel??props["aria-label"]} title={tooltip??props.title}/>;
}
export function Button({variant:_variant,size:_size,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string;size?:string}) {return <button type="button" className="copy-btn" {...props}/>;}
export function useCopy(){
  const [copied,setCopied]=useState(false); const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const copy=useCallback((text:string)=>{void navigator.clipboard.writeText(text).then(()=>{setCopied(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),1500);}).catch(console.error);},[]);
  return {copied,copy};
}
export function useAppStore<T>(selector:(state:{workspace?:{path?:string};settings:{showThinking:boolean}})=>T){
  const host=useContext(HostContext);return selector({workspace:{path:host.cwd},settings:{showThinking:true}});
}
export const resolveShowThinking=(settings:{showThinking:boolean})=>settings.showThinking;
export const thinkingText=(message:UiMessage)=>typeof message.thinking==="string"&&message.thinking.trim()?message.thinking:"";
export const toWorkspaceRel=(path:string,_root?:string)=>path||null;
export function useOpenPreviewTarget(){
  const host=useContext(HostContext);
  return useCallback((target:{kind:string;path?:string;url?:string})=>{
    if(target.kind==="file"&&target.path)host.onOpenFile?.(target.path);
    else if(target.url&&/^https?:\/\//i.test(target.url))window.open(target.url,"_blank","noopener,noreferrer");
  },[host]);
}
type Menu={x:number;y:number;path:string}|null;
export function useChatFileMenu(){
  const [fileMenu,setMenu]=useState<Menu>(null);
  return {fileMenu,openFileMenu:(event:MouseEvent,target:{path:string})=>{event.preventDefault();setMenu({x:event.clientX,y:event.clientY,path:target.path});},closeFileMenu:()=>setMenu(null)};
}
export function ContextMenu({state,onClose}:{state:Menu;onClose:()=>void}){
  const host=useContext(HostContext);
  useEffect(()=>{if(!state)return;const close=()=>onClose();window.addEventListener("pointerdown",close);return()=>window.removeEventListener("pointerdown",close);},[state,onClose]);
  if(!state)return null;
  return <div role="menu" className="pd-file-menu" style={{position:"fixed",left:Math.min(state.x,window.innerWidth-160),top:Math.min(state.y,window.innerHeight-80),zIndex:90}} onPointerDown={e=>e.stopPropagation()}>
    <button role="menuitem" onClick={()=>{host.onOpenFile?.(state.path);onClose();}}>打开文件</button>
    <button role="menuitem" onClick={()=>{void navigator.clipboard.writeText(state.path);onClose();}}>复制路径</button>
  </div>;
}
export { HighlightedCode } from "./syntax";
export function AskToolRichText({source}:{source:string}){return <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>{source}</ReactMarkdown>;}
function CodeBlock({code,lang}:{code:string;lang:string}){
  const {copied,copy}=useCopy();return <div className="code-block"><div className="code-block-head"><span className="code-block-lang">{lang||"text"}</span><TooltipButton className="code-copy-btn" ariaLabel="复制" tooltip={copied?"已复制":"复制"} onClick={()=>copy(code)}>{copied?<IconCheck size={13}/>:<IconCopy size={13}/>}</TooltipButton></div><pre><code><HighlightedCode code={code} lang={lang}/></code></pre></div>;
}
export function Markdown({source,renderDiagrams:_renderDiagrams,streaming:_streaming}:{source:string;renderDiagrams?:boolean;streaming?:boolean}){
  const host=useContext(HostContext),message=useContext(MessageContext);
  const [full,setFull]=useState<{id:string;text:string}|null>(null),[error,setError]=useState("");
  const block=message?.sourceBlock;const deferred=block?.type==="thinking"&&block.deferred;
  useEffect(()=>{
    if(!deferred||!host.sessionId||!message?.entryId||full?.id===message.id)return;
    let current=true;setError("");
    portableLoadThinkingContent(host.sessionId,message.entryId,message.blockIndex??0,block.entryQuery).then(text=>{if(current)setFull({id:message.id,text});}).catch(error=>{if(current)setError(String(error));});
    return()=>{current=false;};
  },[deferred,host.sessionId,message?.id,message?.entryId,message?.blockIndex,block,full]);
  const text=full?.id===message?.id?full!.text:source;
  if(text.length>MAX_SYNC_MARKDOWN_CODE_UNITS)return <div className="markdown-plain-fallback"><div role="status">{translate("chat.markdownPlainTextFallback")}</div><pre>{text}</pre></div>;
  return <>
    {error?<div role="alert">{error}</div>:null}
    <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} urlTransform={markdownUrlTransform} components={{
      pre:({children})=><>{children}</>,
      code:({className,children})=>{const raw=String(children);return className||raw.includes("\n")?<CodeBlock code={raw.replace(/\n$/,"")} lang={className?.replace("language-","")??""}/>:<code>{children}</code>;},
      a:({href,children})=>{const file=resolveLocalFileHref(href,host.cwd);return <a href={href} target="_blank" rel="noopener noreferrer" onClick={file&&host.onOpenFile?event=>{event.preventDefault();host.onOpenFile?.(file);}:undefined}>{children}</a>;},
      img:({src,alt})=><img src={typeof src==="string"?src:undefined} alt={alt??""}/>,
      audio:({src})=><audio controls preload="metadata" src={src}/>,
      video:({src})=><video controls preload="metadata" src={src}/>,
      table:({children})=><div className="table-wrap"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown>
  </>;
}
