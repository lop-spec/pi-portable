// Standalone zero-model pool replication plus missing-login provisioning.
// One persistent SSH session, no browser, OAuth, model or agent API calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PoolReplica, SITES, MARKER, atomicJson } from './account-pool-sync-core.mjs';
import { LoginTransfer, validateMessage, ipcSecret } from './account-pool-sync-login.mjs';
import { appendLineRotating } from './log-rotate.mjs';

const self=fileURLToPath(import.meta.url);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const reason=e=>/^[a-z][a-z0-9-]*$/.test(e?.message)?e.message:(e?.code||'operation-failed');
export const pipeFor=dataRoot=>process.platform==='win32'?`\\\\.\\pipe\\pi-pool-sync-${sha(path.resolve(dataRoot).toLowerCase()).slice(0,24)}`:path.join(dataRoot,'account-pool-sync.sock');
const options=()=>{const a=process.argv.slice(3),o={};for(let i=0;i<a.length;i+=2){if(!a[i]?.startsWith('--')||!a[i+1])throw new Error('arguments-invalid');o[a[i].slice(2)]=a[i+1];}return o;};

export async function discover(dataRoot) {
  if(process.env.CODEX_ACCOUNT_HOMES) {
    if(!fs.existsSync(process.env.CODEX_ACCOUNT_HOMES))throw new Error('configured-pool-missing');
    return {homesRoot:process.env.CODEX_ACCOUNT_HOMES,primaryAuthFile:process.env.CODEX_PRIMARY_AUTH_FILE};
  }
  // Read-only bridge health is the source of truth, not a guessed home layout.
  const health=await fetch(`http://127.0.0.1:${Number(process.env.CODEX_PROXY_PORT||8794)}/health`,{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)throw new Error('bridge-health-failed');return r.json();});
  if(!health.ok||!health.accountHomes||!fs.statSync(health.accountHomes).isDirectory())throw new Error('pool-not-enabled');
  const primary=process.env.CODEX_PRIMARY_AUTH_FILE||path.resolve(health.accountHomes,'../../../homes/primary/auth.json');
  return {homesRoot:health.accountHomes,primaryAuthFile:fs.existsSync(primary)?primary:undefined};
}

