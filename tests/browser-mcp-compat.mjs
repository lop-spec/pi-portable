// No model/browser launch: load the actually installed official MCP bundle and
// verify its background-only bootstrap and tool protocol before touching a tab.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolvePlaywrightModule} from '../src/browser-agent/runtime.mjs';
import {patchBackgroundBootstrap} from '../src/browser-agent/background-mcp-patch.mjs';
import {readDailyBrowserSelection,resolveDailyPlaywrightModule} from '../src/browser-agent/daily-browser.mjs';
const selection=process.env.PI_PORTABLE_DATA?readDailyBrowserSelection({dataRoot:process.env.PI_PORTABLE_DATA}):{};
const module=await resolveDailyPlaywrightModule(selection,resolvePlaywrightModule),dir=path.dirname(module),output=await fs.mkdtemp(path.join(os.tmpdir(),'pi-mcp-compat-'));
const bundle=path.join(dir,'lib/coreBundle.js');
assert.match(patchBackgroundBootstrap(await fs.readFile(bundle,'utf8')),/__piOpenBackgroundExtension\(href\)/);
const child=spawn(process.execPath,[fileURLToPath(new URL('../src/browser-agent/background-mcp-worker.mjs',import.meta.url)),bundle,output],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PLAYWRIGHT_MCP_EXTENSION_TOKEN:'test'.padEnd(43,'x')}});
const requests=new Map();let seq=0,buffer='',stderr='';
child.stderr.on('data',d=>{stderr+=String(d);});
child.stdout.on('data',d=>{buffer+=d;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const msg=JSON.parse(line),r=requests.get(msg.id);if(r){requests.delete(msg.id);clearTimeout(r.timer);msg.error?r.reject(new Error(JSON.stringify(msg.error))):r.resolve(msg.result);}}});
const fail=error=>{for(const r of requests.values()){clearTimeout(r.timer);r.reject(error);}requests.clear();};
child.on('error',fail);child.on('exit',code=>fail(new Error('MCP worker exited '+code)));
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;requests.set(id,{resolve,reject,timer:setTimeout(()=>{requests.delete(id);reject(new Error('MCP compatibility timeout '+method));},10000)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
try {
  const init=await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'Pi compatibility test',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await request('tools/list',{}),names=new Set(list.tools.map(t=>t.name));
  for(const name of ['browser_navigate','browser_snapshot','browser_evaluate','browser_click','browser_type','browser_tabs'])assert(names.has(name),name);
  assert(names.has('browser_run_code')||names.has('browser_run_code_unsafe'));
  assert.match(stderr,/official MCP loaded with background-only bootstrap/);
  console.log(JSON.stringify({pass:true,playwrightVersion:JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8')).version,protocol:init.protocolVersion,toolCount:names.size,browserLaunches:0}));
}finally{child.stdin.end();child.kill();await fs.rm(output,{recursive:true,force:true});}
