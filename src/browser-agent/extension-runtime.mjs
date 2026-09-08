import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureBackgroundBroker} from './background-client.mjs';
import { importFreshModule } from './fresh-module.mjs';
const { resolvePlaywrightModule } = await importFreshModule(new URL('./runtime.mjs', import.meta.url));
const { resolveThoriumExecutable, dailyThoriumProfile } = await importFreshModule(new URL('../thorium-browser.mjs', import.meta.url));

// Official Playwright MCP over stdio. It owns the extension/CDP relay; no native CDP,
// browser launch fallback, Cookie copying, or custom browser protocol is used here.
export class ExtensionBrowserRuntime {
  constructor({ dataRoot }) {
    this.dataRoot = dataRoot;
    this.profileDir = dailyThoriumProfile();
    this.authFile = path.join(dataRoot, 'browser-agent', 'extension-auth.json');
    this.outputDir = path.join(dataRoot, 'browser-agent', 'extension-output');
    this.logFile = path.join(dataRoot, 'browser-agent', 'browser.log');
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.starting = null;
  }
  status() {
    return { running: !!this.child && this.child.exitCode === null, pid: this.child?.pid ?? null,
      mode: 'thorium-background-extension', profileDir: this.profileDir, resident: true };
  }
  async log(event, details = {}) {
    try { await fs.mkdir(path.dirname(this.logFile), {recursive:true}); await fs.appendFile(this.logFile, JSON.stringify({at:new Date().toISOString(), event, ...details})+'\n'); }
    catch(error) { console.error(`[browser] log-write-failed: ${error.message}`); }
  }
  async ensureStarted() {
    if (this.starting) return this.starting;
    if (this.child && this.child.exitCode === null) return;
    this.starting = this.start().catch(async error=>{await this.log('extension-start-failed',{reason:error.message});await this.detach();throw error;}).finally(() => {this.starting=null;});
    return this.starting;
  }
  async start() {
    let token;
    try { token = JSON.parse(await fs.readFile(this.authFile,'utf8')).token; }
    catch(error) { await this.log('extension-auth-unavailable',{reason:error.code || error.message}); throw new Error('Playwright extension token is not configured for this machine; no native CDP or isolated browser fallback is allowed.'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid Playwright extension token format');
    const executable = resolveThoriumExecutable();
    if (!executable) { await this.log('extension-thorium-unavailable'); throw new Error('Daily Thorium executable not found; no fallback browser will be started.'); }
    const bundle = path.join(path.dirname(await resolvePlaywrightModule()), 'lib', 'coreBundle.js');
    await ensureBackgroundBroker({dataRoot:this.dataRoot,authFile:this.authFile,token});
    await fs.mkdir(this.outputDir,{recursive:true});
    const child = spawn(process.execPath,[fileURLToPath(new URL('./background-mcp-worker.mjs',import.meta.url)),bundle,this.outputDir],{
      windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'],
      env:{...process.env, DEBUG:'', PLAYWRIGHT_MCP_EXTENSION_TOKEN:token, PLAYWRIGHT_MCP_EXECUTABLE_PATH:executable},
    });
    this.child=child;
    let buffer='';
    child.stdout.on('data',data=>{
      buffer+=data.toString('utf8');
      while(buffer.includes('\n')) {
        const end=buffer.indexOf('\n'), line=buffer.slice(0,end); buffer=buffer.slice(end+1);
        if(!line.trim())continue;
        let message;try{message=JSON.parse(line);}catch{void this.log('extension-invalid-rpc-output');continue;}
        if(message.method && message.id !== undefined) {
          child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...message.method==='roots/list'?{result:{roots:[]}}:{error:{code:-32601,message:'Unsupported client method'}}})+'\n');
          continue;
        }
        const request=this.pending.get(message.id); if(!request)continue;
        this.pending.delete(message.id);clearTimeout(request.timer);
        message.error ? request.reject(new Error(JSON.stringify(message.error).replaceAll(token,'<redacted>'))) : request.resolve(message.result);
      }
    });
    child.stderr.on('data',data=>{const reason=data.toString('utf8').replaceAll(token,'<redacted>').trim();if(reason)void this.log('extension-mcp-stderr',{reason:reason.slice(0,1000)});});
    const fail=error=>{if(this.child!==child)return;this.child=null;for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();};
    child.on('error',error=>{void this.log('extension-mcp-start-failed',{reason:error.message});fail(error);});
    child.on('exit',(code)=>{void this.log('extension-mcp-exit',{pid:child.pid,code});fail(new Error(`Playwright extension MCP exited (${code})`));});
    await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'Pi Thorium',version:'1'}},15000);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const listed=await this.request('tools/list',{},15000);
    this.toolNames=new Set(listed.tools.map(tool=>tool.name));
    this.runCodeTool=this.toolNames.has('browser_run_code')?'browser_run_code':'browser_run_code_unsafe';
    if(this.runCodeTool!=='browser_run_code')await this.log('extension-tool-alias',{requested:'browser_run_code',actual:this.runCodeTool,reason:'Official installed Playwright API uses the renamed tool'});
    await this.log('extension-mcp-ready',{pid:child.pid,profileDir:this.profileDir});
  }
  request(method, params, timeoutMs=30000) {
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);void this.log('extension-rpc-timeout',{method,tool:params?.name});reject(new Error(`Playwright extension request timed out: ${params?.name || method}. No native CDP fallback was attempted.`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  async call(name,args={},timeoutMs=30000) {
    await this.ensureStarted();
    if(name==='browser_run_code')name=this.runCodeTool;
    if(!this.toolNames.has(name))throw new Error(`Installed Playwright extension API does not provide ${name}`);
    const result=await this.request('tools/call',{name,arguments:args},timeoutMs);
    if(result.isError){const reason=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');await this.log('extension-tool-failed',{tool:name,reason:reason.slice(0,400)});throw new Error(reason);}
    return result;
  }
  locator(p) {
    if(p.ref)return `page.locator(${JSON.stringify('aria-ref='+p.ref)})`;
    if(p.selector)return `page.locator(${JSON.stringify(p.selector)})${p.targetText?`.filter({hasText:${JSON.stringify(p.targetText)}})`:''}`;
    if(p.role)return `page.getByRole(${JSON.stringify(p.role)},${JSON.stringify({name:p.name,exact:p.exact??true})})`;
    if(p.targetText)return `page.getByText(${JSON.stringify(p.targetText)},{exact:${p.exact??true}})`;
    throw new Error('A snapshot ref, selector, role, or targetText is required');
  }
  async execute(p) {
    const timeout=p.timeoutMs??30000;
    let result;
    const run=code=>this.call('browser_run_code',{code:`async (page) => { ${code} }`},timeout);
    const snap=()=>this.call('browser_snapshot',{},timeout);
    if(p.url){const url=new URL(p.url);if(!['http:','https:'].includes(url.protocol)&&p.url!=='about:blank')throw new Error('Only http(s) and about:blank navigation is allowed');}
    switch(p.action) {
      case 'open': case 'goto':
        if(p.action==='goto'&&!p.url)throw new Error('url is required');
        result=p.url?await this.call('browser_navigate',{url:p.url},timeout):await snap();break;
      case 'snapshot': result=await snap();break;
      case 'text': result=await this.call('browser_evaluate',{function:`() => ({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,${p.maxChars??60000})})`},timeout);break;
      case 'eval': if(!p.expression)throw new Error('expression is required'); result=await this.call('browser_evaluate',{function:`() => (${p.expression})`},timeout);break;
      case 'click': if(p.ref)result=await this.call('browser_click',{ref:p.ref},timeout);else {await run(`await ${this.locator(p)}.click();`);result=await snap();}break;
      case 'type': if(p.value===undefined)throw new Error('value is required'); if(p.ref)result=await this.call('browser_type',{ref:p.ref,text:p.value,submit:p.submit??false},timeout);else {await run(`await ${this.locator(p)}.fill(${JSON.stringify(p.value)});${p.submit?`await ${this.locator(p)}.press('Enter');`:''}`);result=await snap();}break;
      case 'press': if(!p.key)throw new Error('key is required'); if(p.ref||p.selector||p.role||p.targetText){await run(`await ${this.locator(p)}.press(${JSON.stringify(p.key)});`);result=await snap();}else result=await this.call('browser_press_key',{key:p.key},timeout);break;
      case 'wait': if(p.ref||p.selector||p.role||p.targetText){await run(`await ${this.locator(p)}.waitFor({state:'visible',timeout:${timeout}});`);result=await snap();}else result=await this.call('browser_wait_for',{time:(p.milliseconds??1000)/1000},timeout);break;
      case 'screenshot': result=await this.call('browser_take_screenshot',{type:'png',fullPage:p.fullPage??false},timeout);break;
      case 'tabs': result=await this.call('browser_tabs',{action:'list'},timeout);break;
      case 'select_tab': result=await this.call('browser_tabs',{action:'select',index:p.tabIndex},timeout);break;
      case 'new_tab': await this.call('browser_tabs',{action:'new'},timeout);result=p.url?await this.call('browser_navigate',{url:p.url},timeout):await snap();break;
      case 'close_tab': result=await this.call('browser_tabs',{action:'close'},timeout);break;
      case 'close': await this.detach();return {content:[{type:'text',text:'Extension connection detached; daily Thorium and its login state were retained.'}],details:{action:p.action,mode:this.status().mode}};
      default: throw new Error(`Unsupported browser action: ${p.action}`);
    }
    const content=[];
    for(const item of result.content||[]) {
      if(item.type!=='text'){content.push(item);continue;}
      let text=item.text;
      const links=[...text.matchAll(/\[Snapshot\]\(([^)]+\.yml)\)/g)];
      for(const link of links){const file=path.resolve(link[1]);const relative=path.relative(this.outputDir,file);if(relative.startsWith('..')||path.isAbsolute(relative)||!/^page-[^/\\]+\.yml$/.test(path.basename(file)))continue;try{text+='\n\n'+(await fs.readFile(file,'utf8')).slice(0,45000);}catch(error){await this.log('extension-snapshot-read-failed',{reason:error.code,file});}}
      if(text.length>60000){const file=path.join(this.outputDir,`result-${Date.now()}.txt`);await fs.writeFile(file,text,'utf8');await this.log('extension-result-truncated',{file,chars:text.length});text=text.slice(0,60000)+`\n[Truncated; full text: ${file}]`;}
      content.push({type:'text',text});
    }
    await this.log('extension-action',{action:p.action});
    return {content,details:{action:p.action,mode:this.status().mode}};
  }
  async detach() {
    const child=this.child;if(!child)return {detached:false,alreadyDetached:true};
    this.child=null;
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('Extension connection detached'));}this.pending.clear();
    child.stdin.end();
    // Only the agent-owned MCP worker is stopped, never Thorium or its tabs.
    child.kill();
    await this.log('extension-detach',{pid:child.pid});
    return {detached:true};
  }
  async close(){return this.detach();}
}
