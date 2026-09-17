import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,HERE,run,site} from './goal-inspect.mjs';
import {acquireLock} from './quota-idle-scheduler.mjs';
import {reviewSessionBinding} from './goal-review-session.mjs';

export const FABLE_MODEL='claude-fable-5-1',OPUS_MODEL='claude-opus-5';
const PRIMARY={model:FABLE_MODEL,effort:'high'},FALLBACK={model:OPUS_MODEL,effort:'xhigh'};
const emitEvent=e=>console.log(JSON.stringify(e));
// Inspect native error surfaces only. Generic 429/overload and approaching a limit are not exhausted quota.
export function quotaExhausted({text='',rateLimit}={}){
  if(rateLimit?.status==='rejected'&&/^(?:five_hour|seven_day(?:_[a-z0-9_]+)?|overage)$/.test(rateLimit.rateLimitType||''))return true;
  return /you[’']ve hit your (?:(?:session|weekly|fable(?:\s+5(?:\.1)?)?|opus|sonnet|monthly spend|individual (?:spend|usage)|(?:org|channel)[’']s monthly spend)\s+)?limit\b|you[’']ve hit your team[’']s shared budget|(?:usage|spend|quota) limit (?:reached|exceeded|exhausted)|credit balance is too low|(?:usage )?credits? (?:exhausted|depleted)|insufficient_quota|quota_exceeded|out_of_credits/i.test(text);
}
export async function claudeReview(job,{execute=run}={}){
  site(job.source);
  const unlock=acquireLock(path.join(site().data,'goal-review','fable-worker-'+job.source),(event,details)=>console.log(JSON.stringify({event:'claude-worker-lock',kind:event,...details})));
  if(!unlock)throw Error('A Fable review for this source machine is already running on the peer');
  try{return await runClaudeReview(job,execute)}finally{unlock()}
}
async function runClaudeReview(job,execute){
  if(HERE!=='yangyong')throw Error('Fable runs only on YANGYONG; no local/provider fallback');
  const bridge='C:/Users/lop/Documents/claude/mobile-bridge';
  const c=JSON.parse(fs.readFileSync(path.join(bridge,'config.json'),'utf8'));
  const {childEnvironment}=await import(pathToFileURL(path.join(bridge,'runtime-env.mjs')));
  const {nativeProfileAuth}=await import(pathToFileURL(path.join(bridge,'claude-auth.mjs')));
  // The bridge's npm CLI can lag behind the user's desktop CLI. Discover official installed versions, not a pinned folder.
  const desktop='C:/Users/lop/AppData/Roaming/Claude/claude-code';
  const candidates=fs.existsSync(desktop)?fs.readdirSync(desktop).filter(v=>/^\d+\.\d+\.\d+$/.test(v)&&fs.existsSync(path.join(desktop,v,'claude.exe'))).map(version=>({version,bin:path.join(desktop,version,'claude.exe')})):[];
  const current=await run(c.claude.bin,['--version'],{timeout:10000,cwd:bridge});
  const version=current.out.match(/\d+\.\d+\.\d+/)?.[0];if(!version)throw Error('Cannot identify configured Claude CLI version');
  candidates.push({version,bin:c.claude.bin});candidates.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}));
  const selected=candidates[0],bin=selected.bin;
  console.log(JSON.stringify({event:'claude-cli',version:selected.version,bin}));
  const clean=childEnvironment(process.env,'C:/Users/lop');
  const auth=nativeProfileAuth({bin,profileHome:c.claude.authHome,env:clean.env,log:console.error,minValidityMs:25*60000});
  const env=await auth.environment();
  const work=path.join(site().data,'goal-review','fable',job.source);fs.mkdirSync(work,{recursive:true});
  const binding=reviewSessionBinding(work);
  return runClaudeAttempts({job,bin,env,work,binding,execute});
}
export async function runClaudeAttempts({job,bin,env,work,binding,execute=run,emit=emitEvent}){
  // One bounded retry for exhausted quota, after the first CLI exits. No global settings or identity changes.
  const deadline=Date.now()+35*60000;
  const attempt=spec=>claudeAttempt({job,bin,env,work,binding,execute,emit,spec,deadline});
  try{return await attempt(PRIMARY)}catch(error){
    if(!error.quotaExhausted)throw error;
    if(!binding.id){emit({event:'claude-fallback-skipped',reason:'missing-native-session-identity',source:job.source});throw Error('Quota exhausted but no native session identity; refusing to create another dialogue')}
    const fallback={from:FABLE_MODEL,to:OPUS_MODEL,effort:'xhigh',reason:'quota-exhausted',evidence:error.message.slice(0,600)};
    emit({event:'claude-fallback',source:job.source,reviewSession:binding.id,...fallback});
    return {...await attempt(FALLBACK),fallback};
  }
}
async function claudeAttempt({job,bin,env,work,binding,execute,emit,spec,deadline}){
  const {model,effort}=spec;
  const args=['-p','--model',model,'--effort',effort,'--settings',JSON.stringify({alwaysThinkingEnabled:true}),'--output-format','stream-json','--verbose',...binding.args('fable'),'--name','长目标巡检 · Fable 5.1 / Opus 5 · '+job.source,'--tools','','--permission-mode','dontAsk'];
  emit({event:'claude-session',source:job.source,reviewSession:binding.id,mode:binding.id?'resume':'bootstrap',cwd:work,model,effort});
  if(!job.probe){
    const mcp={mcpServers:{goal_source:{command:process.execPath,args:[path.join(ROOT,'src/goal-inspect.mjs'),'--mcp',job.source]}}};
    args.push('--strict-mcp-config','--mcp-config',JSON.stringify(mcp),'--allowedTools','mcp__goal_source__goal_inspect');
  }
  let result,nativeError='',nativeErrorCode='',sessionError='',rateLimit,actualModels=new Set(),lastActivity=Date.now(),exitError;
  const heartbeat=setInterval(()=>emit({event:'claude-heartbeat',source:job.source,model,effort,lastActivity}),20000);
  try{
    const timeout=deadline-Date.now();if(timeout<=0)throw Error('Claude review time budget exhausted before attempt');
    const input=job.prompt.replace(`巡检模型：${FABLE_MODEL}/high。`,`巡检模型：${model}/${effort}。`);
    try{await execute(bin,args,{env,cwd:work,timeout,input,onLine:line=>{
      let e;try{e=JSON.parse(line)}catch{return}lastActivity=Date.now();
      if(e.type==='system'&&e.subtype==='init'&&e.session_id){try{binding.bind(e.session_id)}catch(error){sessionError=error.message;emit({event:'claude-session-failed',reason:sessionError})}}
      if(e.type==='rate_limit_event'){rateLimit=e.rate_limit_info;emit({event:'claude-rate-limit',source:job.source,model,status:rateLimit?.status,rateLimitType:rateLimit?.rateLimitType,resetsAt:rateLimit?.resetsAt})}
      if(e.type==='assistant'&&e.message?.model){actualModels.add(e.message.model);if(e.message.model==='<synthetic>'){nativeError=(e.message.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');nativeErrorCode=e.error||'';}}
      if(e.type==='result')result=e;
      if(['assistant','user','result','system'].includes(e.type))emit({event:'claude-progress',type:e.type,subtype:e.subtype,model:e.message?.model});
    }})}catch(error){exitError=error}
    if(sessionError)throw Error(sessionError);
    if(result?.session_id)binding.bind(result.session_id);
    if(exitError||!result||result.is_error){
      // A successful model answer mentioning quota is never an exhaustion signal.
      const text=[nativeError,...(result?.is_error?[result.result,...(result.errors||[])]:[])].filter(v=>typeof v==='string').join('\n');
      const error=Error((text||exitError?.message||'Claude returned no result').slice(0,1500));
      const denied=/authentication|oauth|account_on_hold|verification|required|model_not_found|invalid_request/.test(nativeErrorCode);
      error.quotaExhausted=!denied&&Boolean(result?.is_error||nativeError)&&quotaExhausted({text,rateLimit});
      throw error;
    }
    const models=[...actualModels].filter(m=>m!=='<synthetic>');
    if(!models.length||models.some(m=>m!==model&&!m.startsWith(model+'[')&&!new RegExp('^'+model+'-\\d{8}$').test(m)))throw Error('Requested '+model+' but actual model was '+models.join(',')+'; result not used');
    if(!result.session_id)throw Error('Claude result missing native session identity');
    emit({event:'claude-session',source:job.source,reviewSession:binding.id,mode:'verified',model,effort});
    return {text:result.result,reviewSession:binding.id,model,effort,actualModels:models,source:job.source,worker:HERE};
  }catch(error){emit({event:'claude-attempt-failed',source:job.source,model,effort,reason:error.message,quotaExhausted:!!error.quotaExhausted});throw error}
  finally{clearInterval(heartbeat)}
}
