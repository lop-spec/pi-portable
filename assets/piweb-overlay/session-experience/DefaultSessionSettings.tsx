"use client";
import { useEffect, useMemo, useState } from "react";
import { ModelSelector } from "./ModelSelector";
import { ConfigSwitch } from "./SettingsUi";
import { writeThinkingPreference } from "@/lib/thinking-preference.mjs";

type Model = { provider: string; id: string; name: string };
type Data = { models: Model[]; defaultModel: { provider:string; modelId:string } | null; defaultThinkingLevel: string | null; thinkingLevels: Record<string,string[]> };
const labels: Record<string,string> = {off:"关闭",minimal:"最低",low:"低",medium:"中",high:"高",xhigh:"很高",max:"最高"};
export function DefaultSessionSettings({ cwd }: { cwd: string | null }) {
  const [data,setData]=useState<Data|null>(null), [key,setKey]=useState(""), [level,setLevel]=useState("");
  const [busy,setBusy]=useState(false), [notice,setNotice]=useState(""), [failed,setFailed]=useState(false), [existing,setExisting]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();
    const query=cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/session-defaults${query}`,{signal:controller.signal,cache:"no-store"}).then(async r=>{
      const result=await r.json(); if(!r.ok) throw Error(result.error || "读取失败");
      setData(result); const model=result.defaultModel;
      setKey(model ? `${model.provider}/${model.modelId}` : ""); setLevel(result.defaultThinkingLevel || "");
      setExisting(result.applyExisting !== false);
    }).catch(e=>{if(e.name!=="AbortError"){setFailed(true);setNotice(e.message || "读取失败");}});
    return ()=>controller.abort();
  },[cwd]);
  const selected=useMemo(()=>data?.models.find(m=>`${m.provider}/${m.id}`===key),[data,key]);
  const levels=selected ? data?.thinkingLevels[`${selected.provider}:${selected.id}`] ?? [] : [];
  const save=async()=>{
    if(!selected || !levels.includes(level)) return;
    setBusy(true);setNotice("");setFailed(false);
    try {
      const r=await fetch("/api/session-defaults",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({cwd,provider:selected.provider,modelId:selected.id,thinkingLevel:level,applyExisting:existing})});
      const result=await r.json(); if(!r.ok) throw Error(result.error || "保存失败");
      writeThinkingPreference(result.thinkingLevel);
      window.dispatchEvent(new CustomEvent("pi-web:default-session-settings",{detail:result}));
      setNotice("已保存");
    } catch(e) {setFailed(true);setNotice(e instanceof Error ? e.message : "保存失败");}
    finally {setBusy(false);}
  };
  return <section className="settings-general-section pw-default-session" data-session-defaults>
    <h3 className="settings-general-heading">会话默认</h3>
    <p className="settings-general-description">新会话使用默认值；运行中的任务不会中断。</p>
    <div className="pw-default-field"><span>默认模型</span><ModelSelector variant="field" ariaLabel="默认模型" disabled={!data||busy} options={(data?.models??[]).map(m=>({provider:m.provider,modelId:m.id,name:m.name}))} value={selected?{provider:selected.provider,modelId:selected.id}:null} onChange={(provider,modelId)=>{const next=`${provider}/${modelId}`;setKey(next);const allowed=data?.thinkingLevels[`${provider}:${modelId}`]??[];setLevel(old=>allowed.includes(old)?old:allowed.at(-1)??"");setNotice("");}} /></div>
    <label className="pw-default-field" htmlFor="pw-default-thinking"><span>推理强度</span><select id="pw-default-thinking" value={levels.includes(level)?level:""} disabled={!levels.length||busy} onChange={e=>{setLevel(e.target.value);setNotice("");}}><option value="" disabled>请选择</option>{levels.map(value=><option value={value} key={value}>{labels[value]??value}</option>)}</select></label>
    <div className="pw-default-apply"><span>已有会话跟随</span><ConfigSwitch checked={existing} disabled={busy} label="已有会话跟随" onChange={setExisting} /></div>
    <p className="settings-general-description">空闲后下次发送生效；之后单独切换的会话，以单独设置为准。</p>
    <div className="pw-default-actions"><button type="button" className="config-button config-button-small config-button-secondary" disabled={busy||!selected||!levels.includes(level)} onClick={()=>void save()}>{busy?"保存中":"保存默认"}</button>{notice&&<span role={failed?"alert":"status"}>{notice}</span>}</div>
  </section>;
}
