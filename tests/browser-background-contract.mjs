import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {patchBackgroundBootstrap} from '../src/browser-agent/background-mcp-patch.mjs';
import {backgroundConfig} from '../src/browser-agent/vendor/playwright-extension/pi-background-config.mjs';
import {createFixedTabStore,FIXED_TAB_KEY,retireConnectionPages} from '../src/browser-agent/vendor/playwright-extension/pi-background-tab.mjs';
import {parseBackgroundInvitation} from '../src/browser-agent/vendor/playwright-extension/pi-background-service.mjs';
const vendor=new URL('../src/browser-agent/vendor/playwright-extension/',import.meta.url);
const manifest=JSON.parse(await fs.readFile(new URL('manifest.json',vendor),'utf8'));
const extensionId=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).split('').map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
assert.equal(extensionId,backgroundConfig.extensionId);
assert(!manifest.permissions.includes('offscreen'));
assert(!manifest.permissions.includes('storage'),'No new permission grants needed');
assert.equal(manifest.minimum_chrome_version,'110');
assert.equal(manifest.update_url,undefined);
const source=await fs.readFile(new URL('lib/background.mjs',vendor),'utf8');
assert(!source.includes('chrome.windows.update('));
assert(!source.includes('chrome.tabs.group('));
assert(!source.includes('chrome.tabGroups.update('));
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
const ownUrl=`chrome-extension://${extensionId}/connect.html`;
const invite=ownUrl+'?mcpRelayUrl='+encodeURIComponent('ws://127.0.0.1:50001/extension/test')+'&protocolVersion=2';
assert.equal(parseBackgroundInvitation(invite).clientName,'Pi Thorium');
assert.throws(()=>parseBackgroundInvitation(invite.replace('127.0.0.1','example.com')),/Rejected non-local/);
assert.throws(()=>parseBackgroundInvitation(invite.replace('Version=2','Version=3')),/Unsupported/);
let nextId=10,created=0;let windows=[{id:7,focused:true}];
const tabs=new Map([[1,{id:1,url:ownUrl+'?old',active:false,pinned:true}],[2,{id:2,url:ownUrl+'?active',active:true,pinned:true}],[3,{id:3,url:'https://example.com/user',active:false,pinned:false}]]);
const storage={};const calls=[];const event={addListener(){},removeListener(){}};
const api={
 runtime:{getURL:p=>`chrome-extension://${extensionId}/${p}`,onMessage:event},
 storage:{local:{get:async key=>({[key]:storage[key]}),set:async data=>Object.assign(storage,data)}},
 windows:{getAll:async()=>windows},
 action:{onClicked:event,setBadgeText:async()=>{},setTitle:async()=>{},setBadgeBackgroundColor:async()=>{}},
 tabGroups:{query:async()=>[]},
 debugger:{detach:async()=>{},attach:async()=>{},sendCommand:async()=>({}),onEvent:event,onDetach:event},
 tabs:{onUpdated:event,onRemoved:event,onCreated:event,
  get:async id=>{if(!tabs.has(id))throw new Error('No tab');return {...tabs.get(id)};},
  query:async filter=>[...tabs.values()].filter(t=>!filter.url||t.url.startsWith(ownUrl)).map(t=>({...t})),
  update:async(id,args)=>{assert.equal(args.active,undefined);calls.push(['update',id,args]);Object.assign(tabs.get(id),args);return {...tabs.get(id)};},
  create:async args=>{assert.equal(args.active,false);created++;const tab={id:++nextId,...args};tabs.set(tab.id,tab);return {...tab};},
  remove:async id=>{calls.push(['remove',id]);tabs.delete(id);},
  ungroup:async()=>{},
 },
};
const identity={get:async()=>storage[FIXED_TAB_KEY],set:async id=>{storage[FIXED_TAB_KEY]=id;}};
const store=createFixedTabStore(api,identity);
const fixed=await store.ensure();
assert.equal(fixed.id,2);assert.equal(fixed.url,'about:blank');assert.equal(created,0);
assert.equal(await retireConnectionPages(fixed.id,api),1);assert(tabs.has(3),'Never remove user websites');
for(let i=0;i<5;i++)assert.equal((await createFixedTabStore(api,identity).ensure()).id,2,'Stable across worker/store recreation');
await api.tabs.update(2,{url:'https://example.com/work'});
assert.equal((await store.ensure()).url,'https://example.com/work','Reconnect must retain website and DOM');
assert.equal(storage[FIXED_TAB_KEY],2);
tabs.delete(2);
const recovered=await store.ensure();assert.equal(created,1);assert.notEqual(recovered.id,3);
assert.equal((await store.ensure()).id,recovered.id);
tabs.delete(recovered.id);windows=[];
await assert.rejects(store.ensure(),/No existing normal/);assert.equal(created,1);
windows=[{id:7}];
// A query/get race must not discard a user page that has navigated away.
const query=api.tabs.query;
api.tabs.query=async filter=>filter.url?[{id:3,url:ownUrl}]:query(filter);
assert.equal(await retireConnectionPages(999,api),0);assert(tabs.has(3));api.tabs.query=query;
// Execute the actual vendor classes, not a substitute implementation.
const classes=new Function('chrome','createFixedTabStore','retireConnectionPages','startBackgroundService','WebSocket',
 source.replace(/^import .*;\r?\n/gm,'').replace('new PlaywrightExtension();','')+';return {RelayConnection,ConnectedTabGroup,PlaywrightExtension};'
)(api,()=>store,id=>retireConnectionPages(id,api),()=>{}, {OPEN:1});
const sent=[];const ws={readyState:1,send:x=>sent.push(JSON.parse(x)),close(){}};
const relay=new classes.RelayConnection(ws);
for(const method of ['chrome.tabs.create','chrome.tabs.remove'])await assert.rejects(relay._handleCommand({method,params:[{}]}),/Single fixed-tab/);
for(const method of ['Target.createTarget','Target.closeTarget','Page.close'])await assert.rejects(relay._handleCommand({method:'chrome.debugger.sendCommand',params:[{},method]}),/Single fixed-tab/);
assert.deepEqual(await relay._handleCommand({method:'chrome.debugger.sendCommand',params:[{},'Page.bringToFront']}),{});
const group=new classes.ConnectedTabGroup(relay,{id:3},'test',{},()=>false);
relay._notifyTabAttached(3);
await group._addTabToGroup(3);
group._onTabUpdated(3,{url:'https://example.com/next',groupId:4},{id:3,groupId:4});
assert.deepEqual(group.connectedTabIds(),[3],'User group edits must not detach the fixed tab');
group.close('test');assert(tabs.has(3),'Disconnect must preserve tab');
const extension=new classes.PlaywrightExtension();
extension._backgroundStarting=true;
await assert.rejects(extension._connectBackground({}),/busy/);
extension._backgroundStarting=false;extension._connections.set(1,{});
await assert.rejects(extension._connectBackground({}),/busy/);
assert.equal(created,1,'Denied connection must not create a tab');
console.log('PASS singleton tab migration/reconnect/recovery/ownership, no grouping or foreground activation, busy rejection, CDP lifecycle guards');
await import('./browser-worker-contract.mjs');
