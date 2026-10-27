import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const root=fileURLToPath(new URL('../',import.meta.url));
const asset=path.join(root,'assets/piweb-overlay/desktop-transcript');
const source=process.env.PIWEB_SOURCE??path.join(root,'upstream');
const available=fs.existsSync(path.join(source,'node_modules/typescript'));
const manifest=JSON.parse(fs.readFileSync(asset+'/vendor/provenance.json','utf8'));
test('vendored components are pinned official source with intact licenses and reproducible hashes',()=>{
 assert.equal(manifest.repository,'https://github.com/vastsa/PI-Desktop');assert.equal(manifest.version,'0.21.0');
 for(const record of manifest.files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(asset+'/vendor/'+record.name)).digest('hex'),record.sha256,record.name);
 assert.match(fs.readFileSync(asset+'/vendor/COPYING.LESSER','utf8'),/GNU LESSER GENERAL PUBLIC LICENSE/);
 assert.match(fs.readFileSync(asset+'/vendor/COPYING','utf8'),/GNU GENERAL PUBLIC LICENSE/);
});
test('Desktop source controls nested automatic/manual/reveal choices and browser first-click protection',()=>{
 const disclosure=fs.readFileSync(asset+'/vendor/disclosure.tsx','utf8');
 for(const expression of [/requestedOpen && scope.visible/,/choices.set\(key, \{ open: true, revealRequest \}\)/,/currentOpen.current && ownsReadingPosition/,/if \(!choice && previousDerived.current && !derivedOpen && ownsReading\(\)\)/])assert.match(disclosure,expression);
 assert.doesNotMatch(disclosure,/localStorage|fetch\(/);
});
test('original geometry, type ramp, animation and reduced-motion sheets stay scoped',()=>{
 const css=fs.readFileSync(asset+'/desktop-transcript.css','utf8');
 for(const expression of [/\.pd-transcript \.turn-process > \.tool-activity-header/,/--text-sm-plus: calc\(12.5px/,/padding-inline-start: 12px/,/text-shimmer-sweep 1.2s/,/prefers-reduced-motion: reduce/])assert.match(css,expression);
 assert.doesNotMatch(css,/@theme\s*\{/);
});
let React,renderToStaticMarkup,load,host;
if(available){
 const req=createRequire(path.join(source,'package.json'));const ts=req('typescript');React=req('react');({renderToStaticMarkup}=req('react-dom/server'));
 host={TranscriptSearchContext:React.createContext(null),HostContext:React.createContext({}),MessageContext:React.createContext(null),useTranslation:()=>({t:(key,p={})=>key.replace(/\{\{(\w+)\}\}/g,(_,k)=>String(p[k]??''))}),useAppStore:selector=>selector({settings:{showThinking:true}}),resolveShowThinking:s=>s.showThinking,thinkingText:m=>m.thinking??'',Markdown:({source})=>React.createElement('p',null,source),TooltipButton:({ariaLabel,tooltip,...p})=>React.createElement('button',{'aria-label':ariaLabel,title:tooltip,...p}),useCopy:()=>({copy(){},copied:false}),useOpenPreviewTarget:()=>()=>{},cx:(...v)=>v.filter(Boolean).join(' ')};
 const cache=new Map();
 const icons=new Proxy({},{get:()=>()=>null});
 load=(file)=>{
  file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=id=>{
   if(id==='./host'||id.endsWith('/host'))return host;if(id==='./icons'||id.endsWith('/icons'))return icons;
   if(id.endsWith('MessageView'))return {PortableTextBlock:()=>null};
   if(id.endsWith('ErrorNotice'))return {InlineFailure:()=>null};
   if(id.endsWith('ImagePreview'))return {ImagePreview:({children})=>children};
   if(id==='./ToolDetails')return {ToolChips:()=>null,ToolDetailBlocks:({blocks})=>React.createElement('pre',null,blocks.map(b=>b.text??'').join('\n'))};
   if(id.startsWith('.')){let local=path.resolve(path.dirname(file),id);if(file.endsWith('PortableProcessTimeline.tsx')&&id.startsWith('./desktop-transcript/'))local=asset+'/vendor/'+id.split('/').at(-1);if(!fs.existsSync(local)){for(const ext of ['.ts','.tsx'])if(fs.existsSync(local+ext)){local+=ext;break;}}return load(local);}
   return req(id);
  };
  vm.runInNewContext('(function(require,module,exports){'+compiled+'\n})',{console,setInterval,clearInterval},{filename:file})(localRequire,module,module.exports);
  return module.exports;
 };
}
const fixture=()=>{
 const raw={role:'assistant',timestamp:1000,content:[{type:'thinking',thinking:'**English planning**\n\n完整中文和 English reasoning stay intact.'},{type:'toolCall',toolCallId:'call',toolName:'bash',input:{command:'node check.mjs'}}]};
 const result={role:'toolResult',toolCallId:'call',timestamp:6000,content:[{type:'text',text:'工具原文只在用户展开后显示'}],details:{exitCode:0,stdout:'工具原文只在用户展开后显示'}};
 return {entries:[{kind:'assistant',key:'message',entryId:'message',message:raw}],toolResults:new Map([['call',result]])};
};
test('adapter keeps order, all reasoning languages and payloads, without mutating stored content',{skip:!available},()=>{
 const {buildDesktopParts}=load(asset+'/PortableProcessTimeline.tsx');const input=fixture(),snapshot=JSON.stringify(input.entries);
 const model=buildDesktopParts(input.entries,input.toolResults,false);const items=model.parts[0].items;
 assert.deepEqual(Array.from(items,i=>i.kind),['thinking','tool']);assert.match(items[0].message.thinking,/English planning/);
 assert.equal(items[1].message.toolName,'bash');assert.equal(items[1].message.toolStatus,'success');
 assert.equal(JSON.stringify(input.entries),snapshot);assert.equal(model.parts.length,1);
});
test('completed process is collapsed; active process/visible reasoning open, tool payloads closed',{skip:!available},()=>{
 const {PortableProcessTimeline}=load(asset+'/PortableProcessTimeline.tsx');
 const html=renderToStaticMarkup(React.createElement(PortableProcessTimeline,{...fixture(),sessionId:'completed',collapseKey:'turn',live:false,end:{status:'done',at:7000}}));
 assert.match(html,/class="turn-process"/);assert.match(html,/class="turn-process-body" hidden=""/);
 const active=renderToStaticMarkup(React.createElement(PortableProcessTimeline,{...fixture(),sessionId:'active',collapseKey:'turn',live:true}));
 assert.match(active,/class="turn-process open active"/);assert.match(active,/English planning/);assert.match(active,/完整中文/);
 assert.doesNotMatch(active,/工具原文只在用户展开后显示|data-tool-chinese-excerpt|展开摘录/);
 assert.match(active,/class="tool-row-header" aria-expanded="false"/);
});
test('manual tool expansion uses original plain command output; shell exit failure is never success',{skip:!available},()=>{
 const {PortableProcessTimeline}=load(asset+'/PortableProcessTimeline.tsx');
 const {sessionReadingState}=load(asset+'/vendor/reading-state.ts');const {disclosureKey}=load(asset+'/vendor/disclosure.tsx');
 sessionReadingState('manual').disclosures.set(disclosureKey('tool','call'),{open:true});
 const html=renderToStaticMarkup(React.createElement(PortableProcessTimeline,{...fixture(),sessionId:'manual',collapseKey:'turn',live:true}));
 assert.match(html,/工具原文只在用户展开后显示/);
 const {adaptTool}=load(asset+'/vendor/model.ts');const {runOutcome}=load(asset+'/vendor/tool-presentation.ts');
 const f=fixture();f.toolResults.get('call').details.exitCode=2;
 assert.equal(runOutcome(adaptTool(f.entries[0].message.content[1],f.toolResults.get('call'),1000,false)),'failed');
});
test('Pi Read truncation metadata never displaces the original file text',{skip:!available},()=>{
 const {adaptTool}=load(asset+'/vendor/model.ts');const {buildToolPresentation}=load(asset+'/vendor/tool-presentation.ts');
 const message=adaptTool({type:'toolCall',toolCallId:'r',toolName:'read',input:{path:'index.ts'}},{role:'toolResult',content:[{type:'text',text:'原始文件内容\n[Showing 2000 lines]'}],details:{truncation:{truncated:true,outputLines:2000}}},1000,false);
 const blocks=buildToolPresentation(message,{hideSummaryArg:true});assert.equal(blocks[0].role,'content');assert.equal(blocks[0].text,'原始文件内容\n[Showing 2000 lines]');
});
test('recovered/stopped/failed timing uses original recorded-state precedence',{skip:!available},()=>{
 const {turnProcessPhase,turnProcessTiming}=load(asset+'/vendor/turn-process.ts');
 const parts=[{kind:'message',message:{id:'x',content:'',role:'assistant',status:'aborted',createdAt:'2026-10-27T01:00:00Z'}}];
 assert.equal(turnProcessPhase({parts,isActive:true,failed:false}).kind,'stopped');
 assert.equal(turnProcessPhase({parts,isActive:true,failed:true}).kind,'failed');
 assert.equal(turnProcessTiming([]).startedAt,undefined);
});