export async function startAgent({site,homesRoot,primaryAuthFile,dataRoot,connectPeer=true,log,debounceMs=200,intervalMs=15000,protectLast=true}) {
  if(!SITES.includes(site))throw new Error('site-invalid');
  fs.mkdirSync(dataRoot,{recursive:true});
  const dir=path.join(dataRoot,'account-pool-sync');fs.mkdirSync(dir,{recursive:true});
  log ||= (event,fields={})=>{
    const result=appendLineRotating(path.join(dir,'sync.log'),JSON.stringify({at:new Date().toISOString(),event,...fields}),{maxBytes:1024*1024,keep:3});
    if(!result.ok)process.stderr.write('pool-sync log-write-failed\n');
  };
  const channels=new Set(),watchers=[];let closed=false,debounce,heartbeat,ssh,retryTimer,tries=0,lastPeerAt=null,error=null;
  let replica,transfer,secret,lastDigest='',statusRaw='';
  const server=net.createServer(authenticate);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipeFor(dataRoot),resolve);});
  try {replica=new PoolReplica({site,homesRoot,primaryAuthFile,dataRoot,log,protectLast});replica.reconcile();transfer=new LoginTransfer(replica,{log});secret=ipcSecret(dataRoot,{create:true});}
  catch(e){server.close();throw e;}
  server.on('error',e=>log('ipc-error',{reason:reason(e)}));
  function authenticate(socket){
    let buffer='';
    const reject=()=>{log('ipc-rejected',{reason:'local-auth-required'});socket.destroy();};
    socket.setTimeout(5000,reject);socket.on('error',()=>{log('ipc-error',{reason:'local-handshake-failed'});socket.destroy();});
    const hello=chunk=>{
      buffer+=chunk.toString('utf8');const end=buffer.indexOf('\n');
      if((end<0?buffer.length:end)>200){reject();return;}if(end<0)return;
      let value;try{value=JSON.parse(buffer.slice(0,end));}catch{reject();return;}
      if(!value||Object.keys(value).join(',')!=='ipcAuth'||typeof value.ipcAuth!=='string'||!/^[a-f0-9]{64}$/.test(value.ipcAuth)||!crypto.timingSafeEqual(Buffer.from(value.ipcAuth,'utf8'),Buffer.from(secret,'utf8'))){reject();return;}
      socket.pause();socket.off('data',hello);socket.setTimeout(0);socket.off('timeout',reject);
      attach(socket,socket);if(buffer.length>end+1)socket.unshift(Buffer.from(buffer.slice(end+1)));buffer='';socket.resume();
    };
    socket.on('data',hello);
  }
  function status() {
    const value={...replica.status(),protocolVersion:2,loginSync:'create-missing-only',pid:process.pid,connected:channels.size>0&&!!lastPeerAt&&Date.now()-Date.parse(lastPeerAt)<45000,lastPeerAt,error};
    const raw=JSON.stringify(value);if(raw!==statusRaw){atomicJson(path.join(dir,'status.json'),value);statusRaw=raw;}
    return value;
  }
  function send(channel,message) {
    if(channel.closed)return;
    if(channel.output.writableLength>2*1024*1024){log('link-error',{reason:'peer-backpressure'});channel.close();return;}
    try {channel.output.write(JSON.stringify(message||transfer.metadata())+'\n');}
    catch(e){error=reason(e);log('send-deferred',{reason:error});}
  }
  function broadcast(force=false) {
    try {
      const message=transfer.metadata(),digest=sha(JSON.stringify(message));
      if(force||digest!==lastDigest){lastDigest=digest;for(const c of channels)send(c,message);}
    }catch(e){error=reason(e);log('broadcast-deferred',{reason:error});}
    status();
  }
  function reconcile() {
    if(closed)return;
    try {replica.reconcile();if(error)log('recovered',{reason:error});error=null;broadcast();}
    catch(e){error=reason(e);log('reconcile-deferred',{reason:error});status();}
  }
  function schedule(){if(closed)return;clearTimeout(debounce);debounce=setTimeout(reconcile,debounceMs);}
  function attach(input,output,onClose=()=>{}) {
    let buffer='';
    const c={input,output,wanted:new Map(),closed:false,close(){if(c.closed)return;c.closed=true;channels.delete(c);input.off('data',receive);input.destroy();if(output!==input)output.destroy();onClose();if(replica)status();}};
    function receive(chunk) {
      buffer+=chunk.toString('utf8');
      if(buffer.length>2*1024*1024){log('link-error',{reason:'packet-too-large'});c.close();return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0&&!c.closed) {
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try {
          let packet;try{packet=JSON.parse(line);}catch{throw new Error('packet-json-invalid');}
          validateMessage(packet);if(packet.site===site)throw new Error('peer-site-mismatch');
          if(packet.kind==='members'){
            replica.receive({version:1,site:packet.site,records:packet.records});
            const wanted=transfer.wants(packet).filter(key=>Date.now()-(c.wanted.get(key)||0)>=15000);
            if(wanted.length){for(const key of wanted)c.wanted.set(key,Date.now());send(c,{version:2,site,kind:'want',keys:wanted});}
          }else if(packet.kind==='want'){
            for(const key of packet.keys){const login=transfer.provide(key);if(login)send(c,login);}
          }else{
            if(!c.wanted.has(packet.key))throw new Error('login-unsolicited');
            transfer.accept(packet);c.wanted.delete(packet.key);
          }
          lastPeerAt=new Date().toISOString();tries=0;error=null;broadcast();
        }catch(e){error=reason(e);log('receive-deferred',{reason:error});c.close();}
      }
    }
    input.on('data',receive);input.on('end',c.close);input.on('error',e=>{log('link-error',{reason:reason(e)});c.close();});
    if(output!==input)output.on('error',e=>{log('link-error',{reason:reason(e)});c.close();});
    channels.add(c);send(c);return c;
  }
  const watch=(root,filter,recursive=false)=>{
    try {const w=fs.watch(root,{recursive},(_,file)=>{if(!file||filter(String(file)))schedule();});w.on('error',e=>{log('watch-unavailable',{reason:reason(e),repair:'periodic-reconcile'});w.close();});watchers.push(w);}
    catch(e){log('watch-unavailable',{reason:reason(e),repair:'periodic-reconcile'});}
  };
  watch(homesRoot,f=>!f.includes('_历史版本')&&(path.basename(f)==='auth.json'||path.basename(f)===MARKER||!/[\\/]/.test(f)),true);
  watch(dataRoot,f=>f==='account-pool-pin.json');
  if(primaryAuthFile&&!path.resolve(primaryAuthFile).startsWith(path.resolve(homesRoot)+path.sep))watch(path.dirname(primaryAuthFile),f=>f==='auth.json');
  heartbeat=setInterval(()=>{reconcile();broadcast(true);},intervalMs);
  function dial() {
    if(closed)return;
    // Win32 Git OpenSSH multiplexing failed on the managed machines. This single
    // long-lived authenticated session is reused for ALL messages, in both directions.
    const sshFile=process.env.PI_POOL_SYNC_SSH||'C:/Program Files/Git/usr/bin/ssh.exe';
    const args=['-T','-i','C:/Users/lop/.ssh/id_ed25519','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','ControlMaster=no','-o','ControlPath=none','lop@100.98.35.74','D:/Downloads/pi-protable/runtime/node.exe D:/Downloads/pi-protable/src/account-pool-sync.mjs relay --data-root D:/Downloads/pi-protable/data'];
    ssh=spawn(sshFile,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    log('ssh-connect',{attempt:tries+1});
    let stderr='';ssh.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2048);});
    const child=ssh;const c=attach(child.stdout,child.stdin,()=>{if(child.exitCode===null)child.kill();});
    child.once('error',e=>log('ssh-error',{reason:reason(e)}));
    child.once('close',(code)=>{
      c.close();if(ssh===child)ssh=null;
      if(closed)return;
      const cause=/Permission denied/.test(stderr)?'ssh-auth-denied':/Host key verification failed/.test(stderr)?'ssh-host-key-rejected':/pool-relay-unavailable/.test(stderr)?'peer-agent-unavailable':/timed out|No route|refused/i.test(stderr)?'peer-unreachable':'ssh-channel-closed';
      const delay=Math.min(30000,2000*2**Math.min(tries++,4));log('offline',{reason:cause,exit:code,retryMs:delay});
      retryTimer=setTimeout(dial,delay);
    });
  }
  log('started',{site,homesRoot,transport:connectPeer&&site==='yangyong'?'persistent-ssh':'ssh-relay-receiver',debounceMs,repairIntervalMs:intervalMs});
  if(connectPeer&&site==='yangyong'){log('ssh-reuse',{reason:'native-multiplex-probe-failed',mode:'one-persistent-stdio-session'});dial();}
  broadcast();
  return {replica,attach,status,async close(){closed=true;clearTimeout(debounce);clearTimeout(retryTimer);clearInterval(heartbeat);for(const w of watchers)w.close();for(const c of [...channels])c.close();ssh?.kill();await new Promise(resolve=>server.close(resolve));log('stopped',{});}};
}

