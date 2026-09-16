// Additive Codex login provisioning, explicitly authorized for the managed pair.
// Secrets exist only in memory, SSH stdin/stdout and new ACL-protected auth files.
// Never overwrite existing credentials, replicate refreshed tokens, or log payloads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityFromAuth, SITES, validatePacket } from './account-pool-sync-core.mjs';
const KEY=/^[a-f0-9]{64}$/;
const fail=reason=>{throw new Error(reason);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const keys=v=>Array.isArray(v)&&v.length<=2000&&v.every(k=>typeof k==='string'&&KEY.test(k))&&new Set(v).size===v.length;
const removed=events=>!events||events.some(e=>e.removed);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function checkAuth(auth){
  if(!exact(auth,['auth_mode','tokens','last_refresh'])||auth.auth_mode!=='chatgpt'||!exact(auth.tokens,['access_token','id_token','refresh_token','account_id'])||!Object.values(auth.tokens).every(t=>typeof t==='string'&&t.length>0&&t.length<=32768)||!(auth.last_refresh===null||typeof auth.last_refresh==='string'&&Number.isFinite(Date.parse(auth.last_refresh))))fail('login-shape-invalid');
}
function unexpired(auth){
  let exp;try{exp=JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1],'base64url')).exp;}catch{fail('login-expired-or-invalid');}
  if(!Number.isFinite(exp)||exp*1000<=Date.now()+60_000)fail('login-expired-or-invalid');
}
export function validateMessage(m){
  if(!plain(m)||m.version!==2||!SITES.includes(m.site))fail('message-invalid');
  if(m.kind==='members'){
    if(!exact(m,['version','site','kind','records','have'])||!keys(m.have))fail('members-invalid');
    validatePacket({version:1,site:m.site,records:m.records});
  }else if(m.kind==='want'){
    if(!exact(m,['version','site','kind','keys'])||!keys(m.keys)||m.keys.length>10)fail('want-invalid');
  }else if(m.kind==='login'){
    if(!exact(m,['version','site','kind','key','auth'])||!KEY.test(m.key))fail('login-message-invalid');checkAuth(m.auth);
  }else fail('message-kind-invalid');
  return m;
}
export function secureDirectory(dir){
  if(process.platform!=='win32'){fs.chmodSync(dir,0o700);if((fs.statSync(dir).mode&0o777)!==0o700)fail('acl-readback-failed');return;}
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../tools/secure-pool-sync-dir.ps1',import.meta.url)),'-Directory',dir],{windowsHide:true,stdio:'pipe',timeout:10000,encoding:'utf8'});
  if(r.error||r.status!==0||!r.stdout.includes('ACL_OK_CURRENT_USER_ONLY'))fail('acl-failed');
}
function writeNew(file,raw){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(hash(fs.readFileSync(file))!==hash(raw))fail('login-readback-failed');}
export function ipcSecret(dataRoot,{create=false}={}){
  const dir=path.join(dataRoot,'account-pool-sync','private'),file=path.join(dir,'ipc.key');
  if(create&&!fs.existsSync(file)){
    if(!fs.existsSync(dir))fs.mkdirSync(dir,{mode:0o700});
    secureDirectory(dir);writeNew(file,crypto.randomBytes(32).toString('hex'));
  }
  let secret;try{secret=fs.readFileSync(file,'utf8');}catch{fail('ipc-secret-unavailable');}
  if(!KEY.test(secret))fail('ipc-secret-invalid');return secret;
}
export class LoginTransfer {
  constructor(replica,{log=replica.log,secureDirectory:secure=secureDirectory}={}){this.replica=replica;this.log=log;this.secureDirectory=secure;}
  metadata(){const p=this.replica.packet();return {...p,version:2,kind:'members',have:[...this.replica.scan().keys()].sort()};}
  wants(peer){validateMessage(peer);if(peer.kind!=='members')fail('members-required');const have=this.replica.scan();return peer.have.filter(key=>!have.has(key)&&!removed(this.replica.state.records[key])).slice(0,10);}
  provide(key){
    if(!KEY.test(key))fail('login-key-invalid');
    this.replica.reconcile();
    if(removed(this.replica.state.records[key])){this.log('login-skipped',{key:key.slice(0,12),reason:'removed-or-unknown'});return null;}
    const slots=this.replica.scan().get(key)?.filter(s=>s.fingerprint===null)||[];
    if(!slots.length){this.log('login-skipped',{key:key.slice(0,12),reason:'source-login-missing'});return null;}
    // Read fresh credentials on request; heartbeat packets never carry tokens.
    let auth;
    for(const slot of slots){
      try{
        const value=JSON.parse(fs.readFileSync(slot.authPath,'utf8'));
        const selected={auth_mode:'chatgpt',tokens:Object.fromEntries(['access_token','id_token','refresh_token','account_id'].map(k=>[k,value.tokens?.[k]])),last_refresh:value.last_refresh||null};
        checkAuth(selected);unexpired(selected);if(identityFromAuth(selected)!==key)fail('login-identity-changed');auth=selected;break;
      }catch{this.log('login-skipped',{key:key.slice(0,12),reason:'source-login-invalid-or-expired'});}
    }
    return auth?{version:2,site:this.replica.site,kind:'login',key,auth}:null;
  }
  accept(message){
    validateMessage(message);if(message.kind!=='login'||message.site===this.replica.site)fail('login-peer-invalid');
    const {key,auth}=message;
    if(identityFromAuth(auth)!==key)fail('login-identity-mismatch');
    if(this.replica.scan().has(key)){this.log('login-skipped',{key:key.slice(0,12),reason:'existing-login-preserved'});return false;}
    if(removed(this.replica.state.records[key])){this.log('login-skipped',{key:key.slice(0,12),reason:'removed-or-unknown'});return false;}
    unexpired(auth);
    const slot='sync-'+key.slice(0,26),target=path.join(this.replica.homesRoot,slot);
    if(fs.existsSync(target))fail('login-slot-exists');
    // Dot-prefixed staging is invisible to both bridge membership and login UI.
    // The entire directory is published atomically only after ACL and byte readback.
    const stage=path.join(this.replica.homesRoot,'.pool-login-'+crypto.randomUUID());
    fs.mkdirSync(stage,{mode:0o700});this.secureDirectory(stage);
    writeNew(path.join(stage,'auth.json'),JSON.stringify(auth,null,2)+'\n');
    if(this.replica.scan().has(key)||fs.existsSync(target))fail('login-slot-exists');
    // Do not mint a local membership event for a remotely provisioned credential.
    this.replica.state.observed[key]=false;this.replica.save();
    fs.renameSync(stage,target);
    if(identityFromAuth(JSON.parse(fs.readFileSync(path.join(target,'auth.json'),'utf8')))!==key)fail('login-readback-failed');
    this.replica.reconcile();this.log('login-provisioned',{key:key.slice(0,12),slot});return true;
  }
}
