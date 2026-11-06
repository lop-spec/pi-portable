import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {integrate} from '../tools/patch-piweb-source.mjs';
import {savedSessionSettings} from '../assets/piweb-overlay/portable-session-settings.mjs';
const source = process.env.PIWEB_SOURCE || fileURLToPath(new URL('../upstream/',import.meta.url));
const require = createRequire(path.join(source,'package.json'));
const ts = require('typescript');
const sdk = await import(pathToFileURL(process.env.PI_SESSION_SDK || path.join(source,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const original = fs.readFileSync(path.join(source,'lib/rpc-manager.ts'),'utf8');
const originalRoute = fs.readFileSync(path.join(source,'app/api/agent/[id]/route.ts'),'utf8');
const integrated = integrate(n=>fs.readFileSync(path.join(source,n),'utf8'));
const patched = integrated.get('lib/rpc-manager.ts');
const ai = await import(pathToFileURL(path.join(source,'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
function startup(text) {
  const from=text.indexOf('    const defaultProvider = services.settingsManager.getDefaultProvider();');
  const to=text.indexOf('    // If specific tool names were requested',from);
  assert.ok(from>0 && to>from);
  return ts.transpileModule('async function run(){'+text.slice(from,to)+'return inner;} run();',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
}
test('real model RPC selects supported highest effort for free and every web channel without changing other sessions or manual choices',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-free-max-rpc-'));
 const cwd=path.join(temp,'work');fs.mkdirSync(cwd);
 const full={off:'off',minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'};
 const capped={off:null,minimal:null,low:'low',medium:'medium',high:'high',xhigh:null,max:null};
 const make=(id,map)=>({id,name:id,reasoning:true,input:['text'],contextWindow:8192,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},thinkingLevelMap:map});
 const config=models=>({baseUrl:'http://127.0.0.1:1',api:'openai-completions',apiKey:'nonsecret-test-fixture',models});
 const webCases=[['pi-chatgpt-web','max',full],['pi-gemini-web','high',capped],['pi-zai-web','max',full],['pi-kimi-web','xhigh',{...full,max:null}],['pi-mimo-web','high',capped],['pi-qwen-web','high',capped],['pi-deepseek-web','max',full],['pi-stepfun-web','max',full],['pi-feishu-web','high',capped],['future-provider-web','max',full]];
 fs.writeFileSync(path.join(temp,'models.json'),JSON.stringify({providers:{fixture:config([make('astra',full)]),'pi-free':config([make('auto',full),make('capped',capped)]),...Object.fromEntries(webCases.map(([p,_level,map])=>[p,config([make('web-fixture',map)])]))}}));
 const defaults={defaultProvider:'fixture',defaultModel:'astra',defaultThinkingLevel:'medium'};
 fs.writeFileSync(path.join(temp,'settings.json'),JSON.stringify(defaults));fs.writeFileSync(path.join(temp,'auth.json'),'{}');
 const sessions=[];
 try {
  const services=await sdk.createAgentSessionServices({cwd,agentDir:temp,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}});
  async function create(level){const sm=sdk.SessionManager.inMemory(cwd);const {session}=await sdk.createAgentSessionFromServices({services,sessionManager:sm,model:services.modelRuntime.getModel('fixture','astra'),thinkingLevel:level,tools:[]});sessions.push(session);sm.appendMessage({role:'user',content:'isolated settings fixture',timestamp:Date.now()});return session;}
  const inner=await create('medium'),other=await create('low');
  const from=patched.indexOf('      case "set_model": {');const to=patched.indexOf('\n      case ',from+1);
  const code=ts.transpileModule('async function run(command){switch(command.type){'+patched.slice(from,to)+'}} run.call({inner}, command);',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const switchTo=(provider,modelId)=>vm.runInNewContext(code,{inner,command:{type:'set_model',provider,modelId},getSupportedThinkingLevels:ai.getSupportedThinkingLevels,invalidateModelsCache(){},invalidateSessionListCache(){},console});
  await switchTo('pi-free','auto');assert.equal(inner.thinkingLevel,'max');assert.equal(other.thinkingLevel,'low');
  inner.setThinkingLevel('low');assert.equal(inner.thinkingLevel,'low','manual effort choice after switching remains allowed');
  const {session:reopened}=await sdk.createAgentSessionFromServices({services,sessionManager:inner.sessionManager,tools:[]});sessions.push(reopened);assert.equal(reopened.thinkingLevel,'low','ordinary restore never forces a new maximum');
  await switchTo('pi-free','capped');assert.equal(inner.thinkingLevel,'high','highest level comes from model capability, not a hardcoded max');
  await switchTo('fixture','astra');assert.equal(inner.thinkingLevel,'high','ordinary model keeps this conversation effort');
  for(const [provider,highest] of webCases){
    inner.setThinkingLevel('low');
    await switchTo(provider,'web-fixture');assert.equal(inner.thinkingLevel,highest,provider+' selects its capability maximum');
    inner.setThinkingLevel('low');
    const {session:restored}=await sdk.createAgentSessionFromServices({services,sessionManager:inner.sessionManager,tools:[]});sessions.push(restored);
    assert.equal(restored.thinkingLevel,'low',provider+' ordinary restore preserves a later manual choice');
    assert.equal(other.model.id,'astra');assert.equal(other.thinkingLevel,'low');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp,'settings.json'),'utf8')),defaults);
  const hook=integrated.get('hooks/useAgentSession.ts');assert.match(hook,/if \(provider === "pi-free" \|\| provider.endsWith\("-web"\)\)[\s\S]*?type: "get_state"[\s\S]*?setNewSessionThinkingLevel\(resolved\)/);
 } finally {for(const session of sessions)await session.dispose();fs.rmSync(temp,{recursive:true,force:true});}
});
test('actual cold-session API route admits explicit replacement before restoring a retired model',async()=>{
 async function invoke(route,body) {
  const calls=[];
  const exports={};
  const runtime={getRpcSession:()=>null,setRpcSessionTools:()=>{throw Error('unexpected tools change');},startRpcSession:async(id,file,cwd,options)=>{
   calls.push({id,options});
   if(!options.replacementModel)throw Error('Saved session model is unavailable: pi-free/kimi-k3.1-pro');
   return {session:{send:async(command)=>{calls.push({command});return {id:command.modelId,provider:command.provider};}}};
  }};
  const require=name=>name==='next/server'?{NextResponse:{json:(data,opts)=>({data,status:opts?.status??200})}}:name==='@/lib/session-reader'?{resolveSessionPath:async()=>'/fake/session.jsonl'}:name==='@/lib/rpc-manager'?runtime:(()=>{throw Error(name);})();
  vm.runInNewContext(ts.transpileModule(route,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require});
  const response=await exports.POST({json:async()=>body},{params:Promise.resolve({id:'fixture-old-session'})});
  return {response,calls};
 }
 const command={type:'set_model',provider:'fixture',modelId:'sol'};
 const before=await invoke(originalRoute,command);assert.equal(before.response.status,500);assert.match(before.response.data.error,/kimi-k3.1-pro/);
 const after=await invoke(integrated.get('app/api/agent/[id]/route.ts'),command);
 assert.equal(after.response.status,200);assert.equal(after.calls[0].options.replacementModel.modelId,'sol');assert.equal(after.calls.length,2);assert.equal(after.calls[1].command,command);
 const prompt=await invoke(integrated.get('app/api/agent/[id]/route.ts'),{type:'prompt',message:'not sent'});assert.equal(prompt.response.status,500);assert.equal(prompt.calls[0].options.replacementModel,undefined);
 const invalid=await invoke(integrated.get('app/api/agent/[id]/route.ts'),{type:'set_model',provider:'fixture'});assert.equal(invalid.response.status,500);assert.equal(invalid.calls.length,0);assert.match(invalid.response.data.error,/Invalid model selection/);
});
test('real SDK reproduces and fixes cold empty-session reset, with independent new defaults',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-session-settings-'));
 const cwd=path.join(temp,'work');fs.mkdirSync(cwd);
 const base={reasoning:true,input:['text'],contextWindow:8192,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},thinkingLevelMap:{off:'off',minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}};
 fs.writeFileSync(path.join(temp,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:'http://127.0.0.1:1',api:'openai-completions',apiKey:'nonsecret-test-fixture',models:['astra','sol','luna'].map(id=>({id,name:id,...base}))}}}));
 const defaults={defaultProvider:'fixture',defaultModel:'luna',defaultThinkingLevel:'high'};
 fs.writeFileSync(path.join(temp,'settings.json'),JSON.stringify(defaults));fs.writeFileSync(path.join(temp,'auth.json'),'{}');
 const settingsFile=path.join(temp,'settings.json');
 try {
  const services=await sdk.createAgentSessionServices({cwd,agentDir:temp,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}});
  const visible=await services.modelRuntime.getAvailable();assert.equal(visible.filter(m=>m.provider==='fixture').length,3);
  const scope={visible:visible.filter(m=>m.provider==='fixture'),scopedModels:[]};
  async function run(text,model,level,sessionFile='saved-session',replacementModel) {
   const sessionManager=sdk.SessionManager.inMemory(cwd);
   if(model){sessionManager.appendModelChange('fixture',model);sessionManager.appendThinkingLevelChange(level);}
   const context={services,sessionManager,scope,sessionFile,replacementModel,initialModel:undefined,effectiveInitialModel:undefined,thinkingLevel:undefined,toolsOption:[],subagentResources:null,savedSessionSettings,
    createAgentSessionFromServices:sdk.createAgentSessionFromServices,
    getLatestModelChange:entries=>savedSessionSettings(entries).model,
    selectInitialModelScope:(_scope,opts)=>({model:services.modelRuntime.getModel(opts.defaultModel.provider,opts.defaultModel.modelId),thinkingLevel:opts.thinkingLevel}),
    persistExplicitStartupPreferences:async(_s,requested)=>{assert.deepEqual(Object.keys(requested),[]);return {modelDefaultChanged:false};},invalidateModelsCache(){}};
   const inner=await vm.runInNewContext(startup(text),context);
   const result={model:inner.model.id,thinking:inner.thinkingLevel};await inner.dispose();return result;
  }
  assert.deepEqual(await run(original,'astra','medium'),{model:'luna',thinking:'high'},'original resets an already-created empty session to new defaults');
  assert.deepEqual(await run(patched,'astra','medium'),{model:'astra',thinking:'medium'});
  assert.deepEqual(await run(patched,'sol','low'),{model:'sol',thinking:'low'});
  assert.deepEqual(await run(patched,null,null,''),{model:'luna',thinking:'high'},'only new conversations adopt defaults');
  await assert.rejects(run(patched,'retired-kimi','medium'),/Saved session model is unavailable/,'ordinary resume never silently changes the saved model');
  assert.deepEqual(await run(patched,'retired-kimi','medium','saved-session',{provider:'fixture',modelId:'sol'}),{model:'sol',thinking:'medium'},'an explicit replacement bypasses the unavailable saved model and keeps the saved strength');
  assert.deepEqual(await run(patched,'astra','low','saved-session',{provider:'fixture',modelId:'sol'}),{model:'sol',thinking:'low'},'a cold explicit switch also wins over an available old model');
  await assert.rejects(run(patched,'retired-kimi','medium','saved-session',{provider:'fixture',modelId:'also-missing'}),/Model not found: fixture\/also-missing/,'an invalid replacement never falls back to defaults');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile,'utf8')),defaults);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
