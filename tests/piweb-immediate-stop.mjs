import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';
import {shouldStopOnGlobalEscape} from '../assets/piweb-overlay/immediate-stop/stop-guard.ts';
import {integrate} from '../tools/patch-piweb-source.mjs';
const root=process.env.PIWEB_SOURCE||path.resolve('upstream');
const statePath=path.join(root,'.pi-portable-overlay.json');const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
const files=integrate(name=>{const record=state?.files[name];if(record&&!record.backup)throw Error('Generated file');return fs.readFileSync(record?.backup||path.join(root,name),'utf8');});
const hook=files.get('hooks/useAgentSession.ts');
test('Stop releases React state synchronously while abort HTTP stays pending',async()=>{
 const steps=[],ref=current=>({current}),sid='fixture';let callback;
 const scope={crypto:{randomUUID:()=> 'stop-token'},useCallback:fn=>{callback=fn;},sessionIdRef:ref(sid),stopBarriersRef:ref(new Map()),stopTicketsRef:ref(new Map()),stoppedSessionsRef:ref(new Set()),bashRunningRef:ref(false),agentRunningRef:ref(true),promptRunIdRef:ref(1),rpcPromptPendingRef:ref(true),sdkAgentActiveRef:ref(true),cancelEventStreamGrace:()=>steps.push('cancel-grace'),closeEvents:()=>steps.push('close-events'),settleUiStage:()=>steps.push('idle'),setBashRunning:()=>{},setPendingBash:()=>{},setIsCompacting:()=>{},setExtensionDialog:()=>{},setQueuedMessages:()=>{},sendAgentCommand:()=>{steps.push('HTTP');return new Promise(()=>{});},addNotice:()=>{}};
 const src=hook.slice(hook.indexOf('  const handleAbort ='),hook.indexOf('  const handleFork =')).replace('stopSource?: string', 'stopSource');
 vm.runInNewContext(src,scope);await callback('button');
 assert.ok(steps.indexOf('idle')<steps.indexOf('HTTP'));assert.equal(scope.stoppedSessionsRef.current.has(sid),true);assert.equal(scope.promptRunIdRef.current,2);assert.equal(scope.stopTicketsRef.current.get(sid),'stop-token');
});
test('busy model/effort selections are deferred and applied before the next prompt',()=>{
 for(const s of ['nextSelectionRef.current.set(selectionSid','await prepareNextRequest(session.id)','...(stopTicket ? {afterStop: stopTicket} : {})','setTimeout(resolve, 750)','stoppedSessionsRef.current.has(sessionIdRef.current)'])assert.ok(hook.includes(s),s);
 const input=files.get('components/ChatInput.tsx');assert.match(input,/onChange=\{onModelChange\}\s+disabled=\{false\}/);assert.match(input,/用于下一次请求/);
 const rpc=files.get('lib/rpc-manager.ts');assert.match(rpc,/this\.stopGate\.run\(command\.stopToken/);assert.match(rpc,/this\.stopGate\.run\(command\.afterStop/);
 assert.match(rpc,/event: "pi-agent-stop"/);assert.match(hook,/stopToken, stopSource/);
 const keyboard=files.get('hooks/useKeyboardShortcuts.ts');assert.match(keyboard,/shouldStopOnGlobalEscape\(e\)/);assert.match(keyboard,/globalAbortHandler === handler/);
 const chat=files.get('components/ChatWindow.tsx');assert.match(chat,/useEffect\(\(\) => registerAbortHandler\(sessionBusy/);assert.match(chat,/handleAbort\("keyboard-global"\)/);
 assert.match(rpc, /const sessionThinkingLevel = this\.inner\.agent\.state\.thinkingLevel/);
});

test('actual global Esc handler respects a dismissed panel and unregisters stale sessions',()=>{
 const ts=createRequire(path.join(root,'package.json'))('typescript');
 const keyboardPath='hooks/useKeyboardShortcuts.ts';
 const original=fs.readFileSync(state?.files[keyboardPath]?.backup||path.join(root,keyboardPath),'utf8');
 const execute=(source)=>{
  let listener;const exports={};
  const context={exports,window:{addEventListener:(_name,fn)=>{listener=fn;},removeEventListener:()=>{}},
   require:name=>name==='react'?{useEffect:fn=>fn()}:name==='@/lib/portable-stop-guard'?{shouldStopOnGlobalEscape}:(()=>{throw Error(name)})()};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  exports.useGlobalKeyboardShortcuts({});return {api:exports,key:extra=>listener({key:'Escape',target:{tagName:'BUTTON',closest:()=>null},preventDefault(){this.defaultPrevented=true;},...extra})};
 };
 const old=execute(original);let oldStops=0;old.api.registerAbortHandler(()=>oldStops++);old.key({defaultPrevented:true});assert.equal(oldStops,1,'original handler reproduces unintended stop');
 const fixed=execute(files.get(keyboardPath));let stops=0;const cleanupOld=fixed.api.registerAbortHandler(()=>stops++);
 fixed.key({defaultPrevented:true});fixed.key({isComposing:true});assert.equal(stops,0);
 const cleanupNew=fixed.api.registerAbortHandler(()=>stops+=10);cleanupOld();fixed.key({});assert.equal(stops,10,'old unmount must not clear the new session handler');
 cleanupNew();fixed.key({});assert.equal(stops,10,'unmounted session must not receive global Escape');
});
