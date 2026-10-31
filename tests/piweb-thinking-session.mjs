import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {integrate} from '../tools/patch-piweb-source.mjs';
import {readPendingThinking,savePendingThinking,clearPendingThinking} from '../assets/piweb-overlay/redesign/files/lib/thinking-preference.mjs';
const source=process.env.PIWEB_SOURCE || fileURLToPath(new URL('../upstream/',import.meta.url));
const files=integrate(n=>fs.readFileSync(path.join(source,n),'utf8'));
const hook=files.get('hooks/useAgentSession.ts');
function handler(source,state) {
 let body=source.slice(source.indexOf('const handleThinkingLevelChange = useCallback(')+'const handleThinkingLevelChange = useCallback('.length);
 body=body.slice(0,body.indexOf('}, [isNew]);')+1).replace('level: ThinkingLevelOption','level');
 const names=Object.keys(state);
 return new Function(...names,`return (${body});`)(...names.map(k=>state[k]));
}
function environment(){
 const next=new Map();const env={sessionIdRef:{current:'session-a'},agentRunningRef:{current:true},stopBarriersRef:{current:new Map()},nextSelectionRef:{current:next},isNew:false,thinkingLevelOverrideRef:{current:null},ensuringNewSessionRef:{current:null},sessionHookMountedRef:{current:true},setNewSessionThinkingLevel(){},setCurrentThinkingOverride(){},setLiveThinkingLevel(){},writeThinkingPreference(){},savePendingThinking,clearPendingThinking,sendAgentCommand:async(_sid,c)=>{env.actual=c.level}};
 return env;
}
test('busy medium then idle max replaces the queued choice rather than reverting next turn',async()=>{
 const env=environment(),change=handler(hook,env);
 await change('medium');env.agentRunningRef.current=false;await change('max');
 assert.equal(env.actual,'max');
 assert.equal(env.nextSelectionRef.current.get('session-a')?.thinking,undefined);
});
test('pending selection is session-scoped, survives remount, and old acknowledgement cannot clear a newer choice',()=>{
 const values=new Map();const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});
 try {savePendingThinking('a','max');savePendingThinking('b','low');assert.equal(readPendingThinking('a'),'max');assert.equal(readPendingThinking('b'),'low');savePendingThinking('a','high');clearPendingThinking('a','max');assert.equal(readPendingThinking('a'),'high');clearPendingThinking('a','high');assert.equal(readPendingThinking('a'),null);assert.equal(readPendingThinking('b'),'low');}finally{if(old)Object.defineProperty(globalThis,'localStorage',old);else delete globalThis.localStorage;}
});
test('queued choice is removed only after successful application and preserves newer selection identity',()=>{
 assert.doesNotMatch(hook,/if \(selectionSid\) nextSelectionRef.current.delete/);
 assert.match(hook,/await sendAgentCommand\(sid, \{type: "set_thinking_level", level: selection.thinking\}\);\s*clearPendingThinking/);
 assert.match(hook,/if \(nextSelectionRef.current.get\(sid\) === selection\) nextSelectionRef.current.delete\(sid\)/);
});
test('model switching restores session strength, not model defaults',()=>{
 const rpc=files.get('lib/rpc-manager.ts');
 assert.match(rpc,/const sessionThinkingLevel = this.inner.agent.state\?.thinkingLevel \?\? "off";\s*await this.inner.setModel\(model, \{ persist: true \}\);[\s\S]*?this.inner.setThinkingLevel\(sessionThinkingLevel\)/);
});
