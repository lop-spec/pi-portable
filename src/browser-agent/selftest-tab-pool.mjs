// Offline only: no browser process, extension connection, credentials, or native CDP.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import * as stores from './vendor/playwright-extension/pi-background-tab.mjs';

function event() {
  const listeners = new Set();
  return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),fire:(...args)=>{for(const f of [...listeners])f(...args);}};
}
function fixture(saved, initial = []) {
  const tabs = new Map(initial.map(tab=>[tab.id,{windowId:1,active:false,pinned:true,url:'about:blank',...tab}]));
  const attached = new Set(), calls = [], sockets = [];
  let value = structuredClone(saved), next = 100, failWrite = false, failTargets = false;
  const storage = {get:async()=>structuredClone(value),set:async v=>{if(failWrite)throw new Error('storage unavailable');value=structuredClone(v);}};
  const api = {
    runtime:{getURL:p=>'chrome-extension://fixture/'+p,onMessage:event()},
    tabs:{onUpdated:event(),onRemoved:event(),onCreated:event(),
      query:async filter=>[...tabs.values()].filter(t=>!filter?.url||t.url.startsWith(filter.url.replace(/\*$/,''))).map(t=>({...t})),
      get:async id=>{if(!tabs.has(id))throw new Error('No tab with id '+id);return {...tabs.get(id)};},
      create:async opts=>{calls.push(['create',opts]);const tab={id:next++,status:'complete',...opts};tabs.set(tab.id,tab);return {...tab};},
      update:async(id,opts)=>{calls.push(['update',id,opts]);Object.assign(tabs.get(id),opts);return {...tabs.get(id)};},
      remove:async id=>{calls.push(['remove',id]);tabs.delete(id);api.tabs.onRemoved.fire(id);},
    },
    windows:{getAll:async()=>[{id:1,focused:true}]},
    tabGroups:{query:async()=>[]},
    action:{setBadgeText:async()=>{},setTitle:async()=>{},setBadgeBackgroundColor:async()=>{}},
    debugger:{onEvent:event(),onDetach:event(),
      getTargets:async()=>{if(failTargets)throw new Error('targets unavailable');return [...attached].map(tabId=>({tabId,attached:true}));},
      attach:async target=>{calls.push(['attach',target]);attached.add(target.tabId);},
      detach:async target=>{calls.push(['detach',target]);attached.delete(target.tabId);},
      sendCommand:async(...args)=>{calls.push(['command',...args]);return {};},
    },
  };
  class Socket {
    static OPEN = 1;
    constructor(url) {this.url=url;this.readyState=1;this.sent=[];sockets.push(this);queueMicrotask(()=>url.includes('fail')?this.onerror?.():this.onopen?.());}
    send(value){this.sent.push(JSON.parse(value));}
    close(){this.readyState=3;this.onclose?.();}
  }
  return {api,storage,tabs,attached,calls,sockets,Socket,
    get saved(){return value;},set failWrite(v){failWrite=v;},set failTargets(v){failTargets=v;},
    pool:()=>stores.createFixedTabPool(api,storage),
  };
}
async function extension(f) {
  let source = await fs.readFile(new URL('./vendor/playwright-extension/lib/background.mjs',import.meta.url),'utf8');
  source=source.replace(/^import .*;\r?\n/gm,'').replace('new PlaywrightExtension();','globalThis.fixtureClasses = {PlaywrightExtension,RelayConnection,ConnectedTabGroup};');
  const context=vm.createContext({chrome:f.api,WebSocket:f.Socket,console,setTimeout,clearTimeout,createFixedTabPool:()=>f.pool(),createFixedTabStore:()=>stores.createFixedTabStore(f.api,f.storage),retireConnectionPages:id=>stores.retireConnectionPages(id,f.api),startBackgroundService:()=>{}});
  vm.runInContext(source,context);
  return context.fixtureClasses;
}
const settle = () => new Promise(resolve=>setImmediate(resolve));

