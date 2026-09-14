import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {ExtensionBrowserRuntime} from '../src/browser-agent/extension-runtime.mjs';
import {brokerRequest,ensureBackgroundBroker} from '../src/browser-agent/background-client.mjs';
// Explicit opt-in: operates only the bridge's dedicated tab, using a loopback fixture.
const dataRoot=process.argv[process.argv.indexOf('--data-root')+1];
if(!process.argv.includes('--live')||!process.argv.includes('--data-root')||!dataRoot)throw Error('Usage: node tests/browser-fixed-tab-live.mjs --live --data-root <absolute portable data root>');
const authFile=dataRoot+'/browser-agent/extension-auth.json';
const {token}=JSON.parse(await fs.readFile(authFile,'utf8'));
const log=(stage,data={})=>console.log(JSON.stringify({at:new Date().toISOString(),stage,...data}));
const text=result=>result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
const parse=result=>{const value=text(result);assert(!value.includes(token),'Token leaked');return JSON.parse(value.split('### Result\n')[1]?.split('\n### ')[0]);};
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>Pi background compatibility</title><input aria-label="Test input" id="input"><button id="apply" onclick="document.querySelector(\'#out\').textContent=document.querySelector(\'#input\').value">Apply</button><output id="out"></output><a href="/next">Next</a>');});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${fixture.address().port}/`;
const runtimes=[];let failed=false;
try {
 await ensureBackgroundBroker({dataRoot,authFile,token});
 const before=await brokerRequest('/diagnostics',token);
 let runtime=new ExtensionBrowserRuntime({dataRoot});runtimes.push(runtime);
 await runtime.execute({action:'goto',url,timeoutMs:20000});
 const state=()=>brokerRequest('/diagnostics',token).then(d=>d.events.filter(e=>e.kind==='single-tab-state').at(-1));
 const initial=await state();assert(initial);assert.equal(initial.connectionTabCount,0);assert.equal(initial.playwrightGroupCount,0);
 const snapshot=text(await runtime.execute({action:'snapshot'}));assert.match(snapshot,/Test input/);
 const inputRef=snapshot.match(/textbox "Test input" \[ref=([^\]]+)\]/)?.[1];
 assert(inputRef,'No input snapshot ref');
 await runtime.execute({action:'type',ref:inputRef,value:'background-ref-pass'});
 const buttonRef=snapshot.match(/button "Apply" \[ref=([^\]]+)\]/)?.[1];assert(buttonRef,'No button snapshot ref');
 await runtime.execute({action:'click',ref:buttonRef});
 assert.equal(parse(await runtime.execute({action:'eval',expression:'document.querySelector("#out").textContent'})),'background-ref-pass');
 await runtime.execute({action:'type',selector:'#input',value:'background-selector-pass'});
 await runtime.execute({action:'press',selector:'#input',key:'End'});
 await runtime.execute({action:'click',selector:'#apply'});
 assert.equal(parse(await runtime.execute({action:'eval',expression:'document.querySelector("#out").textContent'})),'background-selector-pass');
 assert.match(parse(await runtime.execute({action:'text'})).text,/background-selector-pass/);
 assert.equal(parse(await runtime.call('browser_run_code',{code:'async page => page.context().pages().length'})),1);
 const agent=parse(await runtime.execute({action:'eval',expression:'navigator.userAgent'}));
 log('input-click-text-refs-selectors-pass',{tabId:initial.tabId,userAgent:agent});
 const competitor=new ExtensionBrowserRuntime({dataRoot});runtimes.push(competitor);
 await assert.rejects(competitor.execute({action:'open',timeoutMs:20000}),/busy/i);await competitor.detach();
 assert.equal(parse(await runtime.execute({action:'eval',expression:'document.querySelector("#out").textContent'})),'background-selector-pass');
 log('busy-rejection-owner-intact');
 for(let n=1;n<=4;n++){
  await runtime.detach();await new Promise(r=>setTimeout(r,400));
  runtime=new ExtensionBrowserRuntime({dataRoot});runtimes.push(runtime);
  assert.equal(parse(await runtime.execute({action:'eval',expression:'document.querySelector("#out").textContent',timeoutMs:20000})),'background-selector-pass');
  const s=await state();assert.equal(s.tabId,initial.tabId);assert.equal(s.tabCount,initial.tabCount);assert.deepEqual(s.activeTabs,initial.activeTabs);
  log('reconnect-pass',{cycle:n,tabId:s.tabId,tabCount:s.tabCount});
 }
 for(let n=0;n<3;n++)await runtime.execute({action:'new_tab',url:url+'?reuse='+n});
 await runtime.execute({action:'click',role:'link',name:'Next'});
 await runtime.execute({action:'wait',role:'textbox',name:'Test input'});
 assert(parse(await runtime.execute({action:'eval',expression:'location.pathname'}))==='/next');
 await assert.rejects(runtime.execute({action:'select_tab',tabIndex:1}),/only tabIndex 0/);
 await runtime.execute({action:'close_tab'});assert.equal(parse(await runtime.execute({action:'eval',expression:'location.href'})),'about:blank');
 const after=await brokerRequest('/diagnostics',token),states=after.events.filter(e=>e.seq>before.sequence&&e.kind==='single-tab-state');
 assert(states.length>=5);assert(states.every(s=>s.tabId===initial.tabId&&s.tabCount===initial.tabCount&&s.connectionTabCount===0&&s.playwrightGroupCount===0));
 const focus=after.events.filter(e=>e.seq>before.sequence&&['tab-activated','window-focused'].includes(e.kind));
 assert.equal(focus.length,0,'Browser focus changed during test; inspect events before attributing');
 log('PASS',{connections:states.length,fixedTab:initial.tabId,totalTabs:initial.tabCount,extraTabs:0,groups:0,connectionPages:0,browserFocusEvents:focus.length});
}catch(error){failed=true;log('FAIL',{error:String(error.stack).replaceAll(token,'<redacted>')});}
finally{for(const r of runtimes)await r.detach();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));process.exitCode=failed?1:0;}
