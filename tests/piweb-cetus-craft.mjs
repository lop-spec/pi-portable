import test from 'node:test';
import assert from 'node:assert/strict';
import { installToolIntent, withMetadata, withoutMetadata } from '../assets/piweb-overlay/cetus-craft/tool-intent.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
const root = process.env.PI_SDK_ROOT || [new URL('../upstream/node_modules/@earendil-works', import.meta.url), new URL('../app/node_modules/@earendil-works', import.meta.url)].map(fileURLToPath).find(path => fs.existsSync(path + '/pi-ai/dist/utils/validation.js'));
if (!root) throw new Error('Pi SDK required for metadata execution test');
const { validateToolArguments } = await import(pathToFileURL(root + '/pi-ai/dist/utils/validation.js'));
const { Agent } = await import(pathToFileURL(root + '/pi-agent-core/dist/agent.js'));
const { AssistantMessageEventStream } = await import(pathToFileURL(root + '/pi-ai/dist/utils/event-stream.js'));

const create = (name,execute=()=>({content:[]})) => ({name,label:name,description:'Inspect fixture',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},execute});
test('phase marker is optional; per-call labels are no longer advertised or required', () => {
  const original=create('read'),tool=withMetadata(original);
  assert.deepEqual(tool.parameters.required,['path']);
  assert.deepEqual(Object.keys(tool.parameters.properties),['_phase','path']);
  assert.deepEqual(Object.keys(original.parameters.properties),['path']);
  assert.match(tool.parameters.properties._phase.description,/同阶段后续调用省略/);
  for(const args of [{path:'a'},{_phase:'核对修改后的效果',path:'a'}])assert.deepEqual(validateToolArguments(tool,{name:'read',arguments:args}),args);
  assert.equal(withMetadata(tool),tool);
  assert.deepEqual(withoutMetadata({_phase:'新阶段',_displayName:'旧标题',_intent:'旧说明',path:'a'}),{path:'a'});
  const legacy=withMetadata({...original,parameters:{...original.parameters,properties:{...original.parameters.properties,_intent:{type:'string'},_displayName:{type:'string'}},required:['_intent','_displayName','path']}});
  assert.deepEqual(legacy.parameters.required,['path']);
  assert.equal(legacy.parameters.properties._intent,undefined);assert.equal(legacy.parameters.properties._displayName,undefined);
});

test('validator and hooks strip metadata only from execution copies, including dynamic tools', async () => {
  const seen=[];
  const agent=new Agent({initialState:{tools:[create('read',(id,args,signal,update)=>{seen.push({id,args,signal,update});return {content:[]};})]},streamFn:()=>{throw Error('Must not call a model');}});
  agent.beforeToolCall=event=>{seen.push(event.args);};
  installToolIntent({agent});installToolIntent({agent});
  const message={name:'read',arguments:{path:'a',_phase:'查看目前的设置'}};
  const args=validateToolArguments(agent.state.tools[0],message);
  await agent.beforeToolCall({args,toolCall:message});
  const signal=new AbortController().signal,update=()=>{};
  await agent.state.tools[0].execute('call-1',args,signal,update);
  assert.deepEqual(seen[0],{path:'a'});assert.deepEqual(seen[1].args,{path:'a'});
  assert.equal(seen[1].signal,signal);assert.equal(seen[1].update,update);
  assert.equal(message.arguments._phase,'查看目前的设置');
  agent.state.tools=[create('late-tool')];
  assert.deepEqual(agent.state.tools[0].parameters.required,['path']);
  assert.ok(agent.state.tools[0].parameters.properties._phase);
});

test('native Agent needs no phase-only model turn; subsequent calls omit all metadata', async () => {
  let requests=0;const received=[];
  const tool=create('inspect',async(id,args)=>{received.push(args);return {content:[{type:'text',text:'ok'}],details:{}};});
  const agent=new Agent({initialState:{tools:[tool]},streamFn:(_model,context)=>{
    const advertised=context.tools?.[0]??context.messages.flatMap(m=>m.toolsAdded??[]).filter(t=>t.name==='inspect').at(-1);
    assert.deepEqual(advertised.parameters.required,['path']);
    const step=requests++;
    const args=[{path:'first',_phase:'查看目前的设置'},{path:'second'},{path:'third',_phase:'核对修改后的效果'}][step];
    const message={role:'assistant',content:args?[{type:'toolCall',id:'native-'+step,name:'inspect',arguments:args}]:[{type:'text',text:'完成'}],stopReason:args?'toolUse':'stop',api:'fixture',provider:'fixture',model:'fixture',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const stream=new AssistantMessageEventStream();stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});return stream;
  }});
  installToolIntent({agent});await agent.prompt('【测试任务】查看设置并核对结果');
  assert.equal(requests,4);
  assert.deepEqual(received,[{path:'first'},{path:'second'},{path:'third'}]);
  const calls=agent.state.messages.filter(m=>m.role==='assistant'&&m.stopReason==='toolUse').map(m=>m.content[0]);
  assert.equal(calls[0].arguments._phase,'查看目前的设置');assert.deepEqual(calls[1].arguments,{path:'second'});
  assert.equal(agent.state.messages.filter(m=>m.role==='toolResult'&&m.isError).length,0);
});
