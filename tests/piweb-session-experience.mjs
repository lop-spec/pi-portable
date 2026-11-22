import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { referencedPaths,collectSessionCandidates,extensionOf } from '../assets/piweb-overlay/session-experience/session-artifacts.mjs';
import { readSessionDefaults,writeSessionDefaults,planSessionDefaults } from '../assets/piweb-overlay/session-experience/defaults-store.mjs';
import { artifactsPopoverPlacement } from '../assets/piweb-overlay/session-experience/popover-placement.mjs';

test('artifact panel stays inside desktop and phone viewports',()=>{
 for (const width of [1024,390]) for(const right of [44,width-8]) {
  const box=artifactsPopoverPlacement({right,bottom:42},width,768);
  assert.ok(box.left>=0&&box.left+box.width<=width);
 }
});

test('session artifact candidates use only this branch, successful writes and final answer links',()=>{
 const entries=[
  {type:'message',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'ok',name:'editor',arguments:{path:'C:/work/报告.MD'}},{type:'toolCall',id:'bad',name:'editor',arguments:{path:'C:/work/失败.md'}}]}},
  {type:'message',message:{role:'toolResult',toolCallId:'ok',isError:false}},
  {type:'message',message:{role:'toolResult',toolCallId:'bad',isError:true}},
  {type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'完成 `C:/work/报告.MD` 和 [回执](C:/work/回执%20一.md)，详见 https://example.com/foo.md'}]}},
 ];
 const out=collectSessionCandidates(entries,{writtenPaths:(calls,results)=>calls.filter(c=>!results.get(c.toolCallId)?.isError).map(c=>({filePath:c.input.path}))});
 assert.deepEqual(out,[{filePath:'C:/work/回执 一.md',source:'referenced'},{filePath:'C:/work/报告.MD',source:'written'}]);
 assert.deepEqual(referencedPaths('网页 https://example.com/readme.md'),[]);
 assert.deepEqual(referencedPaths('查看 [报告](./报告.md) 和 `notes.txt`'),['./报告.md','notes.txt']);
 const imageEntries=[{type:'message',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'img',name:'codex_imagegen',arguments:{output_path:'C:/work/a.png'}}]}},{type:'message',message:{role:'toolResult',toolCallId:'img',isError:false,content:[]}}];
 assert.deepEqual(collectSessionCandidates(imageEntries,{writtenPaths:()=>[]}),[{filePath:'C:/work/a.png',source:'written'}]);
 assert.equal(extensionOf(out[1].filePath),'md'); assert.equal(extensionOf('C:/x/a.tar.gz'),'gz');assert.equal(extensionOf('C:/x/no-extension'),'');
});
test('global settings persist atomically, apply to existing on next prompt, respect later per-session overrides',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-default-test-'));
 try {
  assert.equal(readSessionDefaults(dir),null);
  const setting=writeSessionDefaults(dir,{provider:'p',modelId:'m',thinkingLevel:'high',applyExisting:true});
  assert.deepEqual(readSessionDefaults(dir),setting);
  const earlier=new Date(setting.updatedAt-1000).toISOString(),later=new Date(setting.updatedAt+1000).toISOString();
  assert.deepEqual(planSessionDefaults([{type:'model_change',timestamp:earlier}],setting),{model:{provider:'p',modelId:'m'},thinking:'high'});
  assert.deepEqual(planSessionDefaults([{type:'model_change',timestamp:later}],setting),{});
  assert.deepEqual(planSessionDefaults([{type:'model_change',timestamp:earlier},{type:'thinking_level_change',timestamp:later,thinkingLevel:'low'}],setting),{model:{provider:'p',modelId:'m'},thinking:'low'});
  assert.deepEqual(planSessionDefaults([],{...setting,applyExisting:false}),{});
  fs.writeFileSync(path.join(dir,'web-session-defaults.json'),'{}');assert.equal(readSessionDefaults(dir),null);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

const repo=fileURLToPath(new URL('../',import.meta.url));
const source=process.env.PIWEB_SOURCE ?? path.join(repo,'upstream');
const ready=fs.existsSync(path.join(source,'node_modules/typescript'))&&fs.existsSync(path.join(source,'components/ChatInput.tsx'));
test('real route applies defaults only before an idle prompt and respects a later local choice',{skip:!ready},async()=>{
 const statePath=path.join(source,'.pi-portable-overlay.json');
 const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
 const read=name=>{const item=state?.files[name];if(item&&!item.backup)throw Error('not upstream: '+name);return fs.readFileSync(item?.backup??path.join(source,name),'utf8');};
 const code=integrate(read).get('app/api/agent/[id]/route.ts'), ts=createRequire(path.join(source,'package.json'))('typescript');
 const compiled=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const setting={provider:'fixture',modelId:'astra',thinkingLevel:'high',applyExisting:true,updatedAt:2000};
 async function run({busy=false,manual=false,cold=false,enabled=true}={}) {
  const events=[], entries=manual?[{type:'model_change',timestamp:new Date(3000).toISOString()}]:[{type:'model_change',timestamp:new Date(1000).toISOString()}];
  const session={isAlive:()=>true,isRunning:()=>busy,inner:{sessionManager:{getBranch:()=>entries}},send:async command=>{events.push(command);return null;}};
  const rpc={getRpcSession:()=>cold?null:session,startRpcSession:async(_id,_file,_cwd,opts)=>{events.push({type:'startup',options:opts});return {session};},setRpcSessionTools:()=>{throw Error('unexpected');}};
  const require=id=>id==='next/server'?{NextResponse:{json:(data,opts)=>({data,status:opts?.status??200})}}:id==='@earendil-works/pi-coding-agent'?{getAgentDir:()=>'/agent'}:id==='@/lib/session-defaults-store.mjs'?{readSessionDefaults:()=>enabled?setting:null,planSessionDefaults}:id==='@/lib/session-reader'?{resolveSessionPath:async()=>'/session.jsonl',openSessionManager:()=>({getBranch:()=>entries})}:id==='@/lib/rpc-manager'?rpc:(()=>{throw Error(id);})();
  const exports={};vm.runInNewContext(compiled,{exports,require});
  const response=await exports.POST({json:async()=>({type:'prompt',message:'fixture'})},{params:Promise.resolve({id:'test'})});
  assert.equal(response.status,200);return events;
 }
 assert.deepEqual((await run()).map(x=>x.type),['set_model','set_thinking_level','prompt']);
 assert.deepEqual((await run({busy:true})).map(x=>x.type),['prompt']);
 assert.deepEqual((await run({manual:true})).map(x=>x.type),['prompt']);
 assert.deepEqual((await run({enabled:false})).map(x=>x.type),['prompt']);
 const cold=await run({cold:true});assert.deepEqual(cold.map(x=>x.type),['startup','set_thinking_level','prompt']);
 assert.equal(cold[0].options.replacementModel.modelId,'astra');
});
