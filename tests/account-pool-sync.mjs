import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PoolReplica, mergeRecords, validatePacket, MARKER } from '../src/account-pool-sync-core.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pool-sync-test-'));
const jwt = value => `test.${Buffer.from(JSON.stringify(value)).toString('base64url')}.test`;
function login(root, slot, email='same@example.invalid', removed=false) {
  const dir = path.join(root,slot); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'auth.json'), JSON.stringify({tokens:{access_token:jwt({'https://api.openai.com/profile':{email}}),id_token:jwt({email}),account_id:email,refresh_token:'FAKE_SECRET_NEVER_SYNC'}}));
  if(removed) fs.writeFileSync(path.join(dir,MARKER),'{}');
}
function fixture(site) {
  const root=temp(), homes=path.join(root,'homes');fs.mkdirSync(homes);
  const logs=[];const make=()=>new PoolReplica({site,homesRoot:homes,dataRoot:root,log:(event,data)=>logs.push({event,...data}),protectLast:false,backup:file=>{fs.copyFileSync(file,file+'.test-backup');return true;}});
  return {root,homes,logs,make};
}
const exchange = (a,b) => {a.reconcile();b.reconcile();a.receive(b.packet());b.receive(a.packet());a.receive(b.packet());};

test('identity merge handles different slot names, duplicates and excludes all credentials',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'acct3');login(B.homes,'yy-acct3');login(B.homes,'acct3',undefined,true);
 const a=A.make(),b=B.make();exchange(a,b);assert.equal(Object.keys(a.state.records).length,1);assert.deepEqual(a.packet().records,b.packet().records);
 const wire=JSON.stringify(a.packet());assert.ok(!/SECRET|token|email|@|homes|acct3/.test(wire));assert.equal(fs.existsSync(path.join(B.homes,'acct3',MARKER)),true);
});
test('remove and restore propagate both directions; credentials remain byte-identical',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'a');login(B.homes,'b');const auth=fs.readFileSync(path.join(B.homes,'b/auth.json'));
 const a=A.make(),b=B.make();exchange(a,b);fs.writeFileSync(path.join(A.homes,'a',MARKER),'{}');exchange(a,b);assert.ok(fs.existsSync(path.join(B.homes,'b',MARKER)));
 fs.renameSync(path.join(B.homes,'b',MARKER),path.join(B.homes,'b/restored.fixture'));exchange(a,b);assert.ok(!fs.existsSync(path.join(A.homes,'a',MARKER)));assert.deepEqual(fs.readFileSync(path.join(B.homes,'b/auth.json')),auth);
});
test('concurrent remove wins, later explicit restore wins; associative commutative idempotent merge',()=>{
 const key='a'.repeat(64);const add={ [key]:[{clock:[1,0],removed:false}] },del={ [key]:[{clock:[0,1],removed:true}] },restore={ [key]:[{clock:[1,2],removed:false}] };
 const ab=mergeRecords(add,del);assert.ok(ab[key].some(e=>e.removed));assert.deepEqual(mergeRecords(ab,restore),restore);
 for(const x of [add,del,restore])for(const y of [add,del,restore])for(const z of [add,del,restore]) {
  assert.deepEqual(mergeRecords(x,y),mergeRecords(y,x));assert.deepEqual(mergeRecords(x,x),x);
  assert.deepEqual(mergeRecords(mergeRecords(x,y),z),mergeRecords(x,mergeRecords(y,z)));
 }
});
test('offline changes survive daemon restart and missing auth never resurrects/removes membership',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'a');login(B.homes,'b');let a=A.make(),b=B.make();exchange(a,b);
 fs.writeFileSync(path.join(A.homes,'a',MARKER),'{}');a.reconcile();a=A.make();b=B.make();exchange(a,b);assert.ok(fs.existsSync(path.join(B.homes,'b',MARKER)));
 fs.renameSync(path.join(B.homes,'b/auth.json'),path.join(B.homes,'b/auth.fixture'));b.reconcile();assert.ok(b.status().pending.some(e=>e.reason==='local-login-missing'));assert.deepEqual(b.packet().records,a.packet().records);
});
test('new account is pending local login, not credential copy or phantom slot',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'a');const a=A.make(),b=B.make();exchange(a,b);
 assert.equal(fs.readdirSync(B.homes).length,0);assert.equal(b.status().pending[0].reason,'local-login-missing');login(B.homes,'other');exchange(a,b);assert.equal(b.status().pending.length,0);
});
test('login reappearance after missing credentials is an explicit restore',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'a');login(B.homes,'b');const a=A.make(),b=B.make();exchange(a,b);
 fs.renameSync(path.join(B.homes,'b/auth.json'),path.join(B.homes,'b/auth.fixture'));b.reconcile();fs.writeFileSync(path.join(A.homes,'a',MARKER),'{}');exchange(a,b);
 fs.renameSync(path.join(B.homes,'b/auth.fixture'),path.join(B.homes,'b/auth.json'));exchange(a,b);assert.ok(!fs.existsSync(path.join(A.homes,'a',MARKER)));assert.ok(!Object.values(b.packet().records)[0].some(e=>e.removed));
});
test('partial auth write pauses reconciliation; token refresh is not a membership event',()=>{
 const A=fixture('yangyong');login(A.homes,'a');const a=A.make();a.reconcile();const before=a.packet(),file=path.join(A.homes,'a/auth.json'),raw=fs.readFileSync(file,'utf8');fs.writeFileSync(file,'{');assert.throws(()=>a.reconcile(),/auth-invalid/);assert.deepEqual(a.packet(),before);
 fs.writeFileSync(file,raw.replace('FAKE_SECRET_NEVER_SYNC','FAKE_REFRESHED'));a.reconcile();assert.deepEqual(a.packet(),before);
});
test('invalid wire schema, unknown machines, credential fields and corrupt durable state fail closed',()=>{
 for(const packet of [{},{version:1,site:'third-host',records:{}},{version:1,site:'yangyong',records:{},tokens:'secret'},{version:1,site:'yangyong',records:{['x'.repeat(64)]:[]}}])assert.throws(()=>validatePacket(packet));
 const A=fixture('yangyong');login(A.homes,'a');const a=A.make();a.reconcile();fs.writeFileSync(a.stateFile,'{');assert.throws(()=>A.make(),/state-invalid/);
});
test('failed backup never restores marker and recovery retries journal without false local edits',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'a',undefined,true);login(B.homes,'b',undefined,true);const a=A.make(),b=B.make();exchange(a,b);
 fs.renameSync(path.join(A.homes,'a',MARKER),path.join(A.homes,'a/restored.fixture'));a.reconcile();b.backup=()=>{throw new Error('backup-failed')};assert.throws(()=>b.receive(a.packet()),/backup-failed/);assert.ok(fs.existsSync(path.join(B.homes,'b',MARKER)));
 const restarted=B.make();restarted.reconcile();assert.ok(!fs.existsSync(path.join(B.homes,'b',MARKER)));assert.deepEqual(restarted.packet().records,a.packet().records);
});
test('last account and local pin are deferred without losing the remote removal record',()=>{
 const A=fixture('yangyong'),B=fixture('desktop-3egb4lb');login(A.homes,'a');login(B.homes,'b');const a=A.make(),b=B.make();b.protectLast=true;exchange(a,b);
 fs.writeFileSync(path.join(A.homes,'a',MARKER),'{}');exchange(a,b);assert.ok(!fs.existsSync(path.join(B.homes,'b',MARKER)));assert.equal(b.status().pending[0].reason,'last-local-member');
 login(B.homes,'c','reserve@example.invalid');fs.writeFileSync(path.join(B.root,'account-pool-pin.json'),JSON.stringify({autoRotate:false,account:'b'}));b.reconcile();assert.equal(b.status().pending[0].reason,'locally-pinned');
 fs.renameSync(path.join(B.root,'account-pool-pin.json'),path.join(B.root,'pin.fixture'));b.reconcile();assert.ok(fs.existsSync(path.join(B.homes,'b',MARKER)));
});
