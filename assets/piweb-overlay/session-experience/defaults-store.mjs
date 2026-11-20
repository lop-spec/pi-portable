import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const file = agentDir => path.join(agentDir, 'web-session-defaults.json');
const levels = new Set(['off','minimal','low','medium','high','xhigh','max']);
export function readSessionDefaults(agentDir) {
  try {
    const value=JSON.parse(fs.readFileSync(file(agentDir),'utf8'));
    if(value.version!==1 || typeof value.provider!=='string' || !value.provider || typeof value.modelId!=='string' || !value.modelId || !levels.has(value.thinkingLevel) || typeof value.applyExisting!=='boolean' || !Number.isFinite(value.updatedAt)) return null;
    return value;
  } catch { return null; }
}
export function writeSessionDefaults(agentDir, value) {
  const next={version:1,...value,updatedAt:Date.now()};
  const target=file(agentDir), temp=target+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(next)+'\n',{flag:'wx'});
  try { fs.renameSync(temp,target); } finally { try { fs.unlinkSync(temp); } catch {} }
  return next;
}
// The setting takes effect at the next idle prompt. Explicit later selections win.
export function planSessionDefaults(entries, setting) {
  if(!setting?.applyExisting) return {};
  let modelAt=0, thinkingAt=0, thinkingValue;
  for(const entry of entries) {
    const at=Date.parse(entry?.timestamp ?? '') || 0;
    if(entry?.type==='model_change')modelAt=at;
    if(entry?.type==='thinking_level_change'){thinkingAt=at;thinkingValue=entry.thinkingLevel;}
  }
  if(modelAt >= setting.updatedAt) return {};
  // Switching models can reset effort, so reapply a later explicit effort too.
  const thinking=thinkingAt >= setting.updatedAt && levels.has(thinkingValue) ? thinkingValue : setting.thinkingLevel;
  return {model:{provider:setting.provider,modelId:setting.modelId},thinking};
}
