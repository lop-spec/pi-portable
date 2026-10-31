// Request-policy contracts: exact payload/effort preservation, no network or live session edits.
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire}from'node:module';
const host=process.env.PI_TEST_HOST,candidate=process.env.PI_ASYNC_TEST_DIR;assert(host&&candidate);
const require=createRequire(path.join(host,'package.json')),{createJiti}=require('jiti');
const jiti=createJiti(import.meta.url,{moduleCache:false,fsCache:false,alias:{'@earendil-works/pi-coding-agent':path.join(host,'dist/index.js'),'@earendil-works/pi-ai':path.join(host,'node_modules/@earendil-works/pi-ai/dist/compat.js')}});
const policy=await jiti.import(path.join(candidate,'reasoning-context.ts'));
const extension=await jiti.import(path.join(candidate,'index.ts'));
const model={id:'gpt-6.1-sol',api:'openai-codex-responses',provider:'openai-codex'};
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
try{
 assert.equal(policy.REASONING_CONTEXT_MODELS,'all-codex-responses');
 for(const id of ['gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-6.1-sol','gpt-6.1-terra','gpt-5.6-sol','gpt-7-unknown'])for(const effort of ['low','medium','high','xhigh','max']){
  const payload=Object.freeze({model:id,reasoning:Object.freeze({effort,summary:'auto',mode:'standard'}),input:Object.freeze([{role:'user',content:'unchanged task'}]),tools:Object.freeze([{name:'read'}]),prompt_cache_key:'same-key'});
  const before=JSON.stringify(payload),r=policy.applyReasoningContextPolicy({...model,id},payload);
  assert.equal(r.changed,true);assert.equal(r.payload.reasoning.context,'current_turn');assert.equal(r.payload.reasoning.effort,effort);assert.equal(r.payload.reasoning.mode,'standard');assert.equal(r.payload.input,payload.input);assert.equal(r.payload.tools,payload.tools);assert.equal(r.payload.prompt_cache_key,'same-key');assert.equal(JSON.stringify(payload),before);
 }
 for(const context of ['current_turn','all_turns',null]){
  const payload={model:model.id,reasoning:{effort:'medium',context},input:[]};const r=policy.applyReasoningContextPolicy(model,payload);assert.equal(r.changed,false);assert.equal(r.payload,payload);
 }
 assert.equal(policy.applyReasoningContextPolicy(model,{model:model.id,reasoning:{effort:'medium',context:'auto'}}).payload.reasoning.context,'current_turn');
 for(const [m,p]of [
  [model,null],[model,[]],[model,{model:model.id,input:[]}],
  [{...model,api:'anthropic-messages'},{model:model.id,reasoning:{effort:'medium'}}],
  [{...model,provider:'pi-chatgpt-web'},{model:model.id,reasoning:{effort:'medium'}}],
  [{...model,provider:'anthropic'},{model:'claude-opus-5-5',reasoning:{effort:'medium'}}],
 ])assert.equal(policy.applyReasoningContextPolicy(m,p).payload,p);
 const legacy={...model,provider:'codex-bridge',api:'openai-responses'};
 assert.equal(policy.applyReasoningContextPolicy(legacy,{model:model.id,reasoning:{effort:'high'}}).payload.reasoning.context,'current_turn');
 let calls=0;
 const wrapped=policy.withReasoningContextPolicy(model,p=>{calls++;assert.equal(p.reasoning.context,'current_turn');return{...p,fixture:'retained'};});
 const result=await wrapped({model:model.id,reasoning:{effort:'high'},input:[]},model);assert.equal(calls,1);assert.equal(result.fixture,'retained');assert.equal(result.reasoning.effort,'high');
 const explicit=await policy.withReasoningContextPolicy(model,p=>({...p,reasoning:{...p.reasoning,context:'all_turns'}}))({model:model.id,reasoning:{effort:'medium'}},model);assert.equal(explicit.reasoning.context,'all_turns');
 assert.equal(await policy.withReasoningContextPolicy(model,()=>null)({model:model.id,reasoning:{effort:'medium'}},model),null,'invalid null callback result must not be silently hidden');
 await assert.rejects(()=>policy.withReasoningContextPolicy(model,()=>{throw Error('existing prefix guard');})({model:model.id,reasoning:{effort:'medium'}},model),/existing prefix guard/);
 const handlers=new Map(),logs=[];const pi={on(name,fn){const a=handlers.get(name)||[];a.push(fn);handlers.set(name,a);return()=>{};},registerCommand(){},appendEntry(){}};
 extension.install(pi,{config:{...extension.readConfig(''),enabled:false},log:r=>logs.push(r)});
 const ctx={model,sessionManager:{getSessionId:()=> 'offline-policy-fixture'}};
 let event={type:'before_provider_request',payload:{model:model.id,reasoning:{effort:'medium'},input:[]}};
 for(const fn of handlers.get('before_provider_request')||[]){const returned=await fn(event,ctx);if(returned!==undefined)event={...event,payload:returned};}
 assert.equal(event.payload.reasoning.context,'current_turn','request policy remains active when background compaction is disabled');assert.equal(event.payload.reasoning.effort,'medium');assert.equal(logs.filter(r=>r.event==='reasoning-context-applied').length,1);
 assert(!JSON.stringify(logs).includes('unchanged task'),'no prompt or tool content in policy logs');
 console.log('PASS request policy: all Codex Responses models (incl. terra/unknown) x five efforts; immutable inputs/tools/key; explicit scopes respected; unrelated/off requests unchanged; callbacks once; no hidden null fallback; compaction-disabled main requests still protected; network=0');
}finally{globalThis.fetch=originalFetch;}
