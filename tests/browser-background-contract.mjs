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
  tabs:{onActivated:event,create:async args=>{calls.push(args);return {id:55};}},
  windows:{onFocusChanged:event,getAll:async()=>windows},
};
try {
  await import(new URL('pi-background-service.mjs?contract',vendor));
  const sender={id:extensionId,url:chrome.runtime.getURL('pi-background.html')};
  const url=chrome.runtime.getURL('connect.html')+'?mcpRelayUrl='+encodeURIComponent('ws://127.0.0.1:50001/extension/test');
  const invoke=(message,s=sender)=>new Promise(resolve=>handlers[0](message,s,resolve));
  assert.equal((await invoke({type:'pi-background-connect',url})).success,true);
  assert.deepEqual(calls,[{windowId:7,url,active:false}]);
  windows=[];
  assert.equal((await invoke({type:'pi-background-connect',url})).success,false);
  assert.equal(calls.length,1,'No normal window must fail closed, not launch one');
  assert.equal((await invoke({type:'pi-background-connect',url},{...sender,id:'untrusted'})).success,false);
  console.log('PASS original extension identity, offscreen lifecycle, background tab creation, CDP activation suppression, upstream patch guard, invalid sender/no-window fail-closed');
}finally{delete globalThis.chrome;}
