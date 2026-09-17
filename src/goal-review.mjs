// Two explicitly authorized goal reviews. Reviewers are read-only; only this source-local gateway sends advice.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HERE,site,api,inspect,sessionView,hash,onMachine,processes} from './goal-inspect.mjs';
import {astraReview} from './goal-astra-review.mjs';
import {acquireLock,stateBusy} from './quota-idle-scheduler.mjs';
import {appendLineRotating} from './log-rotate.mjs';

export const AUTONOMY_GUIDANCE='在请求人工介入前，先检查是否因自身核查不够全面而误判为必须人工，补齐必要检查，并寻找现有授权范围内可自行完成的更好方案；能自行处理就直接执行。只有确实必须人工操作或授权时才请求介入，并说明已核实的原因。';
export const ADVICE_BOUNDARY='本消息是自动巡检建议，不是用户新增指令或授权；生产变更、共享环境、账户操作及暂停边界仍以用户实际授权为准。';
const INTERVENTIONS=['new-evidence','new-route','unfinished-action'];
// Timing has one owner: the installed Windows task triggers, not model metadata.
export const PROFILES={astra:{hours:6,model:'gpt-6-astra',effort:'low'},fable:{hours:4,model:'claude-fable-5-1',effort:'high'}};
const DATA=site().data,WORK=path.join(DATA,'goal-review'),GOALS=path.join(DATA,'长目标清单.md');
export function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file)}
export function log(event,details={}){const line=JSON.stringify({at:new Date().toISOString(),machine:HERE,event,...details});const r=appendLineRotating(path.join(WORK,'scheduler.log'),line,{maxBytes:5*1024*1024,keep:3});if(!r.ok)throw Error(r.error);console.log(line)}
export const emptyGoals=text=>{const body=text.replace(/^#\s+长目标清单\s*$/gmu,'').trim();return !body||/^(?:当前)?(?:没有|暂无)长目标[。.!！]?$/u.test(body)};
function load(file,def){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):def}
function compactCatalog(c){return {...c,sessions:c.sessions.map(s=>({...s,first:s.first.slice(0,450)}))}}
export function reviewPrompt(profile,goals,catalog){
  const p=PROFILES[profile];
  return `${AUTONOMY_GUIDANCE}\n这是用户明确授权的本机长目标巡检，不是执行目标的工作对话。目标所在机器：${HERE}。巡检模型：${p.model}/${p.effort}。本轮规划窗口是未来${p.hours}小时，以最有可能真正完成目标的路径为导向，不是工期承诺，也不允许降低验收标准。\n\n`+
  `只检查以下本机长目标清单，按自然语言理解，不要求固定标题、字段、状态符或标识。清单中的最新要求优先于旧会话目标。不要扫描近期P0/P1替代清单。\n${goals}\n\n`+
  `逐项找到真正承接该目标的原始执行对话。不要选择讨论定时任务/配置巡检的会话；不要另起执行对话。查看最新用户要求、实际相关历史、最新完整压缩摘要及其后执行/工具记录、项目已有产物/报告和实时运行状态；不是仅凭目录、摘要、mtime或一条“完成”声明下结论。只有证据不足才继续补读；分页有next就继续读取相关全文。可检查多个同项目会话，但每个目标只确定一个实际承接会话，发现同目录已有其他执行在运行就不要重复恢复。\n`+
  (profile==='fable'?`本轮首选Fable 5.1 high；只有原生CLI明确报告额度耗尽，巡检器才在同一会话改用claude-opus-5/xhigh重试一次，仍规划未来4小时；不由模型自行换型，不取消授权边界。\n你在对端Claude中运行；必须通过mcp__goal_source__goal_inspect只读工具访问来源机器，不能把对端的文件或进程当作来源机器的状态。session操作返回最新完整压缩摘要和之后的原生记录（字符分页），runtime刷新会话与后台进程；read/list/search用于项目文件。不要调用SSH或读取凭据，工具已处理传输。\n`:`你在目标所在机器Pi原生CLI中运行，只开放goal_inspect只读工具。session操作按字符分页返回最新完整压缩及后续原生记录，避免内置read对超长JSONL单行截断；runtime刷新实时会话和后台进程，read/list/search读取项目产物。不允许写入或运行命令，发送前网关还会复核。\n`)+
  `历史读取顺序：先 session(section=summary) 按 next 把最新完整压缩摘要读完，再 session(section=recent) 读最后20条原生记录。无压缩或证据不足时再按需用 section=context/users 补查；不要为了取最后进度扫描整个数MB上下文，也不要跳过被截断的相关摘要。\n`+
  `巡检的价值是减少达到原目标所需的时间和试错，不是让会话一直运行。先判断当前办法是否仍值得继续：哪个关键假设已被证据否定，有没有更便宜或更直接的解法，下一次最小验证能区分什么。理由不充分就保持原路线，不为提出新建议而改向；建设性建议可以是架构/研究路线变化，也可以是能解除具体阻断的小修复。不要以新增报告、重复收尾或增加测试数量替代解决问题。\n`+
  `比较原任务当前计划、执行方的纠正和近期巡检建议。session(section=recent)会附recentAdvice，内容来自原会话；更早路线有疑问再用section=users定位。原任务已经提出的办法不算巡检新方向，同一问题同一方案换措辞也不是增量；相同建议已经执行、拒绝或正在等待时不要再投。确实中断且仍有未完成的授权内动作，可以恢复，但须指出具体哪一步尚未完成。对会改变建议的运行进展，定向核对最新记录/产物，已解决的卡点不要再发。\n`+
  `已达标：done，给实际验收依据。正在合理运行，或虽已停止但在等待数据/资源事件、无新证据或可执行下一步：observe，说明等待条件，不发消息；未达标本身不是恢复理由。用户明确暂停/取消/等待授权，或找不到原会话：blocked。只有确有新增干预价值才发送：运行中用steer，不强停或切模型；空闲且无相关后台执行用resume，在原对话Astra xhigh继续。intervention说明依据类型：new-evidence=改变下一步判断的新证据/等待事件已发生；new-route=区别于现有及已拒绝方案、有依据的替代办法；unfinished-action=原任务中断后仍有具体未完成的授权内动作；none=没有可推进事项。reason自然说明具体差异和依据，advice给最小下一步及如何验证。不要求每轮改向；重读清单、确认无变化、零动作结束不构成干预。\n`+
  `${ADVICE_BOUNDARY} 巡检仅取证和建议，不直接执行目标。原任务无需采纳错误建议；不得用缩样、代理指标、跳过失败或放宽门槛偷换原验收。\n`+
  `对每个目标都给出结论。只返回一个JSON对象，不要代码围栏：{"decisions":[{"goalQuote":"从清单原文逐字引用能唯一指代该目标的一段（至少8字）","sessionId":"来源Pi会话ID；找不到则空字符串","action":"done|observe|steer|resume|blocked","intervention":"new-evidence|new-route|unfinished-action|none","reason":"具体依据；若发送，说明相较当前方案/近期建议的增量或确实未完成的动作","advice":"仅有干预价值的steer/resume填写，包含最小下一步与真实验证；其他为空","relatedSessionIds":[属于同一目标或其分叉的其他会话ID，不按相同cwd认定同项目],"backgroundPids":[已经确认属于该目标且仍运行的PID]}]}。\n`+
  `6小时/4小时只决定下一步路线，不得虚构达标。保持所有已有授权边界；回测不得实盘、资金转移或前视；APK验收不能用“构建成功”代替功能/功耗/画质实测。不要把巡检本身、静止的会话宿主、模拟器常驻或与项目无关的进程当成目标正在执行。\n\n`+
  `当前来源机器观测（${new Date().toISOString()}；会话mtime不是运行证据）：\n${JSON.stringify(compactCatalog(catalog))}`;
}
export function parseDecisions(text,goals){
  const clean=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  const value=JSON.parse(clean);if(!Array.isArray(value.decisions))throw Error('Review result needs decisions array');
  const seen=new Set();for(const d of value.decisions){
    if(typeof d.goalQuote!=='string'||d.goalQuote.length<8||!goals.includes(d.goalQuote))throw Error('Decision is not tied to a verbatim goal-list excerpt');
    if(seen.has(d.goalQuote))throw Error('Duplicate goal decision');seen.add(d.goalQuote);
    if(!['done','observe','steer','resume','blocked'].includes(d.action)||typeof d.reason!=='string'||!d.reason.trim())throw Error('Invalid action/reason');
    if(['steer','resume'].includes(d.action)){
      if(![...INTERVENTIONS,'none'].includes(d.intervention))throw Error('Send decision needs an explicit intervention basis');
      if(d.intervention!=='none'&&(!/^[\da-f-]{36}$/i.test(d.sessionId)||typeof d.advice!=='string'||!d.advice.trim()))throw Error('Send decision needs original session and concrete advice');
    }
    if(d.relatedSessionIds!==undefined&&(!Array.isArray(d.relatedSessionIds)||d.relatedSessionIds.some(id=>!/^[\da-f-]{36}$/i.test(id))))throw Error('Invalid related session IDs');
    if(!Array.isArray(d.backgroundPids)||d.backgroundPids.some(p=>!Number.isInteger(p)||p<=0))throw Error('Invalid background PID list');
  }
  return value.decisions;
}
async function fableReview(prompt){
  log('review-started',{profile:'fable',worker:'yangyong',model:PROFILES.fable.model,effort:'high'});
  let result;
  const r=await onMachine('yangyong',['--claude-review'],{input:JSON.stringify({source:HERE,prompt}),timeout:37*60000,onLine:line=>{
    let e;try{e=JSON.parse(line)}catch{return}
    if(e.event==='claude-result')result=e.result;
    else log('review-progress',{profile:'fable',workerEvent:e.event,type:e.type,model:e.model,lastActivity:e.lastActivity,cli:e.bin,version:e.version,reason:e.reason,kind:e.kind,reviewSession:e.reviewSession,mode:e.mode,effort:e.effort,from:e.from,to:e.to,evidence:e.evidence,quotaExhausted:e.quotaExhausted,status:e.status,rateLimitType:e.rateLimitType,resetsAt:e.resetsAt});
  }});
  if(!result)throw Error('Remote Claude returned no verified result: '+r.err.slice(-500));return result;
}
export function paused(s){return /^(?:停止|取消|暂停)(?:这个|该|本)?(?:任务|执行|自动|续做|巡检)?[。！!\s]*$/u.test(s.lastHuman.trim())||s.lastStopReason==='aborted';}
function processesFor(cwd,rows){const key=cwd.replaceAll('\\','/').toLowerCase();return rows.filter(p=>String(p.command).replaceAll('\\','/').toLowerCase().includes(key)&&!String(p.command).includes('goal-review'))}
export async function deliver({decision:d,profile,reviewModel=PROFILES[profile]?.model,reviewEffort=PROFILES[profile]?.effort,goalsHash,startSessions,startProcesses=[],request=api,view=sessionView,processList=processes,logFn=log,work=WORK,readGoals=()=>fs.readFileSync(GOALS,'utf8')}){
  if(!['steer','resume'].includes(d.action)){logFn('goal-skipped',{goal:d.goalQuote,action:d.action,reason:d.reason});return {status:d.action}}
  if(!INTERVENTIONS.includes(d.intervention)){logFn('send-skipped',{goal:d.goalQuote,reason:'no-actionable-intervention',detail:d.reason,intervention:d.intervention??'missing'});return {status:'no-intervention'}}
  if(hash(readGoals())!==goalsHash){logFn('send-skipped',{reason:'goal-list-changed-during-review',goal:d.goalQuote});return {status:'stale-goals'}}
  const unlock=acquireLock(path.join(work,'delivery-lock'),logFn);if(!unlock)return {status:'delivery-busy'};
  try{
    const v=view(d.sessionId),initial=startSessions.find(s=>s.id===d.sessionId);
    if(!initial)throw Error('Not an original source session from this review');
    if(paused(v)){logFn('send-skipped',{sessionId:d.sessionId,reason:'user-pause-cancel-or-abort'});return {status:'paused'}}
    if(initial.lastHumanId!==undefined?v.lastHumanId!==initial.lastHumanId:Date.parse(v.lastHumanAt)>initial.reviewStartedAt){logFn('send-skipped',{sessionId:d.sessionId,reason:'new-user-instruction-during-review'});return {status:'new-user'}}
    const route='/api/agent/'+d.sessionId;
    let live=await request(route);let busy=live.state?stateBusy(live.state):false;
    const rows=await processList();
    // Only new unclassified processes are an extra guard. A pre-existing SMS/server process in a generic cwd is not a backtest/APK job.
    const related=processesFor(v.cwd,rows).filter(p=>!startProcesses.some(s=>s.pid===p.pid&&s.created===p.created&&s.command===p.command));
    const reviewPids=d.backgroundPids.filter(pid=>rows.some(p=>p.pid===pid));
    if(!busy&&(reviewPids.length||related.length)){logFn('send-skipped',{sessionId:d.sessionId,reason:'background-project-work-running-or-needs-confirmation',pids:[...new Set([...reviewPids,...related.map(p=>p.pid)])]});return {status:'background-running'}}
    const running=await request('/api/agent/running');
    const relatedIds=new Set(d.relatedSessionIds||[]);
    const norm=s=>String(s||'').replaceAll('\\','/').toLowerCase();
    const others=startSessions.filter(s=>s.id!==d.sessionId&&running.runningSessionIds.includes(s.id)&&(relatedIds.has(s.id)||(s.parentSession&&norm(s.parentSession)===norm(v.file))||(v.parentSession&&norm(v.parentSession)===norm(s.file))));
    // A shared shell cwd (e.g. pi-mobile) does not establish that two goals are the same project.
    if(others.length){logFn('send-skipped',{sessionId:d.sessionId,reason:'same-project-other-session-running',others:others.map(s=>s.id)});return {status:'other-session'}}
    const stateFile=path.join(work,'deliveries.json');const records=load(stateFile,[]);
    const text=`【长目标巡检建议 · ${reviewModel} / ${reviewEffort} / ${PROFILES[profile].hours}小时】\n目标（清单最新要求）：${d.goalQuote}\n本机清单：${GOALS}\n先核对清单中此目标的最新验收与共同约束，不沿用旧阈值；只承接当前原任务，不接管其他目标。\n${ADVICE_BOUNDARY}\n\n本次干预依据（${d.intervention}）：${d.reason}\n\n建议：${d.advice}\n\n${AUTONOMY_GUIDANCE}\n请结合原任务的完整上下文自行评估，合理则采纳；已处理、前提不成立或与用户边界冲突则不采纳，不为回复巡检重复工作。没有授权内可推进事项时可以正常结束并说明等待条件，不必新增报告或重复验证。不得降低验收标准。`;
    const adviceHash=hash(d.advice.replace(/\s+/g,' '));
    const prior=records.findLast(r=>r.sessionId===d.sessionId&&(['sending','uncertain'].includes(r.status)||(r.status==='accepted'&&((r.adviceHash===adviceHash&&r.humanId===v.lastHumanId)||r.baseRevision===v.revision||r.at>=initial.reviewStartedAt))));
    if(prior){const confirmed=v.users.some(u=>u.text===prior.text);if(confirmed&&['sending','uncertain'].includes(prior.status)){prior.status='accepted';save(stateFile,records)}logFn('send-skipped',{sessionId:d.sessionId,reason:confirmed?'already-in-original-dialogue':'duplicate-or-unresolved-delivery',delivery:prior.id});return {status:'duplicate'}}
    if(busy&&live.state?.pendingMessageCount>0){logFn('send-skipped',{sessionId:d.sessionId,reason:'original-dialogue-already-has-queued-input'});return {status:'queued'}}
    const record={id:cryptoId(),at:Date.now(),sessionId:d.sessionId,goalQuote:d.goalQuote,profile,intervention:d.intervention,adviceHash,baseRevision:v.revision,humanId:v.lastHumanId,text,status:'preparing'};
    records.push(record);save(stateFile,records);
    // Re-read native state immediately before changing model. Never change a running executor.
    live=await request(route);busy=live.state?stateBusy(live.state):false;
    if(!busy){
      const fresh=view(d.sessionId);if(fresh.revision!==v.revision){record.status='skipped';record.reason='execution-progress-changed-before-resume';save(stateFile,records);logFn('send-skipped',{reason:record.reason,sessionId:d.sessionId});return {status:'stale-progress'}}
      live=(await request(route,{type:'get_state'})).data;
      if(!stateBusy(live)&&(live.model?.id!=='gpt-6-astra'||live.model?.provider!=='openai-codex'))await request(route,{type:'set_model',provider:'openai-codex',modelId:'gpt-6-astra'});
      live=(await request(route,{type:'get_state'})).data;
      if(stateBusy(live)){record.status='skipped';record.reason='user-started-during-model-selection';save(stateFile,records);logFn('send-skipped',{reason:record.reason,sessionId:d.sessionId});return {status:'became-busy'}}
      await request(route,{type:'set_thinking_level',level:'xhigh'});
      live=(await request(route,{type:'get_state'})).data;
      if(live.model?.id!=='gpt-6-astra'||live.thinkingLevel!=='xhigh')throw Error('Executor model/effort verification failed');
      if(stateBusy(live)){record.status='skipped';record.reason='user-started-before-resume';save(stateFile,records);logFn('send-skipped',{reason:record.reason,sessionId:d.sessionId});return {status:'became-busy'}}
    }
    record.status='sending';record.mode=busy?'steer':'resume';save(stateFile,records);
    try{
      // Native steer queues only for the live run; idle prompt resumes the SAME stored session.
      await request(route,busy?{type:'steer',message:text}:{type:'prompt',message:text,streamingBehavior:'steer'});
      record.status='accepted';save(stateFile,records);
      const readback=await request(route,{type:'get_state'});const latest=view(d.sessionId);
      record.readback=latest.users.some(u=>u.text===text)||Object.values(readback.data?.queuedMessages||{}).some(q=>Array.isArray(q)&&q.some(m=>typeof m==='string'?m===text:JSON.stringify(m).includes(text)));
      save(stateFile,records);logFn('advice-accepted',{sessionId:d.sessionId,mode:record.mode,delivery:record.id,readback:record.readback});
      return {status:'accepted',mode:record.mode,sessionId:d.sessionId,readback:record.readback};
    }catch(e){record.status=e.accepted===false?'rejected':'uncertain';record.reason=e.message;save(stateFile,records);logFn('advice-send-failed',{sessionId:d.sessionId,status:record.status,reason:e.message});throw e}
  }finally{unlock()}
}
function cryptoId(){return hash(`${Date.now()}/${process.pid}/${Math.random()}`).slice(0,20)}
export async function tick(profile,{dryRun=false,reviewOnly=false,work=WORK,goalsFile=GOALS,inspectSource=inspect,logFn=log}={}){
  if(!PROFILES[profile])throw Error('Profile must be astra or fable');
  const unlock=acquireLock(path.join(work,profile+'-lock'),logFn);if(!unlock)return {skipped:'overlap'};
  let heartbeat;
  try{
    logFn('tick',{profile,pid:process.pid,dryRun,reviewOnly});
    const goals=fs.readFileSync(goalsFile,'utf8');
    const skipReason=emptyGoals(goals)?'empty':!/\p{Decimal_Number}|目标/u.test(goals)?'no-digit-or-target':null;
    if(skipReason){logFn('skip',{profile,reason:'local-goal-list-'+skipReason,modelCalls:0});return {skipped:skipReason,modelCalls:0}}
    const reviewStartedAt=Date.now();
    const catalog=await inspectSource({op:'catalog'});
    // Only selected histories are read in full. A later human instruction invalidates the review.
    const startSessions=catalog.sessions.map(s=>({...s,reviewStartedAt}));
    const prompt=reviewPrompt(profile,goals,catalog);const runId=new Date().toISOString().replace(/[:.]/g,'-');
    const promptFile=path.join(work,`${profile}-latest-prompt.txt`);fs.mkdirSync(work,{recursive:true});fs.writeFileSync(promptFile,prompt);
    if(dryRun){logFn('dry-run',{profile,goalsHash:hash(goals),sessionCount:catalog.sessions.length,promptChars:prompt.length,modelCalls:0});return {dryRun:true,profile,promptFile,modelCalls:0}}
    heartbeat=setInterval(()=>logFn('tick-alive',{profile,pid:process.pid,runId}),25000);
    const result=profile==='astra'?await astraReview(prompt,logFn):await fableReview(prompt);
    const decisions=parseDecisions(result.text,goals);
    save(path.join(work,`${profile}-latest-result.json`),{runId,at:new Date().toISOString(),machine:HERE,goalsHash:hash(goals),startSessions:startSessions.map(({first,mtime,...s})=>s),startProcesses:catalog.processes,model:result.model,effort:result.effort,reviewSession:result.reviewSession,fallback:result.fallback,decisions});
    if(reviewOnly){logFn('review-only-complete',{profile,decisions:decisions.length,sourceMutations:0});return {profile,reviewOnly:true,decisions}}
    const outcomes=[];for(const d of decisions){try{outcomes.push(await deliver({decision:d,profile,reviewModel:result.model,reviewEffort:result.effort,goalsHash:hash(goals),startSessions,startProcesses:catalog.processes,work,logFn,readGoals:()=>fs.readFileSync(goalsFile,'utf8')}))}catch(e){logFn('goal-failed',{profile,goal:d.goalQuote,reason:e.message});outcomes.push({status:'failed',reason:e.message})}}
    if(!decisions.length)logFn('skip',{profile,reason:'reviewer-found-no-active-goals'});
    logFn('tick-complete',{profile,decisions:decisions.length,outcomes});if(outcomes.some(o=>o.status==='failed'))throw Error('One or more goal deliveries failed; see per-goal log');return {profile,outcomes};
  }catch(e){logFn('tick-failed',{profile,reason:e.message});throw e}
  finally{if(heartbeat)clearInterval(heartbeat);unlock()}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const profile=process.argv[process.argv.indexOf('--profile')+1];
  tick(profile,{dryRun:process.argv.includes('--dry-run'),reviewOnly:process.argv.includes('--review-only')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1});
}
