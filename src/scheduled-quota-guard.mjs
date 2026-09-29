// Only explicitly opted-in high-frequency schedulers call this. Never an interactive hook.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readSystemProxy} from './system-proxy.mjs';
import {readAccountUsageIdentity} from './bridge/account-usage.mjs';
import {requestJson} from './quota-idle-scheduler.mjs';
import {normalizeAccount,evaluateReserve,POLICY} from './scheduled-quota-policy.mjs';
import {appendLineRotating} from './log-rotate.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.join(ROOT,'data'),WORK=path.join(DATA,'scheduled-quota');
const exec=promisify(execFile),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const authority=['lop-home','desktop-3egb4lb'].includes(os.hostname().toLowerCase());
function log(event,details){fs.mkdirSync(WORK,{recursive:true});const r=appendLineRotating(path.join(WORK,'guard.log'),JSON.stringify({at:new Date().toISOString(),machine:os.hostname(),event,...details}),{maxBytes:2097152,keep:3});if(!r.ok)throw Error('quota-log-write-failed');}
function save(file,value){const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}
async function collect(){
  // Enumerate live pool membership, not a stale copied credential directory.
  const snapshot=await requestJson('http://127.0.0.1:8794','/account-usage');
  if(!snapshot.enabled||!Array.isArray(snapshot.accounts))throw Error('quota-pool-unavailable');
  if(snapshot.accounts.some(a=>a.pinned))throw Error('pinned-pool-cannot-guarantee-multi-account-reserve');
  const require=createRequire(path.join(ROOT,'app/package.json'));
  const {fetch,ProxyAgent}=require('undici');const proxy=await readSystemProxy();
  if(!proxy)throw Error('system-proxy-unavailable');
  const dispatcher=proxy.mode==='proxy'?new ProxyAgent(`http://${proxy.host}:${proxy.port}`):undefined;
  const seen=new Set(),accounts=[],excluded=[];let cursor=0;
  async function get(identity,endpoint){
    const response=await fetch('https://chatgpt.com/backend-api/wham/'+endpoint,{dispatcher,signal:AbortSignal.timeout(12000),headers:{Authorization:`Bearer ${identity.token}`,'chatgpt-account-id':identity.accountId,originator:'codex_cli_rs','User-Agent':'codex_cli_rs/0.147.0 (Windows 10.0.19045; x86_64)',Accept:'application/json'}});
    if(!response.ok){await response.body?.cancel();throw Error('quota-http-'+response.status);}
    return response.json();
  }
  try{await Promise.all(Array.from({length:Math.min(3,snapshot.accounts.length)},async()=>{
    while(cursor<snapshot.accounts.length){const item=snapshot.accounts[cursor++];
      try{
        if(!/^[a-z0-9_-]+$/i.test(item.id))throw Error('invalid-member-id');
        const identity=readAccountUsageIdentity(path.join(DATA,'homes',item.id,'auth.json'));
        if(!identity.token||!identity.accountId)throw Error('identity-unavailable');
        const key=sha(identity.accountId);if(seen.has(key)){excluded.push({id:item.id,reason:'duplicate-identity'});continue;}seen.add(key);
        const usage=await get(identity,'usage');let cards={available_count:0,credits:[]};
        if(usage.rate_limit_reset_credits?.available_count>0){try{cards=await get(identity,'rate-limit-reset-credits');}catch{excluded.push({id:item.id,reason:'card-details-unavailable-cards-counted-as-zero'});}}
        const a=normalizeAccount({id:item.id,identityHash:key,usage,cards,autoReset:snapshot.autoReset?.enabled===true&&!snapshot.autoReset?.settingsError});
        if(a.excluded)excluded.push({id:item.id,reason:a.reason});else accounts.push(a);
      }catch(e){excluded.push({id:item.id,reason:/^quota-http-\d+$/.test(e.message)?e.message:'account-query-unavailable'});}
    }
  }));}finally{await dispatcher?.close();}
  return {accounts,excluded};
}
async function localDecision({task='check',admit=false,release}={}){
  fs.mkdirSync(WORK,{recursive:true});const lock=path.join(WORK,'admission.lock'),file=path.join(WORK,'reservations.json');
  if(fs.existsSync(lock)){const owner=JSON.parse(fs.readFileSync(lock,'utf8'));try{process.kill(owner.pid,0);return {allow:false,reason:'quota-admission-busy'};}catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(lock);}}
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});}catch(e){if(e.code==='EEXIST')return {allow:false,reason:'quota-admission-busy'};throw e;}
  try{
    const now=Date.now();let reservations=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
    if(!Array.isArray(reservations)||reservations.some(r=>!Number.isFinite(r.until)||!Number.isFinite(r.amount)||r.amount<0))throw Error('invalid-reservation-ledger');
    reservations=reservations.filter(r=>r.until>now);
    if(release){reservations=reservations.filter(r=>r.id!==release);save(file,reservations);return {released:true};}
    const {accounts,excluded}=await collect();
    const result={...evaluateReserve(accounts,{now:Date.now(),reserved:reservations.reduce((s,r)=>s+r.amount,0)}),excluded,nextResetAt:accounts.length?new Date(Math.min(...accounts.map(a=>a.resetAt))).toISOString():null,policy:'48h-event-timeline-v1'};
    if(admit&&result.allow){result.reservation=crypto.randomUUID();reservations.push({id:result.reservation,task,amount:POLICY.taskBudget,until:Date.now()+POLICY.horizonHours*3600000});save(file,reservations);}
    log(result.allow?'allow':'skip',{task,admit,...result});return result;
  }finally{fs.unlinkSync(lock);}
}
// One authority and one ledger prevent simultaneous starts on two machines spending the same surplus.
export async function checkScheduledQuota(options={}){
  const task=String(options.task||'scheduled-model').slice(0,200);
  try{
    let result;
    if(authority)result=await localDecision({...options,task});
    else{
      const payload=Buffer.from(JSON.stringify({...options,task})).toString('base64url');
      const {stdout}=await exec('ssh',['-i','C:/Users/lop/.ssh/id_ed25519','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','lop@100.98.35.74',`D:/Downloads/pi-protable/runtime/node.exe D:/Downloads/pi-protable/src/scheduled-quota-guard.mjs --request ${payload}`],{windowsHide:true,timeout:110000,maxBuffer:1048576});
      result=JSON.parse(stdout.trim());
    }
    if(!result.released)log('scheduled-quota-decision',{task,...result});
    return result;
  }catch(e){const reason=/^(quota-|system-proxy-|invalid-|pinned-)/.test(e.message)?e.message:'quota-check-unavailable';log('skip',{task,reason});return {allow:false,reason};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const i=process.argv.indexOf('--request');const options=i>=0?JSON.parse(Buffer.from(process.argv[i+1],'base64url').toString()):{task:'manual-readonly-check'};
  console.log(JSON.stringify(await checkScheduledQuota(options)));
}
