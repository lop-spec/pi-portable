// Reply metadata wins over the confirmed pre-first-token runtime fallback.
// Never infer historical models from the composer, localStorage, or defaults.
/** @param {{entries?: Array<{kind: string, message?: {model?: string, provider?: string}}>, live?: boolean, streamingMessage?: {model?: string, provider?: string}|null, activeModel?: {provider: string, modelId: string}|null, modelNames?: Record<string,string>}} props */
export function resolveTimelineModel({entries=[],live=false,streamingMessage,activeModel,modelNames={}}) {
  let reply=live&&streamingMessage?.model?streamingMessage:null;
  for(let i=entries.length-1;!reply&&i>=0;i--) {
    const entry=entries[i];
    if((entry.kind==='assistant'||entry.kind==='failure')&&entry.message?.model)reply=entry.message;
  }
  const modelId=reply?.model??(live?activeModel?.modelId:undefined);
  const provider=reply?.provider??(live?activeModel?.provider:undefined);
  if(!modelId)return null;
  const key=provider?`${provider}/${modelId}`:modelId;
  return {key,name:modelNames[`${provider}:${modelId}`]||modelId};
}
