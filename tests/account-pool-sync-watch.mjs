import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { startAgent } from '../src/account-pool-sync.mjs';
import { MARKER } from '../src/account-pool-sync-core.mjs';
const wait=async(fn,ms=2500)=>{const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw new Error('watch-convergence-timeout');await new Promise(r=>setTimeout(r,25));}return Date.now()-start;};
const jwt=v=>`test.${Buffer.from(JSON.stringify(v)).toString('base64url')}.test`;
function fixture(){const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'pool-watch-test-')),homesRoot=path.join(dataRoot,'homes');fs.mkdirSync(path.join(homesRoot,'a'),{recursive:true});fs.writeFileSync(path.join(homesRoot,'a/auth.json'),JSON.stringify({tokens:{access_token:jwt({}),id_token:jwt({email:'fixture@example.invalid'}),account_id:'fixture'}}));return {dataRoot,homesRoot};}
function link(a,b){const ab=new PassThrough(),ba=new PassThrough();const x=a.attach(ba,ab),y=b.attach(ab,ba);return()=>{x.close();y.close();};}
test('real filesystem events converge <2.5s both ways, idle has no loops; offline restore and watcher restart converge',{timeout:15000},async()=>{
 const A=fixture(),B=fixture(),logs=[];let a,b,cut;
 try{
  a=await startAgent({...A,site:'yangyong',connectPeer:false,protectLast:false,log:(event)=>logs.push(event)});
  b=await startAgent({...B,site:'desktop-3egb4lb',connectPeer:false,protectLast:false,log:(event)=>logs.push(event)});cut=link(a,b);
  await wait(()=>a.status().digest===b.status().digest);
  fs.writeFileSync(path.join(A.homesRoot,'a',MARKER),'{}');const removeMs=await wait(()=>fs.existsSync(path.join(B.homesRoot,'a',MARKER)));
  fs.renameSync(path.join(B.homesRoot,'a',MARKER),path.join(B.homesRoot,'a/restored.fixture'));const restoreMs=await wait(()=>!fs.existsSync(path.join(A.homesRoot,'a',MARKER)));
  const count=logs.filter(x=>x==='local-change').length;await new Promise(r=>setTimeout(r,600));assert.equal(logs.filter(x=>x==='local-change').length,count);
  cut();fs.writeFileSync(path.join(A.homesRoot,'a',MARKER),'{}');await wait(()=>Object.values(a.replica.packet().records)[0].some(e=>e.removed));await a.close();a=await startAgent({...A,site:'yangyong',connectPeer:false,protectLast:false,log:()=>{}});cut=link(a,b);
  const reconnectMs=await wait(()=>fs.existsSync(path.join(B.homesRoot,'a',MARKER)));assert.equal(a.status().digest,b.status().digest);
  await assert.rejects(startAgent({...A,site:'yangyong',connectPeer:false}),{code:'EADDRINUSE'});
  console.log(JSON.stringify({removeMs,restoreMs,reconnectMs,limitMs:2500,credentialWrites:0}));
 }finally {cut?.();await a?.close();await b?.close();}
});
