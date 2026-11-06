import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolveTimelineModel} from '../assets/piweb-overlay/turn-model-label.mjs';
const root=process.env.PIWEB_SOURCE??fileURLToPath(new URL('../upstream',import.meta.url));
const available=fs.existsSync(path.join(root,'lib/turn-model-label.mjs'));
const requested={role:'assistant',model:'chatgpt-web-astra',provider:'pi-chatgpt-web',content:[]};
const runtime=(modelId,reasoning)=>({provider:'pi-chatgpt-web',modelId,reasoning});
const sol=reasoning=>({...requested,runtimeModel:runtime('chatgpt-web-instant',reasoning)});
const props={entries:[],live:true};
test('verified Sol max and xhigh replace the requested Astra label; recovery replaces it again',()=>{
 for(const [message,expected] of [[sol('max'),'GPT-5.6 Sol · 网页 · max'],[sol('xhigh'),'GPT-5.6 Sol · 网页 · xhigh'],[{...requested,runtimeModel:runtime('chatgpt-web-astra','max')},'GPT-6 Astra · 网页 · max']]){
  const out=resolveTimelineModel({...props,streamingMessage:message});assert.equal(out.name,expected);assert.equal(out.reasoning,message.runtimeModel.reasoning);
 }
});
test('history retains per-turn verified identity; another model or new turn cannot rewrite it',()=>{
 const entries=[{kind:'assistant',message:sol('xhigh')}];
 assert.equal(resolveTimelineModel({entries,live:false,streamingMessage:sol('max'),activeModel:{provider:'other',modelId:'selected'}}).name,'GPT-5.6 Sol · 网页 · xhigh');
 assert.equal(resolveTimelineModel({entries,live:true,streamingMessage:{...requested,provider:'pi-zai-web',model:'glm-5.3'},modelNames:{'pi-zai-web:glm-5.3':'GLM 5.3'}}).name,'GLM 5.3');
 assert.equal(resolveTimelineModel({entries:[],live:false}),null);
});
test('integrated DTO, wire delta and reducer keep identity without copying message bodies',{skip:!available},()=>{
 const req=createRequire(path.join(root,'package.json')),ts=req('typescript');
 const load=(file,imports={})=>{const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,module={exports:{}};vm.runInNewContext('(function(require,module,exports){'+code+'})',{},{filename:file})(id=>imports[id]??req(id),module,module.exports);return module.exports;};
 const {uiMessage}=load('lib/ui-message.mjs');
 const dto=uiMessage({...sol('xhigh'),content:[{type:'text',text:'正文'}],opaqueSecret:'must not leak'});
 assert.equal(dto.runtimeModel.reasoning,'xhigh');assert.equal(dto.opaqueSecret,undefined);
 const {toClientAgentEvent}=load('lib/agent-event-wire.ts',{'./ui-message.mjs':{uiMessage}});
 const {streamReducer}=load('lib/streaming-message.ts',{'./normalize':{normalizeStreamingToolCalls:m=>m}});
 let state=streamReducer({isStreaming:false,streamingMessage:null},{type:'snapshot',message:{...requested,content:[{type:'text',text:''}]}});
 for(const reasoning of ['max','xhigh']){
  const message={...sol(reasoning),content:[{type:'text',text:'large content must not be serialized'}]};
  const frame=toClientAgentEvent({type:'message_update',message,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'',partial:message}});
  assert.equal(frame.message,undefined);assert.equal(frame.assistantMessageEvent.partial,undefined);assert.doesNotMatch(JSON.stringify(frame),/large content/);
  state=streamReducer(state,{type:'delta',event:frame.assistantMessageEvent});
  assert.equal(state.streamingMessage.runtimeModel.reasoning,reasoning);assert.equal(state.streamingMessage.content[0].text,'');
  assert.equal(resolveTimelineModel({...props,streamingMessage:state.streamingMessage}).reasoning,reasoning);
 }
});
