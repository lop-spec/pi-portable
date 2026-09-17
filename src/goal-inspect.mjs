// Read-only source-machine inspection; also exposed to remote Claude as a stdio MCP tool.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {requestJson} from './quota-idle-scheduler.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITES = {
  'desktop-3egb4lb': {host:'100.98.35.74', root:'D:/Downloads/pi-protable', data:'D:/Downloads/pi-protable/data', agent:'D:/Downloads/pi-protable/data/.pi/agent'},
  yangyong: {host:'100.84.69.5', root:'C:/Users/lop/Documents/claude/pi-portable', data:'C:/Users/lop/AppData/Local/pi-web/portable/data', agent:'C:/Users/lop/.pi/agent'},
};
export const HERE = os.hostname().toLowerCase();
export function site(name=HERE) { if(!SITES[name]) throw Error('Unknown managed machine: '+name); return SITES[name]; }
export const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export const textOf = m => typeof m?.content==='string' ? m.content : (m?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export const api = (route,body) => requestJson('http://127.0.0.1:30140',route,body,25000);
export function run(bin,args,{input='',env=process.env,cwd=ROOT,timeout=30000,onLine=()=>{}}={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',partial='';
    const timer=setTimeout(()=>{p.kill();reject(Error('Command timeout: '+path.basename(bin)));},timeout);
    p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
    p.stdout.on('data',s=>{out+=s;partial+=s;let i;while((i=partial.indexOf('\n'))>=0){onLine(partial.slice(0,i));partial=partial.slice(i+1)}});
    p.stderr.on('data',s=>{err=(err+s).slice(-5000)});
    p.on('error',e=>{clearTimeout(timer);reject(e)});p.stdin.on('error',e=>{if(e.code!=='EPIPE')reject(e)});
    p.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(`Command ${path.basename(bin)} exit ${code}: ${err.slice(-1500)}`));else resolve({out,err})});
    p.stdin.end(input);
  });
}
export function sshArgs(machine,command) {
  return ['-i','C:/Users/lop/.ssh/id_ed25519','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',`lop@${site(machine).host}`,command];
}
export async function onMachine(machine,args,{input='',timeout=30000,onLine}={}) {
  if(machine===HERE)return run(process.execPath,[path.join(ROOT,'src/goal-inspect.mjs'),...args],{input,timeout,onLine});
  // Paths/args are only fixed machine configuration and implementation flags, never model text.
  const s=site(machine), node=machine==='yangyong'?'node':s.root+'/runtime/node.exe';
  return run('ssh',sshArgs(machine,`${node} ${s.root}/src/goal-inspect.mjs ${args.join(' ')}`),{input,timeout,onLine});
}
function readHead(file,n=131072){const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(Math.min(n,fs.fstatSync(fd).size));fs.readSync(fd,b,0,b.length,0);return b.toString('utf8')}finally{fs.closeSync(fd)}}
export function entries(file) {
  const lines=fs.readFileSync(file,'utf8').split('\n'),out=[];
  for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;try{out.push(JSON.parse(lines[i]))}catch(e){if(i===lines.length-1){console.error('goal-inspect: incomplete in-flight tail ignored',file);break}throw e}}
  return out;
}
export function sessions() {
  const root=path.join(site().agent,'sessions'),out=[];
  for(const d of fs.readdirSync(root,{withFileTypes:true})){
    if(!d.isDirectory())continue;
    for(const f of fs.readdirSync(path.join(root,d.name))){
      if(!f.endsWith('.jsonl'))continue;
      const file=path.join(root,d.name,f),lines=readHead(file).split('\n');
      const head=JSON.parse(lines[0]);if(!head.id||!head.cwd)continue;
      if(head.cwd.replaceAll('\\','/').includes('/goal-review/'))continue;
      let first='';for(const line of lines.slice(1,-1)){const e=JSON.parse(line);if(e.type==='message'&&e.message?.role==='user'){first=textOf(e.message);break}}
      out.push({id:head.id,file,cwd:head.cwd,parentSession:head.parentSession||'',mtime:fs.statSync(file).mtimeMs,first:first.slice(0,700)});
    }
  }
  return out.sort((a,b)=>b.mtime-a.mtime);
}
export function sessionView(id) {
  const meta=sessions().find(s=>s.id===id);if(!meta)throw Error('Source Pi session not found: '+id);
  const all=entries(meta.file),byId=new Map(all.filter(e=>e.id).map(e=>[e.id,e]));
  let at=all.findLast(e=>e.id&&e.type!=='session');const branch=[],seen=new Set();
  while(at){if(seen.has(at.id))throw Error('Cyclic session branch');seen.add(at.id);branch.push(at);at=byId.get(at.parentId)}branch.reverse();
  const messages=branch.filter(e=>e.type==='message');
  const users=messages.filter(e=>e.message?.role==='user');
  const lastUser=users.at(-1),lastHuman=users.findLast(e=>!textOf(e.message).startsWith('【长目标巡检建议'));
  const compact=branch.findLast(e=>e.type==='compaction');
  const compactAt=compact?branch.indexOf(compact):-1;
  const context=compactAt>=0?branch.slice(compactAt):branch;
  return {...meta,revision:branch.at(-1)?.id||'',lastUserId:lastUser?.id||'',lastHumanId:lastHuman?.id||'',lastHumanAt:lastHuman?.timestamp||'',lastHuman:textOf(lastHuman?.message),lastStopReason:messages.findLast(e=>e.message?.role==='assistant')?.message.stopReason,
    name:all.findLast(e=>e.type==='session_info')?.name||'',summary:compact?.summary||'',context,users:users.map(e=>({id:e.id,text:textOf(e.message)}))};
}
const blockedPath=/(?:^|[\\/])(?:\.ssh|\.env(?:\.[^\\/]*)?|\.credentials\.json|auth\.json|account-pool\.json|secret|secrets|[^\\/]*token[^\\/]*|[^\\/]*credentials[^\\/]*)(?:[\\/]|$)|\.(?:pem|key|pfx|p12)$/i;
export function safePath(file) {
  const abs=fs.realpathSync.native(path.resolve(file)),norm=abs.replaceAll('\\','/').toLowerCase();
  const s=site(),roots=['D:/Documents','C:/Users/lop/Documents',path.join(s.agent,'sessions'),path.join(s.agent,'skills'),path.join(s.data,'goal-review')].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync.native(p).replaceAll('\\','/').toLowerCase());
  const exact=[path.join(s.data,'长目标清单.md'),path.join(s.agent,'AGENTS.md')].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync.native(p).replaceAll('\\','/').toLowerCase());
  if(blockedPath.test(abs)||(!exact.includes(norm)&&!roots.some(r=>norm===r||norm.startsWith(r+'/'))))throw Error('Read outside approved project/history roots or credential path denied');
  return abs;
}
export function pageText(text,offset=0,limit=40000){offset=Math.max(0,Number(offset)||0);limit=Math.min(60000,Math.max(1000,Number(limit)||40000));return {text:text.slice(offset,offset+limit),offset,next:offset+limit<text.length?offset+limit:null,totalChars:text.length};}
export function recentReviewAdvice(users){return users.filter(u=>u.text.startsWith('【长目标巡检建议')).slice(-3);}
const searchableFile=/\.(?:md|txt|log|json|jsonl|ya?ml|toml|ini|conf|xml|[cm]?js|jsx|tsx?|py|go|rs|c|h|cpp|hpp|cs|java|kt|vue|svelte|css|scss|html|sql|sh|ps1|vbs)$/i;
const searchIgnoredDirs=new Set(['.git','node_modules','.venv','venv','__pycache__','target','dist','build','_历史版本']);
export function searchProject(a){
  const root=safePath(a.path);
  if(typeof a.query!=='string'||!a.query||a.query.length>300)throw Error('Search needs a literal query (1..300 chars)');
  const offset=Math.max(0,Math.floor(Number(a.offset)||0)),limit=Math.min(60000,Math.max(1000,Math.floor(Number(a.limit)||40000)));
  const until=Date.now()+15000,skipped={sensitive:0,symlink:0,generated:0,unsupported:0,oversize:0};
  let scannedFiles=0,visited=0,total=0,text='',reason=null;
  function* files(file){
    if(reason)return;
    if(Date.now()>until||++visited>20000){reason='search-budget-reached; narrow path';return}
    if(blockedPath.test(file)){skipped.sensitive++;return}
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()){skipped.symlink++;return}
    if(stat.isDirectory()){
      if(searchIgnoredDirs.has(path.basename(file))){skipped.generated++;return}
      for(const name of fs.readdirSync(file).sort()){yield* files(path.join(file,name));if(reason)return}
    }else if(stat.isFile()){
      if(!searchableFile.test(file)){skipped.unsupported++;return}
      if(stat.size>32*1024*1024){skipped.oversize++;return}
      // Validate every candidate, not only the initial directory. Never recursively grep credentials.
      yield safePath(file);
    }
  }
  outer:for(const file of files(root)){
    scannedFiles++;let lineNo=0;
    for(const line of fs.readFileSync(file,'utf8').split('\n')){
      lineNo++;if(Date.now()>until){reason='search-budget-reached; narrow path';break outer}
      const match=line.indexOf(a.query);if(match<0)continue;
      const from=Math.max(0,match-200),excerpt=line.slice(from,from+1000);
      const row=`${file}:${lineNo}:${from?'…':''}${excerpt}${from+1000<line.length?'… [line excerpt; use read]':''}\n`;
      const begin=total;total+=row.length;
      if(total>offset&&begin<offset+limit)text+=row.slice(Math.max(0,offset-begin),Math.min(row.length,offset+limit-begin));
      if(total>offset+limit){reason='page-limit';break outer}
    }
  }
  const next=reason==='page-limit'?offset+limit:null;
  return {path:root,text,offset,next,totalChars:reason?null:total,complete:!reason,reason,scannedFiles,skipped};
}
export async function processes() {
  const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'tools/goal-processes.ps1')],{timeout:15000});return JSON.parse(r.out.replace(/^\uFEFF/,''));
}
export async function inspect(a) {
  if(a.op==='catalog')return {machine:HERE,goalFile:path.join(site().data,'长目标清单.md'),sessions:sessions(),running:await api('/api/agent/running'),processes:await processes()};
  if(a.op==='session'){const s=sessionView(a.id);const {context,users,summary,...meta}=s;const runtime=await api('/api/agent/'+a.id);if(runtime.state)delete runtime.state.systemPrompt;const section=a.section||'context';const text=section==='summary'?summary:JSON.stringify(section==='recent'?context.slice(-20):section==='users'?users:context);return {...meta,section,hasSummary:!!summary,...(section==='recent'?{recentAdvice:recentReviewAdvice(users)}:{}),...pageText(text,a.offset,a.limit),runtime};}
  if(a.op==='runtime'){if(!a.id)return {running:await api('/api/agent/running'),processes:await processes()};const v=await api('/api/agent/'+a.id);if(v.state)delete v.state.systemPrompt;return {session:v,processes:await processes()};}
  if(a.op==='read'){const file=safePath(a.path);const stat=fs.statSync(file);if(stat.size>32*1024*1024)throw Error('Use a smaller report/log; file exceeds 32MiB');return {path:file,mtime:stat.mtimeMs,...pageText(fs.readFileSync(file,'utf8'),a.offset,a.limit)};}
  if(a.op==='list'){const root=safePath(a.path);const list=fs.readdirSync(root,{withFileTypes:true}).filter(d=>!blockedPath.test(path.join(root,d.name))).map(d=>({name:d.name,directory:d.isDirectory()}));const offset=Number(a.offset)||0,limit=Math.min(500,Number(a.limit)||150);return {entries:list.slice(offset,offset+limit),next:offset+limit<list.length?offset+limit:null,total:list.length};}
  if(a.op==='search')return searchProject(a);
  throw Error('Unknown read-only operation');
}
export const tool={name:'goal_inspect',description:'Read-only inspection on the SOURCE machine. catalog lists Pi sessions and live processes; session section=summary gives the full latest compaction with character pagination (read next until null); section=recent gives the last 20 native entries plus recentAdvice (the last 3 review suggestions from the original dialogue); section=users gives user instructions; section=context gives full compaction plus all subsequent entries when more evidence is needed; runtime refreshes current session/process state; read/list/search read project files; search is literal, includes source code and JSON/JSONL, returns file:line excerpts and explicit pagination/budget/skip reasons. Use narrow project paths; read for full matching lines. Credentials, symlinks and generated/vendor directories are excluded from recursive search. No credentials or mutations.',inputSchema:{type:'object',properties:{op:{type:'string',enum:['catalog','session','runtime','read','list','search']},id:{type:'string'},section:{type:'string',enum:['summary','recent','users','context']},path:{type:'string'},query:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['op'],additionalProperties:false}};
async function mcp(source){
  process.stdin.setEncoding('utf8');
  let buf='';for await(const b of process.stdin){buf+=b.toString('utf8');let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let q;try{q=JSON.parse(line);if(q.id===undefined)continue;let result;
    if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'long-goal-source-readonly',version:'1.0.0'}};
    else if(q.method==='tools/list')result={tools:[tool]};
    else if(q.method==='ping')result={};
    else if(q.method==='tools/call'&&q.params.name==='goal_inspect'){try{const val=source===HERE?await inspect(q.params.arguments):JSON.parse((await onMachine(source,['--inspect'],{input:JSON.stringify(q.params.arguments)})).out);result={content:[{type:'text',text:JSON.stringify(val)}]}}catch(e){console.error('goal-inspect tool failed:',e.message);result={isError:true,content:[{type:'text',text:e.message}]}}}
    else throw Error('Unsupported MCP method');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
  }catch(e){console.error('goal-inspect MCP error:',e.message);if(q?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32603,message:e.message}})+'\n')}}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (async()=>{try {if(process.argv.includes('--claude-review')){const {claudeReview}=await import('./goal-claude-review.mjs');console.log(JSON.stringify({event:'claude-result',result:await claudeReview(JSON.parse(fs.readFileSync(0,'utf8')))}));}else if(process.argv.includes('--inspect'))console.log(JSON.stringify(await inspect(JSON.parse(fs.readFileSync(0,'utf8')))));else if(process.argv.includes('--mcp'))await mcp(process.argv[process.argv.indexOf('--mcp')+1]);else throw Error('Use --inspect or --mcp <source-machine>');}catch(e){console.error(e.message);process.exitCode=1}})();
}
