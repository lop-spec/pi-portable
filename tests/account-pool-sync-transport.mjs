import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { startAgent,pipeFor } from '../src/account-pool-sync.mjs';
import { ipcSecret } from '../src/account-pool-sync-login.mjs';
const jwt=v=>`fixture.${Buffer.from(JSON.stringify(v)).toString('base64url')}.fixture`;
function fixture(email){const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'pool-transfer-test-')),homesRoot=path.join(dataRoot,'homes');fs.mkdirSync(homesRoot);const f={dataRoot,homesRoot};add(f,'original',email);return f;}
function add(f,slot,email){const dir=path.join(f.homesRoot,slot);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({tokens:{access_token:jwt({exp:Math.floor(Date.now()/1000)+3600}),id_token:jwt({email}),refresh_token:'FAKE_TRANSFER_SECRET',account_id:email}}));}
async function wait(fn,limit=5000){const t=Date.now();while(!fn()){if(Date.now()-t>limit)throw new Error('transport-convergence-timeout');await new Promise(r=>setTimeout(r,25));}return Date.now()-t;}
const link=(a,b)=>{const ab=new PassThrough(),ba=new PassThrough();const x=a.attach(ba,ab),y=b.attach(ab,ba);return ()=>{x.close();y.close();};};

test('new logins auto-copy bidirectionally through protocol; disconnected addition recovers; no secret in status/log',{timeout:20000},async()=>{
 const A=fixture('a@example.invalid'),B=fixture('b@example.invalid'),logs=[];let a,b,cut;
 try{
  a=await startAgent({...A,site:'yangyong',connectPeer:false,log:(event,data)=>logs.push({event,...data})});b=await startAgent({...B,site:'desktop-3egb4lb',connectPeer:false,log:(event,data)=>logs.push({event,...data})});
  const beforeA=fs.readFileSync(path.join(A.homesRoot,'original/auth.json')),beforeB=fs.readFileSync(path.join(B.homesRoot,'original/auth.json'));
  cut=link(a,b);const initialMs=await wait(()=>a.replica.scan().size===2&&b.replica.scan().size===2&&a.replica.pending.length===0&&b.replica.pending.length===0);
  assert.deepEqual(fs.readFileSync(path.join(A.homesRoot,'original/auth.json')),beforeA);assert.deepEqual(fs.readFileSync(path.join(B.homesRoot,'original/auth.json')),beforeB);
  cut();add(A,'offline','new@example.invalid');await wait(()=>a.replica.scan().size===3&&Object.keys(a.replica.state.records).length===3);await a.close();a=await startAgent({...A,site:'yangyong',connectPeer:false,log:(event,data)=>logs.push({event,...data})});cut=link(a,b);
  const reconnectMs=await wait(()=>b.replica.scan().size===3&&b.replica.pending.length===0);assert.equal(a.status().digest,b.status().digest);assert.ok(!/FAKE_TRANSFER_SECRET|access_token|id_token|@example/.test(JSON.stringify(logs)+JSON.stringify(a.status())+JSON.stringify(b.status())));
  const file=path.join(A.homesRoot,'original/auth.json'),raw=fs.readFileSync(file);fs.writeFileSync(file,'{');await wait(()=>!!a.status().error);fs.writeFileSync(file,raw);await wait(()=>!a.status().error);
  console.log(JSON.stringify({initialMs,reconnectMs,limitMs:5000,existingCredentialWrites:0}));
 }finally{cut?.();await a?.close();await b?.close();}
});

test('named-pipe clients receive no data before machine-local authentication; invalid Unicode auth cannot crash worker',{timeout:15000},async()=>{
 const f=fixture('private@example.invalid');const logs=[];const a=await startAgent({...f,site:'yangyong',connectPeer:false,log:(event,data)=>logs.push({event,...data})});
 try{
  for(const ipcAuth of ['f'.repeat(64),'密'.repeat(64)]){
   let bytes=0;await new Promise((resolve,reject)=>{const s=net.connect(pipeFor(f.dataRoot));const timer=setTimeout(()=>{s.destroy();reject(new Error('ipc-auth-timeout'));},2000);s.on('connect',()=>s.write(JSON.stringify({ipcAuth})+'\n'));s.on('data',x=>bytes+=x.length);s.on('error',()=>{});s.on('close',()=>{clearTimeout(timer);resolve();});});assert.equal(bytes,0);
  }
  const packet=await new Promise((resolve,reject)=>{const s=net.connect(pipeFor(f.dataRoot));const timer=setTimeout(()=>{s.destroy();reject(new Error('ipc-authorized-timeout'));},2000);let text='';s.on('connect',()=>s.write(JSON.stringify({ipcAuth:ipcSecret(f.dataRoot)})+'\n'));s.on('data',chunk=>{text+=chunk;const n=text.indexOf('\n');if(n>=0){clearTimeout(timer);s.destroy();resolve(JSON.parse(text.slice(0,n)));}});s.on('error',reject);});
  assert.equal(packet.version,2);assert.equal(packet.kind,'members');assert.ok(!JSON.stringify(packet).includes('FAKE_TRANSFER_SECRET'));assert.equal(logs.filter(l=>l.event==='ipc-rejected').length,2);
 }finally{await a.close();}
});