test('pool contract exists',()=>assert.equal(typeof stores.createFixedTabPool,'function'));
test('migrates and reuses the idle owned tab, never an ordinary user tab',async()=>{
  const f=fixture(7,[{id:7},{id:8}]),p=f.pool();
  assert.equal((await p.acquire('A')).id,7);
  assert.deepEqual(f.saved,{version:2,tabIds:[7],origins:{7:'about:blank'}});
  assert.equal(f.calls.length,0);
});
test('a pooled tab that someone else navigated while idle is abandoned untouched',async()=>{
  const f=fixture({version:2,tabIds:[7,8],origins:{7:'https://chatgpt.com',8:'https://chatgpt.com'}},[{id:7,url:'https://zq7zwf7c9ls.feishu.cn/ai/projects'},{id:8,url:'https://chatgpt.com/?temporary-chat=true'}]);
  const a=await f.pool().acquire('A');
  assert.equal(a.id,8,'the tab still on its released origin is reused');
  assert.deepEqual(f.saved.tabIds,[8],'the navigated tab is no longer a pool identity');
  assert.equal(f.calls.filter(c=>c[1]===7).length,0,'the navigated tab is never updated, cleared or closed');
  assert.equal(f.tabs.get(7).url,'https://zq7zwf7c9ls.feishu.cn/ai/projects');
});
test('an owned tab with no origin record on an ordinary page is abandoned, blank ones stay usable',async()=>{
  const f=fixture({version:2,tabIds:[7,8]},[{id:7,url:'https://example.test/'},{id:8}]);
  assert.equal((await f.pool().acquire('A')).id,8);
  assert.deepEqual(f.saved.tabIds,[8]);
  assert.equal(f.calls.filter(c=>c[1]===7).length,0);
});
test('release records the origin and a reloaded pool reuses the same-origin tab',async()=>{
  const f=fixture({version:2,tabIds:[7]},[{id:7}]),p=f.pool();
  assert.equal((await p.acquire('A')).id,7);
  f.tabs.get(7).url='https://chatgpt.com/c/abc';
  assert.equal(p.release('A'),true);
  assert.equal((await p.acquire('B')).id,7,'same pool instance sees the record');
  assert.equal(f.saved.origins[7],'https://chatgpt.com');
  p.release('B');await settle();
  assert.equal((await f.pool().acquire('C')).id,7,'a fresh pool instance (worker reload) trusts the persisted record');
  f.tabs.get(7).url='https://auth.openai.com/login';
  assert.notEqual((await f.pool().acquire('D')).id,7,'an origin change after the record is foreign');
});
test('a discarded pooled tab is skipped but not abandoned',async()=>{
  const f=fixture({version:2,tabIds:[7]},[{id:7,discarded:true}]);
  assert.notEqual((await f.pool().acquire('A')).id,7);
  assert.ok(f.saved.tabIds.includes(7));
});
test('parallel clients get different background tabs, release permits reuse',async()=>{
  const f=fixture(7,[{id:7}]),p=f.pool();
  const [a,b,c]=await Promise.all(['A','B','C'].map(id=>p.acquire(id)));
  assert.equal(new Set([a.id,b.id,c.id]).size,3);
  assert.equal(f.calls.filter(c=>c[0]==='create').length,2);
  for(const call of f.calls.filter(c=>c[0]==='create'))assert.equal(call[1].active,false);
  assert.equal(p.release('unknown'),false);
  assert.equal(p.release('A'),true);
  assert.equal((await p.acquire('D')).id,a.id);
  assert.equal((await p.acquire('B')).id,b.id);
});
test('does not reuse a managed tab the user is viewing',async()=>{
  const f=fixture(7,[{id:7,active:true}]),p=f.pool();
  assert.notEqual((await p.acquire('A')).id,7);
  assert.equal(f.tabs.get(7).active,true);
  assert.equal(f.calls.filter(c=>c[0]==='update'&&c[1]===7).length,0);
});
test('does not reuse a tab still attached to another debugger after worker reload',async()=>{
  const f=fixture(7,[{id:7}]);f.attached.add(7);
  assert.notEqual((await f.pool().acquire('A')).id,7);
});
test('reloaded pool reuses persistent idle entries before creating anything',async()=>{
  const f=fixture({version:2,tabIds:[7,8]},[{id:7,active:true},{id:8},{id:9}]);
  assert.equal((await f.pool().acquire('A')).id,8);
  assert.equal(f.calls.length,0);
});
test('a closed managed tab is pruned without adopting an unrelated user tab',async()=>{
  const f=fixture({version:2,tabIds:[7,8]},[{id:8},{id:9}]);
  assert.equal((await f.pool().acquire('A')).id,8);
  assert.deepEqual(f.saved.tabIds,[8]);
});
test('uncertain debugger state fails closed and does not create a tab',async()=>{
  const f=fixture(7,[{id:7}]);f.failTargets=true;
  await assert.rejects(f.pool().acquire('A'),/targets unavailable/);
  assert.equal(f.calls.length,0);
});
test('storage write failure does not leak a lease or repeatedly create new tabs',async()=>{
  const f=fixture(),p=f.pool();f.failWrite=true;
  await assert.rejects(p.acquire('A'),/storage unavailable/);
  const created=f.calls.filter(c=>c[0]==='create').length;
  f.failWrite=false;
  const a=await p.acquire('A');
  assert.ok(f.saved.tabIds.includes(a.id));
  assert.ok(f.calls.filter(c=>c[0]==='create').length<=Math.max(1,created));
});
test('no normal window means no browser/window is launched',async()=>{
  const f=fixture();f.api.windows.getAll=async()=>[];
  await assert.rejects(f.pool().acquire('A'),/No existing normal/);
  assert.equal(f.calls.length,0);
});
test('corrupt identity data is not overwritten or silently treated as an empty pool',async()=>{
  const f=fixture({version:99,tabIds:[7]});
  await assert.rejects(f.pool().acquire('A'),/identity/i);
  assert.deepEqual(f.saved,{version:99,tabIds:[7]});
  assert.equal(f.calls.length,0);
});
test('legacy single-tab implementation cannot overwrite the new pool identity',async()=>{
  const f=fixture({version:2,tabIds:[7]},[{id:7}]);
  await assert.rejects(stores.createFixedTabStore(f.api,f.storage).ensure(),/reload/i);
  assert.deepEqual(f.saved,{version:2,tabIds:[7]});
});
test('extension permits simultaneous clients without sharing their tab',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  const [a,b]=await Promise.all(['A','B'].map(id=>e._connectBackground({relayUrl:'ws://127.0.0.1/'+id,clientName:id})));
  assert.notEqual(a.tabId,b.tabId);
  assert.equal(e._connections.size,2);
  for(const g of [...e._connections.values()])await g.close('test complete');
  assert.equal(e._connections.size,0);
});
test('duplicate invitation for an active relay is idempotent',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  const invitation={relayUrl:'ws://127.0.0.1/A',clientName:'A'};
  const [a,b]=await Promise.all([e._connectBackground(invitation),e._connectBackground(invitation)]);
  assert.equal(a.tabId,b.tabId);
  assert.equal(f.sockets.length,1);
  for(const g of [...e._connections.values()])await g.close('test complete');
});
test('failed relay connection releases its claim for the next client',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  await assert.rejects(e._connectBackground({relayUrl:'ws://127.0.0.1/fail'}),/relay|WebSocket/i);
  const a=await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  assert.equal(a.tabId,7);
  assert.equal(f.sockets[0].readyState,3);
  for(const g of [...e._connections.values()])await g.close('test complete');
});
test('debugger commands cannot attach, detach, or navigate another client tab',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  const a=await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const g=[...e._connections.values()][0],c=g._connection;
  for(const method of ['chrome.debugger.attach','chrome.debugger.detach','chrome.debugger.sendCommand'])
    await assert.rejects(c._handleCommand({method,params:[{tabId:a.tabId+1},'Page.navigate',{}]}),/owned|leased/i);
  await c._handleCommand({method:'chrome.debugger.attach',params:[{tabId:a.tabId},'1.3']});
  assert.ok(f.attached.has(a.tabId));
  await g.close('test complete');
});
test('disconnect keeps a tab reserved until debugger detach has finished',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  const a=await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const g=[...e._connections.values()][0];
  await g._connection._handleCommand({method:'chrome.debugger.attach',params:[{tabId:a.tabId},'1.3']});
  let finish;
  f.api.debugger.detach=()=>new Promise(resolve=>{finish=()=>{f.attached.delete(a.tabId);resolve();};});
  const closing=g.close('test complete');await settle();
  assert.equal(e._connections.size,1);
  const b=await e._connectBackground({relayUrl:'ws://127.0.0.1/B'});
  assert.notEqual(a.tabId,b.tabId);
  finish();await closing;
  const c=await e._connectBackground({relayUrl:'ws://127.0.0.1/C'});
  assert.equal(c.tabId,a.tabId);
  for(const group of [...e._connections.values()])await group.close('test complete');
});
test('closed connections cannot issue commands after their lease is released',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const g=[...e._connections.values()][0];await g.close('test complete');
  await assert.rejects(g._connection._handleCommand({method:'chrome.debugger.attach',params:[{tabId:7},'1.3']}),/closed/i);
});
test('an attach still in flight at disconnect is drained before lease release',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const g=[...e._connections.values()][0];
  let finish;
  f.api.debugger.attach=()=>new Promise(resolve=>{finish=()=>{f.attached.add(7);resolve();};});
  const attaching=g._connection._handleCommand({method:'chrome.debugger.attach',params:[{tabId:7},'1.3']});
  const closing=g.close('test complete');await settle();
  assert.equal(e._connections.size,1);
  const b=await e._connectBackground({relayUrl:'ws://127.0.0.1/B'});
  assert.notEqual(b.tabId,7);
  finish();await attaching;await closing;
  assert.equal(f.attached.has(7),false);
  for(const group of [...e._connections.values()])await group.close('test complete');
});
test('a failed detach does not make an attached tab reusable',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const g=[...e._connections.values()][0];
  await g._connection._handleCommand({method:'chrome.debugger.attach',params:[{tabId:7},'1.3']});
  f.api.debugger.detach=async()=>{throw new Error('detach failed');};
  await g.close('test complete');
  const b=await e._connectBackground({relayUrl:'ws://127.0.0.1/B'});
  assert.notEqual(b.tabId,7);
  for(const group of [...e._connections.values()])await group.close('test complete');
});
test('events from one client are never delivered to another client',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  const a=await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const b=await e._connectBackground({relayUrl:'ws://127.0.0.1/B'});
  const groups=[...e._connections.values()];
  for(const [i,id] of [a.tabId,b.tabId].entries())await groups[i]._connection._handleCommand({method:'chrome.debugger.attach',params:[{tabId:id},'1.3']});
  for(const socket of f.sockets)socket.sent.length=0;
  f.api.debugger.onEvent.fire({tabId:a.tabId},'Runtime.consoleAPICalled',{type:'log'});
  assert.equal(f.sockets[0].sent.length,1);
  assert.equal(f.sockets[1].sent.length,0);
  for(const group of groups)await group.close('test complete');
});
test('a user activation during allocation refuses takeover and is recoverable',async()=>{
  const f=fixture(7,[{id:7}]),p=f.pool(),get=f.api.tabs.get;
  f.api.tabs.get=async id=>{f.tabs.get(id).active=true;return get(id);};
  await assert.rejects(p.acquire('A'),/user-active/);
  f.api.tabs.get=get;
  assert.notEqual((await p.acquire('B')).id,7);
});
test('client tab lifecycle and foreground commands stay restricted',async()=>{
  const f=fixture(7,[{id:7}]),{PlaywrightExtension}=await extension(f),e=new PlaywrightExtension();
  await e._connectBackground({relayUrl:'ws://127.0.0.1/A'});
  const g=[...e._connections.values()][0],c=g._connection;
  for(const method of ['chrome.tabs.create','chrome.tabs.remove'])await assert.rejects(c._handleCommand({method,params:[]}),/fixed.tab/i);
  for(const command of ['Target.createTarget','Target.closeTarget','Page.close'])await assert.rejects(c._handleCommand({method:'chrome.debugger.sendCommand',params:[{tabId:7},command,{}]}),/fixed.tab/i);
  await c._handleCommand({method:'chrome.debugger.sendCommand',params:[{tabId:7},'Page.bringToFront',{}]});
  assert.equal(f.calls.filter(c=>c[0]==='command').length,0);
  await g.close('test complete');
});
