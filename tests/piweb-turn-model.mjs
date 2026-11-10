import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolveTimelineModel} from '../assets/piweb-overlay/turn-model-label.mjs';
import {projectCraftTurn} from '../assets/piweb-overlay/craft-transcript/model.mjs';
import {timelineBreakdown} from '../assets/piweb-overlay/merge/lib/portable-timeline-summary.mjs';
const a={kind:'assistant',key:'a',message:{role:'assistant',provider:'actual',model:'model-a',timestamp:1000,content:[{type:'toolCall',toolCallId:'tool',toolName:'read',input:{path:'index.ts',_displayName:'读取文件',_intent:'核对实现'}}]}};
const b={...a.message,model:'model-b',content:[]};
const props={entries:[a],toolResults:new Map(),live:true,activeModel:{provider:'confirmed',modelId:'runtime'},modelNames:{'actual:model-a':'Model A','actual:model-b':'Model B'}};
test('confirmed runtime model is visible before the first assistant token',()=>{
 assert.deepEqual(resolveTimelineModel({...props,entries:[]}),{key:'confirmed/runtime',name:'runtime'});
});
test('actual reply wins over confirmed or pending selection, including tool phases',()=>{
 assert.equal(resolveTimelineModel(props).name,'Model A');
 assert.equal(resolveTimelineModel({...props,streamingMessage:b}).name,'Model B');
 assert.equal(resolveTimelineModel({...props,entries:[a,{kind:'node',key:'n'}]}).name,'Model A');
});
test('each historical turn keeps its own model; unknown is never guessed',()=>{
 assert.equal(resolveTimelineModel({...props,live:false,streamingMessage:b}).name,'Model A');
 assert.equal(resolveTimelineModel({...props,live:false,entries:[]}),null);
 assert.equal(resolveTimelineModel({entries:[],live:true}),null);
 assert.equal(resolveTimelineModel({...props,modelNames:{}}).name,'model-a');
 assert.equal(resolveTimelineModel({...props,entries:[a,{...a,key:'b',message:b}]}).name,'Model B');
});
const source=process.env.PIWEB_SOURCE??fileURLToPath(new URL('../upstream',import.meta.url));
const available=fs.existsSync(path.join(source,'node_modules/typescript'))&&fs.existsSync(path.join(source,'lib/turn-model-label.mjs'));
test('integrated Craft component renders model above steps, with exact ID tooltip and no new fetch',{skip:!available},()=>{
 const req=createRequire(path.join(source,'package.json')),ts=req('typescript'),React=req('react'),{renderToStaticMarkup}=req('react-dom/server');
 const code=fs.readFileSync(path.join(source,'components/PortableProcessTimeline.tsx'),'utf8');
 const module={exports:{}};
 const localRequire=id=>id==='@/lib/clipboard'?{copyText:async()=>{throw new Error('Static rendering must not copy');}}:id==='@/lib/turn-model-label.mjs'?{resolveTimelineModel}:id==='@/lib/craft-transcript-model.mjs'?{projectCraftTurn}:id==='@/lib/portable-timeline-summary.mjs'?{timelineBreakdown}:id==='./MessageView'?{PortableTextBlock:()=>null}:id==='./conversation/ErrorNotice'?{InlineFailure:()=>null}:id==='./ImagePreview'?{ImagePreview:({children})=>children}:req(id);
 const compiled=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 vm.runInNewContext('(function(require,module,exports){'+compiled+'\n})',{console},{filename:'PortableProcessTimeline.tsx'})(localRequire,module,module.exports);
 const render=p=>renderToStaticMarkup(React.createElement(module.exports.PortableProcessTimeline,p));
 const live=render({...props,streamingMessage:b});
 assert.match(live,/class="craft-model-label" title="actual\/model-b" data-model="actual\/model-b" aria-live="polite">Model B<\/div>/);
 assert.ok(live.indexOf('craft-model-label')<live.indexOf('class="craft-work-log'));
 const historical=render({...props,live:false});assert.match(historical,/data-model="actual\/model-a">Model A/);
 assert.doesNotMatch(historical,/class="craft-model-label"[^>]*aria-live/);
 const pre=render({...props,entries:[]});assert.match(pre,/data-model="confirmed\/runtime"/);
 const chat=fs.readFileSync(path.join(source,'components/ChatWindow.tsx'),'utf8'),hook=fs.readFileSync(path.join(source,'hooks/useAgentSession.ts'),'utf8');
 assert.match(chat,/activeModel=\{turn.live \? runtimeModel : undefined\}/);
 assert.match(hook,/const runtimeModel = liveModel \?\? data\?\.context\.model \?\? null/);
 if(process.env.PIWEB_MODEL_FIXTURE){
   const css=fs.readFileSync(path.join(source,'app/craft-transcript.css'),'utf8');
   const html='<!doctype html><html data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模型标签验收</title><style>body{margin:0;font:14px system-ui;background:#fff;color:#222;--text:#222;--text-muted:#606060;--border:#ddd}main{padding:24px;max-width:960px;box-sizing:border-box}h2{font:500 14px system-ui;margin:24px 0 12px}'+css+'</style><main><h2>正在处理</h2>'+live+'<h2>历史步骤</h2>'+historical+'<h2>首包前</h2>'+pre+'<h2>长模型名</h2>'+render({...props,entries:[],activeModel:{provider:'long',modelId:'a-very-long-specific-model-'.repeat(12)}})+'</main></html>';
   fs.writeFileSync(process.env.PIWEB_MODEL_FIXTURE,html);
 }
});
