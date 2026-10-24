import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {integrate} from '../tools/patch-piweb-source.mjs';
const root=process.env.PIWEB_SOURCE||path.resolve('upstream');
const statePath=path.join(root,'.pi-portable-overlay.json');const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
const files=integrate(name=>{const record=state?.files[name];if(record&&!record.backup)throw Error('Generated file');return fs.readFileSync(record?.backup||path.join(root,name),'utf8');});
const hook=files.get('hooks/useAgentSession.ts');
test('Stop releases React state synchronously while abort HTTP stays pending',async()=>{
 const steps=[],ref=current=>({current}),sid='fixture';let callback;
 const scope={crypto:{randomUUID:()=> 'stop-token'},useCallback:fn=>{callback=fn;},sessionIdRef:ref(sid),stopBarriersRef:ref(new Map()),stopTicketsRef:ref(new Map()),stoppedSessionsRef:ref(new Set()),bashRunningRef:ref(false),agentRunningRef:ref(true),promptRunIdRef:ref(1),rpcPromptPendingRef:ref(true),sdkAgentActiveRef:ref(true),cancelEventStreamGrace:()=>steps.push('cancel-grace'),closeEvents:()=>steps.push('close-events'),settleUiStage:()=>steps.push('idle'),setBashRunning:()=>{},setPendingBash:()=>{},setIsCompacting:()=>{},setExtensionDialog:()=>{},setQueuedMessages:()=>{},sendAgentCommand:()=>{steps.push('HTTP');return new Promise(()=>{});},addNotice:()=>{}};
 const src=hook.slice(hook.indexOf('  const handleAbort ='),hook.indexOf('  const handleFork ='));
 vm.runInNewContext(src,scope);await callback();
 assert.ok(steps.indexOf('idle')<steps.indexOf('HTTP'));assert.equal(scope.stoppedSessionsRef.current.has(sid),true);assert.equal(scope.promptRunIdRef.current,2);assert.equal(scope.stopTicketsRef.current.get(sid),'stop-token');
});
test('busy model/effort selections are deferred and applied before the next prompt',()=>{
 for(const s of ['nextSelectionRef.current.set(selectionSid','await prepareNextRequest(session.id)','...(stopTicket ? {afterStop: stopTicket} : {})','setTimeout(resolve, 750)','stoppedSessionsRef.current.has(sessionIdRef.current)'])assert.ok(hook.includes(s),s);
 const input=files.get('components/ChatInput.tsx');assert.match(input,/onChange=\{onModelChange\}\s+disabled=\{false\}/);assert.match(input,/用于下一次请求/);
 const rpc=files.get('lib/rpc-manager.ts');assert.match(rpc,/consumedStopTokens.has\(command.stopToken\)\) return null/);assert.match(rpc,/consumedStopTokens.add\(command.afterStop\)/);
});
