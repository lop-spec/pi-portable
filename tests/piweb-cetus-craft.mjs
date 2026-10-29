import test from 'node:test';
import assert from 'node:assert/strict';
import { installToolIntent, withMetadata, withoutMetadata } from '../assets/piweb-overlay/cetus-craft/tool-intent.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
const root = process.env.PI_SDK_ROOT || [new URL('../upstream/node_modules/@earendil-works', import.meta.url), new URL('../app/node_modules/@earendil-works', import.meta.url)].map(fileURLToPath).find(path => fs.existsSync(path + '/pi-ai/dist/utils/validation.js'));
if (!root) throw new Error('Pi SDK required for metadata execution test');
const { validateToolArguments } = await import(pathToFileURL(root + '/pi-ai/dist/utils/validation.js'));

test('Craft metadata is required, ordered, and does not mutate the tool schema', () => {
  const original = { name:'read', parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}, execute(){} };
  const tool = withMetadata(original);
  assert.deepEqual(tool.parameters.required, ['_displayName','_intent','path']);
  assert.deepEqual(Object.keys(original.parameters.properties), ['path']);
  const message = {name:'read',arguments:{_displayName:'读取规则',_intent:'确认当前文件约束。',path:'a'}};
  assert.deepEqual(validateToolArguments(tool,message),message.arguments);
  assert.equal(withMetadata(tool),tool);
  assert.deepEqual(withoutMetadata(message.arguments),{path:'a'});
  assert.ok(message.arguments._intent);
});

test('real validator and hook strip execution copies, retaining history and dynamic tools', async () => {
  const seen=[];
  const create = name => ({name,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},execute(id,args,signal,update){seen.push({id,args,signal,update});return {content:[]};}});
  const agent={state:{tools:[create('read')]},setTools(tools){this.state.tools=tools;},beforeToolCall(event){seen.push(event.args);}};
  installToolIntent({agent});installToolIntent({agent});
  const message={name:'read',arguments:{path:'a',_intent:'确认文件内容。',_displayName:'读取文件'}};
  const args=validateToolArguments(agent.state.tools[0],message);
  await agent.beforeToolCall({args,toolCall:message});
  const signal=new AbortController().signal, update=()=>{};
  await agent.state.tools[0].execute('call-1',args,signal,update);
  assert.deepEqual(seen[0],{path:'a'});assert.deepEqual(seen[1].args,{path:'a'});
  assert.equal(seen[1].signal,signal);assert.equal(seen[1].update,update);
  assert.equal(message.arguments._intent,'确认文件内容。');
  agent.setTools([create('late-tool')]);
  assert.ok(agent.state.tools[0].parameters.required.includes('_intent'));
});