async function relay(dataRoot) {
  const secret=ipcSecret(dataRoot);
  const socket=net.connect(pipeFor(dataRoot));
  const timer=setTimeout(()=>socket.destroy(new Error('pool-relay-unavailable')),8000);
  socket.once('connect',()=>{clearTimeout(timer);socket.write(JSON.stringify({ipcAuth:secret})+'\n');process.stdin.pipe(socket);socket.pipe(process.stdout);});
  socket.on('error',()=>{process.stderr.write('pool-relay-unavailable\n');process.exitCode=1;});
  socket.on('close',()=>{clearTimeout(timer);process.stdin.destroy();});
  process.stdin.on('end',()=>socket.end());process.stdout.on('error',()=>socket.destroy());
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===self.toLowerCase()) {
  try {
    const cmd=process.argv[2],o=options(),dataRoot=o['data-root'];
    if(!dataRoot)throw new Error('data-root-required');
    if(cmd==='relay')await relay(dataRoot);
    else if(cmd==='status')console.log(fs.readFileSync(path.join(dataRoot,'account-pool-sync/status.json'),'utf8'));
    else if(cmd==='watch') {
      const site=os.hostname().toLowerCase();if(!SITES.includes(site))throw new Error('site-invalid');
      const layout=await discover(dataRoot);
      const agent=await startAgent({site,dataRoot,...layout});
      for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>agent.close().then(()=>process.exit(0)));
    }else throw new Error('command-invalid');
  }catch(e){
    const code=reason(e);process.stderr.write(`pool-sync ${code}\n`);
    const index=process.argv.indexOf('--data-root'),root=index>=0?process.argv[index+1]:null;
    if(root){const result=appendLineRotating(path.join(root,'account-pool-sync','sync.log'),JSON.stringify({at:new Date().toISOString(),event:'startup-deferred',reason:code}),{maxBytes:1024*1024,keep:3});if(!result.ok)process.stderr.write('pool-sync log-write-failed\n');}
    // Duplicate task starts are harmless; never take over the existing daemon.
    process.exitCode=code==='EADDRINUSE'?0:1;
  }
}
