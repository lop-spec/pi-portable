// Membership only. Never serialize, copy, refresh or write any login credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SITES = ['yangyong', 'desktop-3egb4lb'];
export const MARKER = '.pi-pool-removed.json';
const SLOT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEY = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(reason); };
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v, keys) => plain(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const clockMax = events => [0,1].map(i => Math.max(0,...events.map(e=>e.clock[i])));
const dominates = (a,b) => a.every((n,i)=>n>=b[i]) && a.some((n,i)=>n>b[i]);
const removed = events => events.some(e=>e.removed);
const markerHash = file => { try {return hash(fs.readFileSync(file));} catch(e) {if(e.code==='ENOENT')return null; throw e;} };

function checkRecords(records) {
  if(!plain(records)||Object.keys(records).length>2000) fail('records-invalid');
  for(const [key,events] of Object.entries(records)) {
    if(!KEY.test(key)||!Array.isArray(events)||events.length<1||events.length>2) fail('record-invalid');
    for(const e of events) if(!exactKeys(e,['clock','removed'])||typeof e.removed!=='boolean'||!Array.isArray(e.clock)||e.clock.length!==2||!e.clock.every(n=>Number.isSafeInteger(n)&&n>=0&&n<Number.MAX_SAFE_INTEGER-1)||!e.clock.some(n=>n>0)) fail('event-invalid');
  }
}
export function validatePacket(packet) {
  if(!exactKeys(packet,['version','site','records'])||packet.version!==1||!SITES.includes(packet.site))fail('packet-invalid');
  checkRecords(packet.records);return packet;
}
// Multi-value register with two vector-clock components. Keep concurrent events;
// any concurrent removal wins. A causally later explicit restore supersedes it.
export function mergeRecords(left,right) {
  const out={};
  for(const key of [...new Set([...Object.keys(left),...Object.keys(right)])].sort()) {
    const unique=new Map();
    for(const e of [...(left[key]||[]),...(right[key]||[])]) {
      const k=e.clock.join(':');const old=unique.get(k);
      unique.set(k,{clock:[...e.clock],removed:e.removed||!!old?.removed});
    }
    const all=[...unique.values()];
    out[key]=all.filter(e=>!all.some(other=>dominates(other.clock,e.clock))).sort((a,b)=>a.clock[0]-b.clock[0]||a.clock[1]-b.clock[1]);
    if(out[key].length>2)fail('record-concurrency-invalid');
  }
  return out;
}
export function atomicJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const raw=JSON.stringify(value,null,2)+'\n',tmp=file+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(tmp,'wx',0o600);
  try {fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally {fs.closeSync(fd);}
  fs.renameSync(tmp,file);if(fs.readFileSync(file,'utf8')!==raw)fail('state-readback-mismatch');
}
function defaultBackup(file) {
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/backup.mjs',import.meta.url)),file,'--label','pool-sync-'+crypto.randomUUID()],{windowsHide:true,stdio:'pipe',timeout:10_000});
  if(r.error||r.status!==0)fail('backup-failed');
}
const claims = token => {try {return JSON.parse(Buffer.from(String(token).split('.')[1],'base64url'));}catch{return {};}};
function identity(file) {
  let auth;try {auth=JSON.parse(fs.readFileSync(file,'utf8'));}catch {return fail('auth-invalid');}
  const i=claims(auth.tokens?.id_token),a=claims(auth.tokens?.access_token),claim='https://api.openai.com/auth';
  const email=String(i.email||a['https://api.openai.com/profile']?.email||'').trim().toLowerCase();
  const accountId=String(auth.tokens?.account_id||i[claim]?.chatgpt_account_id||a[claim]?.chatgpt_account_id||'');
  if(!email||!accountId)fail('auth-identity-missing');
  return hash(JSON.stringify([email,accountId]));
}

export class PoolReplica {
  constructor({site,homesRoot,dataRoot,primaryAuthFile,log=()=>{},backup=defaultBackup,protectLast=true}) {
    if(!SITES.includes(site))fail('site-invalid');
    Object.assign(this,{site,homesRoot:fs.realpathSync(homesRoot),dataRoot,primaryAuthFile,log,backup,protectLast});
    this.stateFile=path.join(dataRoot,'account-pool-sync','state.json');this.pending=[];
    this.state={version:1,site,homesRoot:this.homesRoot,records:{},observed:{},journal:[]};
    if(fs.existsSync(this.stateFile)) {
      try {
        const s=JSON.parse(fs.readFileSync(this.stateFile,'utf8'));
        if(s.version!==1||s.site!==site||s.homesRoot!==this.homesRoot||!plain(s.observed)||!Array.isArray(s.journal))fail('state-invalid');
        checkRecords(s.records);
        if(Object.entries(s.observed).some(([k,v])=>!KEY.test(k)||typeof v!=='boolean'))fail('state-invalid');
        for(const p of s.journal)if(!exactKeys(p,['key','slot','before','removed'])||!KEY.test(p.key)||!SLOT.test(p.slot)||!(p.before===null||KEY.test(p.before))||typeof p.removed!=='boolean')fail('state-invalid');
        this.state=s;
      }catch {fail('state-invalid');}
    }
    this.saved=JSON.stringify(this.state);
  }
  save() {const raw=JSON.stringify(this.state);if(raw!==this.saved){atomicJson(this.stateFile,this.state);this.saved=raw;}}
  scan() {
    const groups=new Map();
    // Missing root / malformed partial writes are errors, not an empty pool.
    for(const entry of fs.readdirSync(this.homesRoot,{withFileTypes:true})) {
      if(!entry.isDirectory()||!SLOT.test(entry.name))continue;
      const dir=path.join(this.homesRoot,entry.name),normal=path.join(dir,'auth.json');
      if(!fs.existsSync(normal))continue;
      const auth=entry.name==='primary'&&this.primaryAuthFile?this.primaryAuthFile:normal;
      const key=identity(auth),marker=path.join(dir,MARKER),fingerprint=markerHash(marker);
      const item={slot:entry.name,marker,fingerprint};
      const list=groups.get(key)||[];list.push(item);groups.set(key,list);
    }
    for(const list of groups.values())list.sort((a,b)=>a.slot.localeCompare(b.slot));
    return groups;
  }
  observe(groups) {
    // Missing login files do not mean remove. Forget only the local observation
    // so a later explicit login is recognized as a fresh add, not an old echo.
    for(const key of Object.keys(this.state.observed))if(!groups.has(key))delete this.state.observed[key];
    for(const [key,slots] of groups) {
      const value=slots.every(s=>s.fingerprint!==null);
      if(this.state.observed[key]===value)continue;
      const clock=clockMax(this.state.records[key]||[]);clock[SITES.indexOf(this.site)]++;
      this.state.records[key]=[{clock,removed:value}];this.state.observed[key]=value;
      this.log('local-change',{key:key.slice(0,12),removed:value});
    }
  }
  recover() {
    if(!this.state.journal.length)return;
    const groups=this.scan();
    for(const p of this.state.journal) {
      const item=groups.get(p.key)?.find(s=>s.slot===p.slot);
      if(!item) {this.log('apply-skipped',{reason:'local-identity-changed',slot:p.slot});continue;}
      const current=markerHash(item.marker);
      if((current!==null)===p.removed)continue; // already applied before a crash
      if(current!==p.before) {this.log('apply-skipped',{reason:'marker-changed-during-apply',slot:p.slot});continue;}
      if(p.removed) {
        const raw=JSON.stringify({version:1,removedAt:new Date().toISOString(),credentialsPreserved:true,source:'pool-sync'});
        fs.writeFileSync(item.marker,raw,{flag:'wx',mode:0o600});
        if(fs.readFileSync(item.marker,'utf8')!==raw)fail('marker-readback-mismatch');
      } else {
        this.backup(item.marker);
        if(markerHash(item.marker)!==p.before)fail('marker-changed-during-backup');
        // Reversible move, not unlink. A separate verified physical backup exists.
        const archive=path.join(this.homesRoot,'_历史版本');fs.mkdirSync(archive,{recursive:true});
        fs.renameSync(item.marker,path.join(archive,`${p.slot}.pool-marker.${crypto.randomUUID()}.json`));
      }
      this.log('applied',{key:p.key.slice(0,12),slot:p.slot,removed:p.removed});
    }
    // Update only identities touched by this transaction, never swallow unrelated edits.
    const after=this.scan();
    for(const key of new Set(this.state.journal.map(p=>p.key))) {
      const slots=after.get(key);
      if(slots) this.state.observed[key]=slots.every(s=>s.fingerprint!==null);
    }
    this.state.journal=[];this.save();
  }
  materialize(groups) {
    let pin=null;
    const pinFile=path.join(this.dataRoot,'account-pool-pin.json');
    if(fs.existsSync(pinFile)) {let p;try{p=JSON.parse(fs.readFileSync(pinFile,'utf8'));}catch{fail('pin-invalid');}if(p.autoRotate===false)pin=p.account||'primary';}
    let active=[...groups.values()].filter(list=>list.some(s=>s.fingerprint===null)).length;
    const pending=[];const plan=[];
    // Restore before remove, so a replacement can satisfy last-member protection.
    const records=Object.entries(this.state.records).sort((a,b)=>Number(removed(a[1]))-Number(removed(b[1]))||a[0].localeCompare(b[0]));
    for(const [key,events] of records) {
      const desired=removed(events),slots=groups.get(key);
      if(!slots) {pending.push({key,removed:desired,reason:'local-login-missing'});continue;}
      const actual=slots.every(s=>s.fingerprint!==null);
      if(actual===desired)continue;
      const reason=desired&&slots.some(s=>s.slot===pin)?'locally-pinned':desired&&this.protectLast&&active<=1?'last-local-member':null;
      if(reason){pending.push({key,removed:desired,reason});continue;}
      const targets=desired?slots.filter(s=>s.fingerprint===null):[slots.find(s=>s.slot!=='primary')||slots[0]];
      for(const s of targets)plan.push({key,slot:s.slot,before:s.fingerprint,removed:desired});
      active+=desired?-1:1;
    }
    const signature=JSON.stringify(pending);
    if(signature!==JSON.stringify(this.pending)) {
      for(const p of pending)this.log('pending',{key:p.key.slice(0,12),reason:p.reason});
      if(!pending.length&&this.pending.length)this.log('pending-cleared',{});
    }
    this.pending=pending;
    if(plan.length){this.state.journal=plan;this.save();this.recover();}
  }
  reconcile() {
    this.recover();const groups=this.scan();this.observe(groups);this.save();this.materialize(groups);return this.packet();
  }
  receive(packet) {
    validatePacket(packet);if(packet.site===this.site)fail('peer-site-mismatch');
    this.reconcile();this.state.records=mergeRecords(this.state.records,packet.records);this.save();this.materialize(this.scan());return this.packet();
  }
  packet() {return {version:1,site:this.site,records:mergeRecords({},this.state.records)};}
  status() {return {site:this.site,homesRoot:this.homesRoot,records:Object.keys(this.state.records).length,digest:hash(JSON.stringify(this.packet().records)),pending:this.pending};}
}
