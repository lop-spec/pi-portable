// Real SDK + real Codex serializer, deterministic provider output. Absolutely no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const host=process.env.PI_TEST_HOST, candidate=process.env.PI_ASYNC_TEST_DIR;
assert.ok(host&&candidate);
const aiRoot=path.join(host,'node_modules/@earendil-works/pi-ai/dist');
const sdk=await import(pathToFileURL(path.join(host,'dist/index.js')));
const ai=await import(pathToFileURL(path.join(aiRoot,'compat.js')));
const native=await import(pathToFileURL(path.join(aiRoot,'api/openai-codex-responses.js')));
const {AssistantMessageEventStream}=await import(pathToFileURL(path.join(aiRoot,'utils/event-stream.js')));
const require=createRequire(path.join(host,'package.json'));
const {createJiti}=require('jiti');
const jiti=createJiti(import.meta.url,{moduleCache:false,fsCache:false,alias:{'@earendil-works/pi-coding-agent':path.join(host,'dist/index.js'),'@earendil-works/pi-ai':path.join(aiRoot,'compat.js')}});
const mod=await jiti.import(path.join(candidate,'index.ts'));
const cachedMod=await jiti.import(path.join(candidate,'cached-summary.ts'));
const SUMMARY_LEVEL=mod.readConfig('').thinkingLevel;
assert.equal(SUMMARY_LEVEL,'high'); // fixed-mode compatibility setting, not the request-mode summary target
assert.equal(mod.readConfig('').thinkingMode,'request');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-cached-sdk-'));
const fakeJWT='e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline-fixture'}})).toString('base64url')+'.x';
const originalFetch=globalThis.fetch,originalNow=Date.now,originalRetention=process.env.PI_CACHE_RETENTION;
let clockShiftMs=0;
Date.now=()=>originalNow()+clockShiftMs;
process.env.PI_CACHE_RETENTION='short';
globalThis.fetch=()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{for(let i=0;i<1000;i++){if(fn())return;await sleep(10);}throw Error('Timeout '+label);};
const user=text=>({role:'user',content:text,timestamp:Date.now()});
function result(model,content,stopReason='stop') {return {role:'assistant',model:model.id,provider:model.provider,api:model.api,timestamp:Date.now(),content,stopReason,usage:{input:100,cacheRead:1000,cacheWrite:0,output:10,totalTokens:1110,cost:{input:0,cacheRead:0,cacheWrite:0,output:0,total:0}}};}
try {
 // Every prefix-sensitive change rejects BEFORE a request can be sent; reasoning is not exempt.
 const p={model:'fixture',instructions:'same',tools:[{name:'test'}],reasoning:{effort:'max'},input:[{role:'user',content:'old'}],prompt_cache_key:'main'};
 const next={...structuredClone(p),input:[...p.input,{role:'user',content:'summary'}],max_output_tokens:128000};
 assert.deepEqual(cachedMod.checkedSummaryPayload(p,next),next);
 for(const field of ['model','instructions','tools','reasoning','prompt_cache_key']) assert.throws(()=>cachedMod.checkedSummaryPayload(p,{...next,[field]:'changed'}),new RegExp('prefix_field_changed:'+field));
 assert.throws(()=>cachedMod.checkedSummaryPayload(p,{...next,input:[{role:'user',content:'edited'},...next.input.slice(1)]}),/prefix_message_changed/);
 assert.throws(()=>cachedMod.checkedSummaryPayload(p,p),/prefix_not_extended/);
 console.log('PASS exact payload-prefix guards: system/tools/reasoning/model/key/messages; output limit alone may differ');
 for(const mode of ['cached','request-xhigh','request-max','request-low','request-xhigh-error','switch-before-start','long-main','stale-after-response','declared-ttl-expired','main-different','cached-tool-use','cached-error','main-switch','source-edited','no-cache','no-payload','unsupported-level']) {
  clockShiftMs=0;
  const summaryLevel=mode.startsWith('request-xhigh')||mode==='switch-before-start'?'xhigh':mode==='request-max'?'max':mode==='request-low'?'low':SUMMARY_LEVEL;
  const logs=[],wire=[];let mainCalls=0,summaryCalls=0,cachedCalls=0,toolCalls=0,session;
  const model={...ai.getModel('openai-codex','gpt-6-sol'),contextWindow:0,maxTokens:128000,
   ...(['long-main','stale-after-response','declared-ttl-expired'].includes(mode)?{promptCache:{short:300,long:3600}}:{})};
  if(mode==='unsupported-level')model.thinkingLevelMap={...model.thinkingLevelMap,[SUMMARY_LEVEL]:null};
  const runtime=await sdk.ModelRuntime.create({authPath:path.join(temp,mode+'-auth.json'),modelsPath:null,refreshOnCreate:false});
  const fixtureStream=(m,context,options={})=>{
   const out=new AssistantMessageEventStream();
   void(async()=>{
    let payload,error;
    const serialized=await native.streamSimple(m,context,{...options,apiKey:fakeJWT,transport:'sse',maxRetries:0,onPayload:async p=>{
      try {payload=mode==='no-payload'?p:await options.onPayload?.(p,m)??p;}
      catch(e){error=e;}
      throw Error('offline_serializer_capture_only'); // the provider never gets to fetch()
    }}).result();
    if(error){const r=result(m,[],'error');r.errorMessage='prefix rejected';out.push({type:'error',reason:'error',error:r});out.end(r);return;}
    assert.ok(payload,serialized.errorMessage);
    const encoded=JSON.stringify(payload);
    const isCached=encoded.includes('Stop working on the task. Do not call any tools.');
    const isNative=String(payload.instructions).startsWith('You are a context summarization assistant.');
    let r;
    if(isCached||isNative){
     summaryCalls++;if(isCached)cachedCalls++;
     assert.equal(options.reasoning,summaryLevel);assert.equal(payload.reasoning.effort,summaryLevel);
     if(isCached){
      assert.equal(options.transport,'auto');assert.equal(options.sessionId,session.sessionId+':summary');assert.equal(payload.prompt_cache_key,session.sessionId);
      assert.ok(encoded.includes('TOOL_OUTPUT_END_MUST_BE_VISIBLE'));
      assert.ok(encoded.includes(mod.SUMMARY_INSTRUCTIONS.replace(/\n/g,'\\n')));
      assert.ok(!encoded.includes('current-active-tool'),'in-flight assistant call is not summary input');
      if(mode==='cached-error'||mode==='request-xhigh-error')r=result(m,[],'error');
      else if(mode==='cached-tool-use')r=result(m,[{type:'toolCall',id:'forbidden',name:'fixture_tool',arguments:{}}],'toolUse');
     }
     r??=result(m,[{type:'text',text:'## Goal\nPreserve constraints.\n## Progress\nHistorical fixture complete.'}]);
    } else {
     mainCalls++;assert.ok(mainCalls<=2);
     r=result(m,mainCalls===1?[{type:'toolCall',id:'current-active-tool',name:'fixture_tool',arguments:{}}]:[{type:'text',text:'MAIN_FINAL_RETAINED'}],mainCalls===1?'toolUse':'stop');
     if(mode==='no-cache')r.usage.cacheRead=0;
    }
    if(mode!=='no-payload')assert.equal(payload.reasoning.context,'current_turn','main and side-channel summaries must share the request policy');
    if(!isCached&&!isNative&&mainCalls===1){
     // The fake provider reports an actual watermark crossing for the initial tool call.
     r.usage.input=800000;r.usage.totalTokens=801010;
     if(mode==='long-main')clockShiftMs+=90000;
     if(mode==='declared-ttl-expired')clockShiftMs+=301000;
    }
    wire.push({cached:isCached,native:isNative,payload});
    const deliver=()=>{out.push({type:r.stopReason==='error'?'error':'done',reason:r.stopReason,message:r,error:r});out.end(r);};
    if(isCached||isNative)setTimeout(deliver,120);else queueMicrotask(deliver);
   })().catch(e=>{console.error(e);out.end(result(model,[],'error'));});
   return out;
  };
  runtime.registerProvider('openai-codex',{api:'openai-codex-responses',baseUrl:'https://offline.invalid',apiKey:fakeJWT,streamSimple:fixtureStream});
  const nativeSettings={enabled:true,reserveTokens:144000,keepRecentTokens:256};
  const settingsManager=sdk.SettingsManager.inMemory({compaction:nativeSettings,retry:{enabled:false}});
  const sm=sdk.SessionManager.create(temp,path.join(temp,mode));
  for(let n=0;n<5;n++){sm.appendMessage(user('Old user '+n+' historical context '.repeat(100)));sm.appendMessage(result(model,[{type:'text',text:'Old completed result '+n}]));}
  sm.appendMessage(result(model,[{type:'toolCall',id:'old-read',name:'read',arguments:{path:'fixture.txt'}}],'toolUse'));
  sm.appendMessage({role:'toolResult',toolCallId:'old-read',toolName:'read',content:[{type:'text',text:'Long content '.repeat(500)+'TOOL_OUTPUT_END_MUST_BE_VISIBLE'}],isError:false,timestamp:Date.now()});
  sm.appendMessage(result(model,[{type:'text',text:'Historical read finished.'}]));
  const loader=new sdk.DefaultResourceLoader({cwd:temp,agentDir:temp,settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,
   extensionFactories:[pi=>{
    mod.install(pi,{config:{...mod.readConfig(''),...(['unsupported-level','main-different'].includes(mode)?{thinkingMode:'fixed'}:{}),startTokens:800000},log:e=>logs.push(e),settings:()=>nativeSettings});
    if(mode==='switch-before-start')pi.on('message_end',event=>{
     if(event.message.role==='assistant'&&event.message.stopReason==='toolUse')session.setThinkingLevel('high');
    });
    if(mode==='stale-after-response')pi.on('message_end',event=>{
     if(event.message.role==='assistant'&&event.message.stopReason==='toolUse')clockShiftMs+=90000;
    });
    if(mode==='source-edited')pi.on('message_end',event=>{
      if(event.message.role==='assistant'&&event.message.stopReason==='toolUse'){
        const first=sm.getEntries().find(e=>e.type==='message'&&e.message.role==='user');
        sm.appendContextEdit(first.id,{content:'SOURCE_EDIT_RETAINED'});
      }
    });
   }],systemPromptOverride:()=> 'Offline cached background fixture. No network.'});
  await loader.reload();
  ({session}=await sdk.createAgentSession({cwd:temp,agentDir:temp,modelRuntime:runtime,settingsManager,sessionManager:sm,resourceLoader:loader,model,thinkingLevel:mode==='main-different'?'xhigh':summaryLevel,tools:['fixture_tool'],customTools:[{
   name:'fixture_tool',label:'fixture',description:'offline test',parameters:{type:'object',properties:{}},execute:async()=>{
    toolCalls++;if(mode==='main-switch')session.setThinkingLevel('medium');await sleep(100);
    return {content:[{type:'text',text:'NEW_TOOL_RESULT_RETAINED'}],details:{}};
   }}]}));
  await session.bindExtensions({});
  const initialMain=session.thinkingLevel;
  try{
   await session.prompt('Execute the fixture tool once.');
   if(mode==='unsupported-level'){
    await until(()=>logs.some(e=>e.event==='failed'),'unsupported fixed-level failure');
    assert.equal(summaryCalls,0);assert.equal(sm.getEntries().filter(e=>e.type==='compaction').length,0);
   } else {
    await until(()=>sm.getEntries().some(e=>e.type==='compaction'),'persisted summary');
    assert.equal(sm.getEntries().filter(e=>e.type==='compaction').length,1);
    const text=JSON.stringify(sm.buildSessionContext().messages);
    assert.ok(text.includes('NEW_TOOL_RESULT_RETAINED'));
    const entry=sm.getEntries().find(e=>e.type==='compaction');
    assert.ok(entry.details.asyncPrefixCompaction);
    assert.equal(entry.firstKeptEntryId,logs.find(e=>e.event==='handed_off')?entry.firstKeptEntryId:'missing');
    if(['cached','request-xhigh','request-max','request-low','switch-before-start','long-main','main-switch'].includes(mode)){
     assert.equal(cachedCalls,1,JSON.stringify(logs.filter(e=>e.event.includes('cached'))));assert.equal(summaryCalls,1);
     assert.ok(logs.some(e=>e.event==='cached-summary-result'&&e.cacheHit&&e.thinkingLevel===summaryLevel));
     assert.equal(entry.details.cachedSummary.thinkingLevel,summaryLevel);
     assert.equal(entry.details.summaryThinkingLevel,summaryLevel);
    } else if(mode==='cached-tool-use'||mode==='cached-error'||mode==='request-xhigh-error'){
     assert.equal(cachedCalls,1);assert.ok(summaryCalls>cachedCalls,'invalid cached answer falls back to the same fixed level');
    } else if(mode==='stale-after-response'||mode==='declared-ttl-expired'){
     assert.equal(cachedCalls,0);
     const expected=mode==='stale-after-response'?'capture_too_old':'declared_cache_expired';
     assert.ok(logs.some(e=>e.event==='cached-summary-fallback'&&e.reason===expected),JSON.stringify(logs));
     assert.ok(summaryCalls>0,'protected cases retain native high fallback');
    } else if(mode==='main-different'){
     assert.equal(cachedCalls,0,'reasoning mismatch is rejected before network');
     assert.ok(logs.some(e=>e.event==='cached-summary-fallback'&&e.reason==='prefix_field_changed:reasoning'));
     assert.ok(summaryCalls>0);
    } else if(mode==='no-cache'||mode==='no-payload'||mode==='source-edited'){
     assert.equal(cachedCalls,0);
     if(mode==='source-edited')assert.ok(logs.some(e=>e.event==='cached-summary-fallback'&&e.reason==='source_projection_changed'));
    }
   }
   assert.equal(toolCalls,1,'a summary must never execute a returned tool');
   assert.equal(session.thinkingLevel,mode==='main-switch'?'medium':mode==='switch-before-start'?'high':initialMain);
   assert.ok(!JSON.stringify(logs).includes('TOOL_OUTPUT_END_MUST_BE_VISIBLE'),'logs must not persist captured prompts/results');
   console.log(`PASS SDK ${mode}: summaries=${summaryCalls} cached=${cachedCalls} executedTools=${toolCalls} main=${session.thinkingLevel}`);
  }finally{session.dispose();}
 }
 console.log('PASS real SDK request-locked high/xhigh/max/low, same-level native fallback, full tool output, abort-safe side channel, main level retained; network=0. Fixtures '+temp);
}finally{globalThis.fetch=originalFetch;Date.now=originalNow;if(originalRetention===undefined)delete process.env.PI_CACHE_RETENTION;else process.env.PI_CACHE_RETENTION=originalRetention;}
