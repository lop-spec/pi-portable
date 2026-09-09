import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {patchBackgroundBootstrap} from '../src/browser-agent/background-mcp-patch.mjs';
import {backgroundConfig} from '../src/browser-agent/vendor/playwright-extension/pi-background-config.mjs';
const vendor=new URL('../src/browser-agent/vendor/playwright-extension/',import.meta.url);
const manifest=JSON.parse(await fs.readFile(new URL('manifest.json',vendor),'utf8'));
const extensionId=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).split('').map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
assert.equal(extensionId,backgroundConfig.extensionId);
assert(manifest.permissions.includes('offscreen'));
assert.equal(manifest.update_url,undefined,'Store updates must not silently restore foreground behavior');
const source=await fs.readFile(new URL('lib/background.mjs',vendor),'utf8');
assert(!source.includes('chrome.windows.update('));
assert(source.includes('active: false'));
assert(source.includes('["Page.bringToFront", "Target.activateTarget"].includes(args[1])'));
const fixture=`class Relay {
      async _openConnectPageInBrowser(clientName) {
        const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
        const href = url3.toString();
        (0, import_child_process6.spawn)(executablePath, args, {
          windowsHide: true,
          detached: true,
          shell: false,
          stdio: "ignore"
        });
      }
      stop() {}
}`;
const changed=patchBackgroundBootstrap(fixture);
assert(changed.includes('await globalThis.__piOpenBackgroundExtension(href)'));
assert(!changed.includes('.spawn)'));
assert.throws(()=>patchBackgroundBootstrap(fixture.replace('stdio: "ignore"','stdio: "pipe"')),/refusing foreground fallback/);
assert.throws(()=>patchBackgroundBootstrap('unknown upstream'),/Unsupported/);
const handlers=[];const calls=[];let windows=[{id:7,focused:true}];
const event={addListener(){}};
globalThis.chrome={
  runtime:{id:extensionId,getURL:p=>`chrome-extension://${extensionId}/${p}`,getContexts:async()=>[{}],onInstalled:event,onStartup:event,onMessage:{addListener:f=>handlers.push(f)},sendMessage:async()=>{}},
  offscreen:{createDocument:async()=>{throw new Error('Existing offscreen document must be reused');}},
  tabs:{onActivated:event,query:async()=>[],create:async args=>{calls.push(args);return {id:55};}},
  windows:{onFocusChanged:event,getAll:async()=>windows},
};
try {
  await import(new URL('pi-background-service.mjs?contract',vendor));
  const sender={id:extensionId,url:chrome.runtime.getURL('pi-background.html')};
  const url=chrome.runtime.getURL('connect.html')+'?mcpRelayUrl='+encodeURIComponent('ws://127.0.0.1:50001/extension/test');
  const invoke=(message,s=sender)=>new Promise(resolve=>handlers[0](message,s,resolve));
  assert.equal((await invoke({type:'pi-background-connect',url})).success,true);
  assert.deepEqual(calls,[{windowId:7,url,active:false,pinned:true}]);
  windows=[];
  assert.equal((await invoke({type:'pi-background-connect',url})).success,false);
  assert.equal(calls.length,1,'No normal window must fail closed, not launch one');
  assert.equal((await invoke({type:'pi-background-connect',url},{...sender,id:'untrusted'})).success,false);
  const ownUrl=chrome.runtime.getURL('connect.html');
  const tabs=new Map([
    [1,{id:1,url:ownUrl+'?connection=old',pinned:false}],
    [2,{id:2,url:ownUrl+'?connection=pinned',pinned:true}],
    [3,{id:3,url:'https://example.com/Welcome',pinned:false}],
    [4,{id:4,url:chrome.runtime.getURL('status.html'),pinned:false}],
    [5,{id:5,url:'https://example.com/navigated',pinned:false}],
  ]);
  const updates=[];
  chrome.tabs.query=async filter=>{
    assert.deepEqual(filter,{url:ownUrl+'*'});
    return [...tabs.values()].map(tab=>tab.id===5?{...tab,url:ownUrl}:tab);
  };
  chrome.tabs.get=async id=>tabs.get(id);
  chrome.tabs.update=async (id,options)=>{
    assert.deepEqual(options,{pinned:true},'Pinning must not activate or navigate');
    updates.push(id); Object.assign(tabs.get(id),options); return tabs.get(id);
  };
  assert((await fs.readFile(new URL('connect.html',vendor),'utf8')).includes('src="/pi-background-pin.mjs"'));
  const pinModule=await import(new URL('pi-background-pin.mjs?contract',vendor));
  assert.equal(await pinModule.pinConnectionTabs(),1);
  assert.deepEqual(updates,[1],'Only owned, unpinned connection pages may change');
  tabs.set(6,{id:6,url:ownUrl+'?connection=reconnect',pinned:false});
  assert.equal(await pinModule.pinConnectionTabs(),1);
  assert.deepEqual(updates,[1,6]);
  assert.equal(await pinModule.pinConnectionTabs(),0,'Already pinned pages are no-ops');
  tabs.set(7,{id:7,url:ownUrl,pinned:false});
  chrome.tabs.update=async()=>{throw new Error('pin rejected');};
  await assert.rejects(pinModule.pinConnectionTabs(),/pin rejected/);
  tabs.delete(7);
  chrome.runtime.sendMessage=async()=>({ready:true});
  assert.equal(await pinModule.initializePinning(),0);
  chrome.runtime.sendMessage=async()=>undefined;
  await assert.rejects(pinModule.initializePinning(),/reload the extension once/);
  assert(!(await fs.readFile(new URL('pi-background-pin.mjs',vendor),'utf8')).includes('chrome.runtime.reload('),'Connection pages must not interrupt other clients with automatic reloads');
  // Execute the actual vendor grouping implementation: a connection page must
  // stay pinned, while navigation to an ordinary page restores normal grouping.
  let groupTab={id:1,url:ownUrl,pinned:false};let grouped=0;
  const groupApi={...chrome,tabs:{
    get:async()=>groupTab,
    update:async(id,options)=>{assert.deepEqual(options,{pinned:true});groupTab.pinned=true;return groupTab;},
    group:async()=>{grouped++;groupTab.pinned=false;return 99;},
  },tabGroups:{update:async()=>{}}};
  const start=source.indexOf('var ConnectedTabGroup = class');
  assert(start>=0,'Vendor class boundary must match');
  const Group=new Function('chrome','isConnectionPage','retryOnDrag','CONNECTED_BADGE',source.slice(start,source.indexOf('async function ungroupTabs',start))+';return ConnectedTabGroup;')(groupApi,pinModule.isConnectionPage,fn=>fn(),{});
  const group=Object.create(Group.prototype);
  Object.assign(group,{_groupId:null,_groupTabIds:new Set(),groupStyle:{},_connection:{attachedTabs:new Set([1]),detachTab:id=>group._connection.attachedTabs.delete(id)}});
  await group._addTabToGroup(1);
  assert.equal(grouped,0);assert.equal(groupTab.pinned,true);
  assert.deepEqual(group.connectedTabIds(),[1],'Ungrouped control pages must remain connection-owned');
  let navigationRegrouped=false;
  group._updateBadge=()=>{};
  group._addTabToGroup=()=>{navigationRegrouped=true;};
  group._onTabUpdated(1,{url:'https://example.com'},groupTab);
  assert(navigationRegrouped,'Navigation must reconsider pinned control pages');
  delete group._addTabToGroup;
  groupTab={id:1,url:'https://example.com',pinned:true};
  await group._addTabToGroup(1);
  assert.equal(grouped,1);assert.equal(groupTab.pinned,false);
  group.releaseTab(1);assert.deepEqual(group.connectedTabIds(),[]);
  assert(source.includes('case "pi-connection-pinning-ready":'));
  console.log('PASS background connection, pinning/reconnect/ownership/navigation, control-page group exemption, ordinary-page regrouping, no activation');
}finally{delete globalThis.chrome;}
