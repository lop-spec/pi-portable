import assert from 'node:assert/strict';
import {createWorkerBridge} from '../src/browser-agent/vendor/playwright-extension/pi-background-worker.mjs';
import {backgroundConfig} from '../src/browser-agent/vendor/playwright-extension/pi-background-config.mjs';
const token='x'.repeat(43), timers=[], acks=[], events=[];
let heartbeat=0, opened=0;
let tickets=[{id:'test',url:`chrome-extension://${backgroundConfig.extensionId}/connect.html?token=${token}`}];
const bridge=createWorkerBridge({
  api:{runtime:{getURL:path=>'chrome-extension://test/'+path,getPlatformInfo:async()=>{heartbeat++;}}},
  later:(fn,delay)=>timers.push({fn,delay}),
  openConnection:async()=>{opened++;return {success:true,tabId:55};},
  request:async(url,options)=>{
    if(url==='chrome-extension://test/pi-background-pairing.json')return {ok:true,json:async()=>({token})};
    assert.equal(options.headers.Authorization,'Bearer '+token);
    if(url.endsWith('/ack'))acks.push(JSON.parse(options.body));
    if(url.endsWith('/event'))events.push(JSON.parse(options.body));
    return {ok:true,json:async()=>url.endsWith('/poll')?{tickets}:{ok:true}};
  },
});
await bridge.start();
assert.equal(heartbeat,1);assert.equal(opened,1);
assert.deepEqual(acks,[{id:'test',success:true,tabId:55}]);
await bridge.start();assert.equal(heartbeat,1,'Start must be idempotent');
assert.equal(timers[0].delay,1000);
await timers.shift().fn();
assert.equal(heartbeat,2);assert.equal(opened,1,'Repeated invitations must not duplicate tabs');
await bridge.event({kind:'window-focused',windowId:7});
assert.deepEqual(events,[{kind:'window-focused',windowId:7}]);
tickets=[{id:'wrong-token',url:'chrome-extension://test/connect.html?token=wrong'}];
await timers.shift().fn();
assert.equal(opened,1,'Reject unpaired invitations before opening tabs');
assert.equal(timers.at(-1).delay,5000);
console.log('PASS direct worker heartbeat, local pairing, authenticated poll/ack/events, idempotence, token rejection; no offscreen API');
