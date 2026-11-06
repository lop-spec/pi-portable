// Reply metadata wins over the confirmed pre-first-token runtime fallback.
// Never infer historical models from the composer, localStorage, or defaults.
/** @typedef {{model?:string,provider?:string,runtimeModel?:{provider:string,modelId:string,reasoning:string}}} ModelMessage */
/** @param {{entries?: Array<{kind: string, message?: ModelMessage}>, live?: boolean, streamingMessage?: ModelMessage|null, activeModel?: {provider: string, modelId: string}|null, modelNames?: Record<string,string>}} props */
export function resolveTimelineModel({entries=[],live=false,streamingMessage,activeModel,modelNames={}}) {
  let reply=live&&streamingMessage?.model?streamingMessage:null;
  for(let i=entries.length-1;!reply&&i>=0;i--) {
    const entry=entries[i];
    if((entry.kind==='assistant'||entry.kind==='failure')&&entry.message?.model)reply=entry.message;
  }
  const actual=reply?.runtimeModel;
  const modelId=actual?.modelId??reply?.model??(live?activeModel?.modelId:undefined);
  const provider=actual?.provider??reply?.provider??(live?activeModel?.provider:undefined);
  if(!modelId)return null;
  const key=provider?`${provider}/${modelId}`:modelId;
  const webName=provider==='pi-chatgpt-web'?({'chatgpt-web-instant':'GPT-5.6 Sol','chatgpt-web-astra':'GPT-6'}[modelId]):undefined;
  const name=actual&&webName?`${webName} · 网页`:modelNames[`${provider}:${modelId}`]||modelId;
  return actual?.reasoning?{key,name:`${name} · ${actual.reasoning}`,reasoning:actual.reasoning}:{key,name};
}
