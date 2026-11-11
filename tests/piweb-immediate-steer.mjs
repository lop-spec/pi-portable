// Real AgentSession + the complete integrated RPC wrapper. No model/network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {integrate} from '../tools/patch-piweb-source.mjs';
import {createStopGate} from '../assets/piweb-overlay/immediate-stop/stop-guard.ts';
const source = path.resolve(process.env.PIWEB_SOURCE || 'upstream');
const require = createRequire(path.join(source, 'package.json'));
const ts = require('typescript');
const sdk = await import(pathToFileURL(path.join(source,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const ai = await import(pathToFileURL(path.join(source,'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
const stateFile = path.join(source, '.pi-portable-overlay.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const files = integrate(name => fs.readFileSync(state?.files[name]?.backup || path.join(source,name), 'utf8'));
const patched = files.get('lib/rpc-manager.ts');
// Remove exactly the new composition to run the same wrapper with old behavior.
const native = patched.replace(/            if \(streamingBehavior === "steer"[\s\S]*?\n            }\n            prompt =/, '            prompt =');
assert.notEqual(native, patched);
function wrapperClass(text) {
  const tree = ts.createSourceFile('rpc-manager.ts', text, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentSessionWrapper');
  const code = ts.transpileModule(cls.getText(tree).replace('export class', 'class')+'\nAgentSessionWrapper;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return vm.runInNewContext(code, {
    console, setTimeout, clearTimeout, AbortController, DOMException,
    createStopGate, installToolIntent(){}, assertSessionNotMoving(){}, assertProjectAvailable(){},
    validateAgentImages: images => images?.some(i => !i.data) ? 'Invalid image' : null,
    invalidateSessionListCache(){}, SESSION_IDLE_TIMEOUT_MS:0,
    COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT:new Set(['get_state']),
    SESSION_REPLACEMENT_COMMAND_TYPES:new Set(['fork','clone']),
    IDLE_RESET_EVENT_TYPES:new Set(['agent_end','agent_settled','auto_compaction_end','compaction_end']),
  });
}
const Fixed = wrapperClass(patched), Native = wrapperClass(native);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
const deadline = (p, label) => Promise.race([p, new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error(label)),4000);t.unref();})]);
async function fixture(Wrapper=Fixed,{tool=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-immediate-steer-'));
  const runtime=await sdk.ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  await runtime.setRuntimeApiKey('openai','offline-fixture-not-a-credential');
  const model=runtime.getModels('openai')[0];
  const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},images:{blockImages:false}});
  const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  const started=deferred(), release=deferred(), cancelled=deferred(), toolStarted=deferred(), toolFinished=deferred();
  const contexts=[],events=[];
  let calls=0,completions=0,toolCalls=0;
  const {session}=await sdk.createAgentSession({cwd:dir,agentDir:dir,model,modelRuntime:runtime,settingsManager:settings,resourceLoader:loader,sessionManager:sdk.SessionManager.inMemory(dir),thinkingLevel:'off',
    tools:tool?['fixture_tool']:[],customTools:tool?[{name:'fixture_tool',label:'fixture',description:'cancellable offline fixture',parameters:{type:'object',properties:{}},
      execute:async(_id,_args,signal)=>{
        toolCalls++;toolStarted.resolve();
        await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
        // SDK must finish this result before starting the replacement prompt.
        await tick();toolFinished.resolve();
        return {content:[{type:'text',text:'cancelled safely'}],details:{}};
      }}]:[]});
  session.agent.streamFunction=(_model,context,options)=>{
    const stream=new ai.AssistantMessageEventStream();
    const finish=reason=>{
      const message={role:'assistant',provider:model.provider,api:model.api,model:model.id,timestamp:Date.now(),stopReason:reason,
        content:reason==='toolUse'?[{type:'toolCall',id:'fixture-once',name:'fixture_tool',arguments:{}}]:[{type:'text',text:reason==='aborted'?'partial':'done'}],
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push(reason==='aborted'?{type:'error',reason,error:message}:{type:'done',reason,message});stream.end(message);
    };
    // Real providers reject an already-aborted signal before issuing network I/O.
    if(options.signal.aborted){queueMicrotask(()=>finish('aborted'));return stream;}
    const n=++calls;contexts.push(structuredClone(context));
    if(n===1&&!tool){
      started.resolve();let done=false;
      const end=reason=>{if(done)return;done=true;finish(reason);};
      options.signal.addEventListener('abort',()=>{cancelled.resolve(performance.now());end('aborted');},{once:true});
      void release.promise.then(()=>end('stop'));
    } else queueMicrotask(()=>finish(n===1&&tool?'toolUse':'stop'));
    return stream;
  };
  session.subscribe(event=>events.push(event));
  const wrapper=new Wrapper(session,{onAgentRunComplete:()=>completions++});wrapper.start();
  return {session,wrapper,contexts,events,started,release,cancelled,toolStarted,toolFinished,
    get calls(){return calls;},get completions(){return completions;},get toolCalls(){return toolCalls;},
    async close(){release.resolve();await session.abort();wrapper.destroy();fs.rmSync(dir,{recursive:true,force:true});}};
}
async function settle(f) { await deadline(f.session.waitForIdle(),'session did not settle');await tick(); }

test('old behavior acks immediately but model cannot see steering until the old generation finishes',async()=>{
  const f=await fixture(Native);
  try {
    await f.wrapper.send({type:'prompt',message:'original task'});await deadline(f.started.promise,'first request missing');
    await f.wrapper.send({type:'prompt',message:'new instruction',streamingBehavior:'steer'});
    await tick();assert.equal(f.calls,1);assert.equal(f.session.getSteeringMessages().length,1);
    f.release.resolve();await settle(f);assert.equal(f.calls,2);
  } finally {await f.close();}
});
test('immediate steering cancels a blocked generation and delivers images and continuation exactly once',async()=>{
  const f=await fixture();
  try {
    await f.wrapper.send({type:'prompt',message:'original task'});await deadline(f.started.promise,'first request missing');
    const text='new instruction\n\n请继续原任务。',at=performance.now();
    const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='};
    await deadline(f.wrapper.send({type:'prompt',message:text,streamingBehavior:'steer',images:[image]}),'steering waited for old generation');
    const abortedAt=await deadline(f.cancelled.promise,'provider was not cancelled');
    await settle(f);assert.equal(f.calls,2);assert.ok(abortedAt-at<500,`cancellation took ${abortedAt-at}ms`);
    const users=f.session.agent.state.messages.filter(m=>m.role==='user');
    assert.equal(users.length,2);assert.equal(users[1].content[0].text,text);assert.ok(users[1].content.some(c=>c.type==='image'));
    assert.equal(f.completions,1,'no false completion while replacing the interrupted run');
    assert.ok(f.events.some(e=>e.type==='message_end'&&e.message.stopReason==='aborted'));
    console.log(JSON.stringify({scenario:'immediate-steer',cancelMs:abortedAt-at,calls:f.calls,userMessages:users.length}));
  } finally {await f.close();}
});
test('follow-up remains queued and survives an immediate interjection',async()=>{
  const f=await fixture();
  try {
    await f.wrapper.send({type:'prompt',message:'original task'});await deadline(f.started.promise,'first request missing');
    await f.wrapper.send({type:'prompt',message:'later task',streamingBehavior:'followUp'});
    await tick();assert.equal(f.calls,1);assert.equal(f.session.getFollowUpMessages()[0],'later task');
    await f.wrapper.send({type:'prompt',message:'immediate instruction',streamingBehavior:'steer'});await settle(f);
    const text=f.session.agent.state.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content.find(c=>c.type==='text').text);
    assert.deepEqual(text,['original task','immediate instruction','later task']);
    assert.equal(f.calls,3);assert.equal(f.session.pendingMessageCount,0);
  } finally {await f.close();}
});
test('native tool cancellation finalizes one tool result before the next provider call',async()=>{
  const f=await fixture(Fixed,{tool:true});
  try {
    await f.wrapper.send({type:'prompt',message:'run offline tool'});await deadline(f.toolStarted.promise,'tool not started');
    await deadline(f.wrapper.send({type:'prompt',message:'change direction',streamingBehavior:'steer'}),'tool cancellation stalled');
    await deadline(f.toolFinished.promise,'tool never finalized');await settle(f);
    assert.equal(f.toolCalls,1);assert.equal(f.calls,2);
    const messages=f.contexts[1].messages;
    const result=messages.findIndex(m=>m.role==='toolResult'&&m.toolCallId==='fixture-once');
    const user=messages.findIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('change direction'));
    assert.ok(result>=0&&user>result,'replacement context contains finalized tool result first');
  } finally {await f.close();}
});
test('Stop during cancellation prevents an automatic replacement prompt',async()=>{
  const f=await fixture();const nativeAbort=f.session.abort.bind(f.session),held=deferred(),entered=deferred();
  let first=true;
  f.session.abort=async()=>{await nativeAbort();if(first){first=false;entered.resolve();await held.promise;}};
  try {
    await f.wrapper.send({type:'prompt',message:'original task'});await deadline(f.started.promise,'first request missing');
    const pending=f.wrapper.send({type:'prompt',message:'must not resume',streamingBehavior:'steer'});
    const rejection=assert.rejects(pending,/引导已被停止/);
    await deadline(entered.promise,'cancel not entered');
    await f.wrapper.send({type:'abort',stopToken:'fixture-stop',stopSource:'button'});held.resolve();await rejection;
    await settle(f);assert.equal(f.calls,1);assert.equal(f.wrapper.isRunning(),false);
    assert.equal(f.session.agent.state.messages.filter(m=>m.role==='user').length,1);
  } finally {held.resolve();await f.close();}
});
test('idle race starts immediately; invalid images reject before cancelling existing work',async()=>{
  const f=await fixture();
  try {
    await f.wrapper.send({type:'prompt',message:'original task'});await deadline(f.started.promise,'first request missing');
    await assert.rejects(f.wrapper.send({type:'prompt',message:'bad',images:[{data:''}],streamingBehavior:'steer'}),/Invalid image/);
    assert.equal(f.calls,1);f.release.resolve();await settle(f);
    await f.wrapper.send({type:'prompt',message:'late interjection',streamingBehavior:'steer'});await settle(f);
    assert.equal(f.calls,2);assert.equal(f.session.pendingMessageCount,0);
  } finally {await f.close();}
});
