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
const patched = integrate(n=>fs.readFileSync(path.join(source,n),'utf8')).get('lib/rpc-manager.ts');
function startup(text) {
  const from=text.indexOf('    const defaultProvider = services.settingsManager.getDefaultProvider();');
  const to=text.indexOf('    // If specific tool names were requested',from);
  assert.ok(from>0 && to>from);
  return ts.transpileModule('async function run(){'+text.slice(from,to)+'return inner;} run();',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
}
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
  async function run(text,model,level,sessionFile='saved-session') {
   const sessionManager=sdk.SessionManager.inMemory(cwd);
   if(model){sessionManager.appendModelChange('fixture',model);sessionManager.appendThinkingLevelChange(level);}
   const context={services,sessionManager,scope,sessionFile,initialModel:undefined,effectiveInitialModel:undefined,thinkingLevel:undefined,toolsOption:[],subagentResources:null,savedSessionSettings,
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
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile,'utf8')),defaults);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
