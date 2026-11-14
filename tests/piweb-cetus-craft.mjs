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

test('one plain-language label is required without mutating the tool schema', () => {
  const original = { name:'read', parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}, execute(){} };
  const tool = withMetadata(original);
  assert.deepEqual(tool.parameters.required, ['_displayName','path']);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['_displayName','path']);
  assert.deepEqual(Object.keys(original.parameters.properties), ['path']);
  assert.match(tool.parameters.properties._displayName.description, /小学生/);
  const message = {name:'read',arguments:{_displayName:'看修改要遵守哪些规则',path:'a'}};
  assert.deepEqual(validateToolArguments(tool,message),message.arguments);
  assert.equal(withMetadata(tool),tool);
  assert.deepEqual(withoutMetadata({...message.arguments,_intent:'旧版说明仍可清除'}),{path:'a'});
  assert.equal(message.arguments._displayName,'看修改要遵守哪些规则');
  const legacy = withMetadata({...original,parameters:{...original.parameters,properties:{...original.parameters.properties,_intent:{type:'string'}},required:['_intent','path']}});
  assert.deepEqual(legacy.parameters.required,['_displayName','path']);
  assert.equal(legacy.parameters.properties._intent,undefined);
});

test('real validator and hook strip execution copies, retaining history and dynamic tools', async () => {
  const seen=[];
  const create = name => ({name,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},execute(id,args,signal,update){seen.push({id,args,signal,update});return {content:[]};}});
  const agent = new Agent({initialState:{tools:[create('read')]},streamFn:()=>{throw new Error('This registry test must not call a model');}});
  agent.beforeToolCall = event => { seen.push(event.args); }; 
  installToolIntent({agent});installToolIntent({agent});
  const message={name:'read',arguments:{path:'a',_displayName:'查看这个文件的内容'}};
  const args=validateToolArguments(agent.state.tools[0],message);
  await agent.beforeToolCall({args,toolCall:message});
  const signal=new AbortController().signal, update=()=>{};
  await agent.state.tools[0].execute('call-1',args,signal,update);
  assert.deepEqual(seen[0],{path:'a'});assert.deepEqual(seen[1].args,{path:'a'});
  assert.equal(seen[1].signal,signal);assert.equal(seen[1].update,update);
  assert.equal(message.arguments._displayName,'查看这个文件的内容');
  agent.state.tools = [create('late-tool')];
  assert.ok(agent.state.tools[0].parameters.required.includes('_displayName'));
  assert.equal(agent.state.tools[0].parameters.properties._intent,undefined);
});

test('native Agent loop uses one label with no extra model round or execution changes', async () => {
  let requests = 0; const received = [];
  const tool = { name:'inspect', label:'Inspect', description:'Inspect fixture', parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}, async execute(id,args){received.push(args);return {content:[{type:'text',text:'ok'}],details:{}};} };
  const agent = new Agent({initialState:{tools:[tool]},streamFn:(_model,context)=>{
    const advertised = context.tools?.[0] ?? context.messages.flatMap(message=>message.toolsAdded ?? []).filter(tool=>tool.name==='inspect').at(-1);
    assert.ok(advertised?.parameters.required.includes('_displayName'));
    assert.equal(advertised?.parameters.properties._intent,undefined);
    const first = requests++ === 0;
    const message = {role:'assistant',content:first?[{type:'toolCall',id:'native-call',name:'inspect',arguments:{path:'fixture',_displayName:'看测试文件能不能读取'}}]:[{type:'text',text:'完成'}],stopReason:first?'toolUse':'stop',api:'fixture',provider:'fixture',model:'fixture',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const stream=new AssistantMessageEventStream();stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});return stream;
  }});
  installToolIntent({agent});
  await agent.prompt('【测试任务】检查文件');
  assert.equal(requests,2,JSON.stringify(agent.state.messages));
  assert.deepEqual(received,[{path:'fixture'}]);
  const saved=agent.state.messages.find(m=>m.role==='assistant').content[0].arguments;
  assert.equal(saved._displayName,'看测试文件能不能读取');
  assert.equal(saved._intent,undefined);
  assert.equal(agent.state.messages.find(m=>m.role==='toolResult').isError,false);
});
