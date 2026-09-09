import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectSweepRoots,saveRestartHandoff,consumeRestartHandoff} from '../src/restart-state.mjs';
const options={home:'D:/Pi',data:'D:/Pi/data',selfPid:100,parentPid:90,bridgeOwned:true,webInternalPort:30140};
const p=(pid,parent,cmd,name='node.exe')=>({ProcessId:pid,ParentProcessId:parent,CommandLine:cmd,Name:name});
const processes=[p(90,80,'D:/Pi/pi-portable-launcher.exe','pi-portable-launcher.exe'),p(100,90,'node D:/Pi/src/launcher.mjs'),
 p(110,100,'D:/Pi/pi-portable-launcher.exe --pi-node-host D:/Pi/app/node_modules/@agegr/pi-web/bin/pi-web.js','pi-portable-launcher.exe'),
 p(111,110,'node D:/Pi/app/node_modules/@agegr/pi-web/bin/pi-web.js'),p(112,111,'node D:/Pi/releases/v1/node_modules/next/dist/bin/next start -p 30140'),
 p(120,100,'node D:/Pi/src/bridge/codex-responses-proxy.mjs'),p(130,100,'powershell -File D:/Pi/src/tray.ps1','powershell.exe'),
 p(140,100,'thorium --app=http://127.0.0.1:30141/','thorium.exe'),p(150,100,'msedge --user-data-dir=D:/Pi/data/browser-profile','msedge.exe'),
 p(160,4,'node D:/other/server.mjs'),p(161,4,'node D:/PiOther/src/launcher.mjs'),p(162,4,'powershell -File D:/Pi/scratch/test.ps1','powershell.exe')];
test('deduplicates owned trees, preserves host/ancestors/daily browser/unrelated PIDs',()=>{
 const result=selectSweepRoots(processes,options);
 assert.deepEqual(result.roots,[110,120,130,150]);
 assert.deepEqual(result.pids,[110,111,112,120,130,150]);
 assert(result.protectedPids.includes(90));assert(result.protectedPids.includes(140));
});
test('external bridge and its ancestors remain protected; orphan Pi web is discoverable',()=>{
 const result=selectSweepRoots([...processes,p(200,1,'node D:/Pi/src/piweb-ui-proxy.mjs')],{...options,bridgeOwned:false});
 assert(!result.pids.includes(120));assert(result.roots.includes(200));
});
test('Windows paths and casing match, but a daily browser beneath an old launcher protects its ancestors',()=>{
 const rows=[...processes,p(210,1,'node d:\\pi\\src\\launcher.mjs'),p(211,210,'chrome --profile-directory=Default','chrome.exe')];
 const result=selectSweepRoots(rows,options);assert(!result.roots.includes(210));assert(!result.pids.includes(211));
});
test('restart handoff is single-use, supervisor-bound and expires with an unconditional reason log',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-restart-ticket-'));const logs=[];
 const ticket={at:10000,supervisorPid:90,openWindow:true,swept:true,ports:[30140,30141,30142,8794]};
 saveRestartHandoff(dir,ticket);
 assert.equal(consumeRestartHandoff(dir,{parentPid:91,now:10001,log:x=>logs.push(x)}),null);
 assert.deepEqual(consumeRestartHandoff(dir,{parentPid:90,now:10002}),ticket);
 assert.equal(consumeRestartHandoff(dir,{parentPid:90,now:10003}),null);
 saveRestartHandoff(dir,ticket);
 assert.equal(consumeRestartHandoff(dir,{parentPid:90,now:70001,log:x=>logs.push(x)}),null);
 fs.writeFileSync(path.join(dir,'restart-handoff.json'),'{malformed');
 assert.equal(consumeRestartHandoff(dir,{parentPid:90,now:10004,log:x=>logs.push(x)}),null);
 assert.equal(logs.length,3);
});
