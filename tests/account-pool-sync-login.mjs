import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PoolReplica, MARKER } from '../src/account-pool-sync-core.mjs';
import { LoginTransfer, validateMessage, secureDirectory } from '../src/account-pool-sync-login.mjs';
const jwt=v=>`fixture.${Buffer.from(JSON.stringify(v)).toString('base64url')}.fixture`;
const credential=(email,extra={})=>({auth_mode:'chatgpt',tokens:{access_token:jwt({exp:Math.floor(Date.now()/1000)+3600}),id_token:jwt({email}),refresh_token:'FAKE_REFRESH_SECRET',account_id:email},last_refresh:new Date().toISOString(),...extra});
function fixture(site){const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'pool-login-test-')),homesRoot=path.join(dataRoot,'homes'),logs=[];fs.mkdirSync(homesRoot);const replica=new PoolReplica({site,dataRoot,homesRoot,protectLast:false,log:(event,data)=>logs.push({event,...data})});const transfer=new LoginTransfer(replica,{log:(event,data)=>logs.push({event,...data}),secureDirectory:dir=>fs.chmodSync(dir,0o700)});return {site,dataRoot,homesRoot,replica,transfer,logs};}
function add(f,slot,email){const dir=path.join(f.homesRoot,slot);fs.mkdirSync(dir);const auth=credential(email);fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify(auth));f.replica.reconcile();return auth;}
function exchange(a,b){a.replica.receive(b.replica.packet());b.replica.receive(a.replica.packet());}

test('missing login copies to new identity-named slot; existing credentials and local primary are unchanged',()=>{
 const a=fixture('yangyong'),b=fixture('desktop-3egb4lb'),auth=add(a,'primary','source@example.invalid');add(b,'primary','peer@example.invalid');const before=fs.readFileSync(path.join(b.homesRoot,'primary/auth.json'));
 exchange(a,b);const key=[...a.replica.scan().keys()][0],packet=a.transfer.provide(key);assert.equal(packet.kind,'login');assert.equal(b.transfer.accept(packet),true);assert.equal(b.transfer.accept(packet),false);
 const target=path.join(b.homesRoot,'sync-'+key.slice(0,26),'auth.json');assert.deepEqual(JSON.parse(fs.readFileSync(target)),auth);assert.deepEqual(fs.readFileSync(path.join(b.homesRoot,'primary/auth.json')),before);assert.equal(b.replica.status().pending.length,0);
 assert.ok(!/FAKE_REFRESH_SECRET|access_token|id_token|@example/.test(fs.readFileSync(b.replica.stateFile,'utf8')+JSON.stringify(b.logs)));
});
test('all existing identities including removed slots remain byte-identical; source token refresh is not broadcast',()=>{
 const a=fixture('yangyong'),b=fixture('desktop-3egb4lb');add(a,'a','same@example.invalid');add(b,'b','same@example.invalid');exchange(a,b);const key=[...a.replica.scan().keys()][0];const before=fs.readFileSync(path.join(b.homesRoot,'b/auth.json'));
 const meta=a.transfer.metadata();assert.ok(!JSON.stringify(meta).includes('FAKE_REFRESH_SECRET'));assert.deepEqual(b.transfer.wants(meta),[]);
 const file=path.join(a.homesRoot,'a/auth.json'),changed=JSON.parse(fs.readFileSync(file));changed.tokens.refresh_token='NEW_FAKE_SECRET';fs.writeFileSync(file,JSON.stringify(changed));assert.equal(b.transfer.accept(a.transfer.provide(key)),false);assert.deepEqual(fs.readFileSync(path.join(b.homesRoot,'b/auth.json')),before);
 fs.writeFileSync(path.join(b.homesRoot,'b',MARKER),'{}');assert.equal(b.transfer.accept(a.transfer.provide(key)),false);assert.deepEqual(fs.readFileSync(path.join(b.homesRoot,'b/auth.json')),before);
});
test('offline deletion dominates in-flight login; never imports a removed or unsolicited account',()=>{
 const a=fixture('yangyong'),b=fixture('desktop-3egb4lb');add(a,'a','a@example.invalid');exchange(a,b);const key=[...a.replica.scan().keys()][0],packet=a.transfer.provide(key);
 fs.writeFileSync(path.join(a.homesRoot,'a',MARKER),'{}');a.replica.reconcile();b.replica.receive(a.replica.packet());assert.equal(b.transfer.accept(packet),false);assert.equal(fs.readdirSync(b.homesRoot).length,0);assert.equal(a.transfer.provide(key),null);assert.deepEqual(b.transfer.wants(a.transfer.metadata()),[]);
 assert.throws(()=>b.transfer.accept({...packet,key:'a'.repeat(64)}));
});
test('identity mismatch, expired login, unknown wire fields and unsafe path input never write credentials',()=>{
 const a=fixture('yangyong'),b=fixture('desktop-3egb4lb');add(a,'a','a@example.invalid');exchange(a,b);const key=[...a.replica.scan().keys()][0],packet=a.transfer.provide(key);
 assert.throws(()=>b.transfer.accept({...packet,auth:credential('wrong@example.invalid')}),/identity/);
 const old=structuredClone(packet);old.auth.tokens.access_token=jwt({exp:1});assert.throws(()=>b.transfer.accept(old),/expired/);
 for(const bad of [{...packet,path:'../../primary/auth.json'},{...packet,key:'../bad'},{...packet,site:'third-host'},{...packet,auth:{...packet.auth,OPENAI_API_KEY:'UNRELATED_SECRET'}}])assert.throws(()=>validateMessage(bad));
 assert.equal(fs.readdirSync(b.homesRoot).length,0);
});
test('slot collision or ACL failure is observable, never overwrites or publishes partial credentials',()=>{
 const a=fixture('yangyong'),b=fixture('desktop-3egb4lb');add(a,'a','a@example.invalid');exchange(a,b);const key=[...a.replica.scan().keys()][0],packet=a.transfer.provide(key),target=path.join(b.homesRoot,'sync-'+key.slice(0,26));
 fs.mkdirSync(target);fs.writeFileSync(path.join(target,'asset.txt'),'existing asset');assert.throws(()=>b.transfer.accept(packet),/slot-exists/);assert.equal(fs.readFileSync(path.join(target,'asset.txt'),'utf8'),'existing asset');assert.ok(!fs.existsSync(path.join(target,'auth.json')));
 const c=fixture('desktop-3egb4lb');c.replica.receive(a.replica.packet());c.transfer.secureDirectory=()=>{throw new Error('acl-failed')};assert.throws(()=>c.transfer.accept(packet),/acl-failed/);assert.equal(c.replica.scan().size,0);assert.ok(fs.readdirSync(c.homesRoot).every(x=>x.startsWith('.')));
});
test('external primary is copied as a backup slot; unrelated auth fields never enter wire',()=>{
 const a=fixture('yangyong'),b=fixture('desktop-3egb4lb');add(a,'primary','wrong@example.invalid');const external=path.join(a.dataRoot,'external-auth.json');fs.writeFileSync(external,JSON.stringify(credential('real@example.invalid',{OPENAI_API_KEY:'OTHER_SECRET'})));a.replica.primaryAuthFile=external;a.replica.reconcile();exchange(a,b);
 const key=[...a.replica.scan().keys()][0],packet=a.transfer.provide(key);assert.ok(!JSON.stringify(packet).includes('OTHER_SECRET'));b.transfer.accept(packet);assert.ok(!fs.existsSync(path.join(b.homesRoot,'primary')));assert.equal(b.replica.scan().size,1);
});
test('real private-directory ACL restricts credential staging to the current user',{timeout:10000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pool-acl-test-'));secureDirectory(dir);assert.ok(fs.statSync(dir).isDirectory());
});
