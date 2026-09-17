import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deliver,parseDecisions,emptyGoals,PROFILES,reviewPrompt,AUTONOMY_GUIDANCE,ADVICE_BOUNDARY,REPEATED_REMINDER_GUIDANCE,tick} from '../src/goal-review.mjs';
import {hash,safePath,pageText,recentReviewAdvice,reviewAdviceCount,searchProject,inspect} from '../src/goal-inspect.mjs';
const goal='抖音义水北路交易体系回测：沪深股，近6个月收益率5倍以上。';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const decision={goalQuote:goal,sessionId:id,action:'resume',intervention:'unfinished-action',reason:'协议已冻结，因执行中断尚未完成逐日回放',advice:'验证时点可见性，再重跑完整逐日交易记录。',backgroundPids:[]};
function fixture(options={}){
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'goal-contract-'));
  const calls=[],logs=[];let busy=!!options.busy;
  const v={id,cwd:'D:/project-under-test',revision:'rev1',lastHumanId:'human1',lastHuman:'继续这个目标',lastStopReason:'stop',users:[]};
  let model={id:'old-model',provider:'other'},thinkingLevel='medium';
  const state=()=>({isStreaming:busy,isPromptRunning:false,isBashRunning:false,isCompacting:false,pendingMessageCount:options.queued?1:0,queuedMessages:{steering:[],followUp:[]},model,thinkingLevel});
  const request=async(route,body)=>{
    calls.push({route,...body});
    if(route==='/api/agent/running')return {runningSessionIds:options.other?[options.other]:busy?[id]:[]};
    if(!body)return {running:true,state:state()};
    if(body.type==='get_state')return {data:state()};
    if(body.type==='set_model'){assert.equal(busy,false,'must not change active model');model={id:body.modelId,provider:body.provider}}
    if(body.type==='set_thinking_level'){assert.equal(busy,false);thinkingLevel=body.level}
    if(['prompt','steer'].includes(body.type)){
      if(options.ambiguous)throw Error('API timeout; acceptance unknown');
      if(options.rejected){const e=Error('native prompt_rejected');e.accepted=false;throw e;}
      if(body.type==='prompt'){assert.equal(model.id,'gpt-6-astra');assert.equal(thinkingLevel,'xhigh')}
      v.users.push({text:body.message});v.revision='rev2';busy=true;
    }
    return {success:true};
  };
  const args={decision:{...decision},profile:'astra',goalsHash:hash(goal),startSessions:[{id,cwd:v.cwd,lastHumanId:'human1'}],request,view:()=>v,processList:async()=>options.processes||[],logFn:(event,details)=>logs.push({event,...details}),work,readGoals:()=>goal};
  return {args,calls,logs,v,work};
}
test('profiles are exact; natural text does not require headings/IDs',()=>{
  assert.deepEqual(PROFILES.astra,{hours:6,model:'gpt-6-astra',effort:'low'});
  assert.deepEqual(PROFILES.fable,{hours:4,model:'claude-fable-5-1',effort:'high'});
  assert.equal(parseDecisions(JSON.stringify({decisions:[decision]}),goal).length,1);
  assert.equal(emptyGoals('# 长目标清单\n\n当前没有长目标。\n'),true);
  assert.equal(emptyGoals('# 长目标清单\n\n当前没有长目标。\n\n'+goal),false);
  assert.equal(emptyGoals('## '+goal),false);
  assert.throws(()=>parseDecisions(JSON.stringify({decisions:[{...decision,goalQuote:'未经授权的其他工作任务'}]}),goal));
});
test('both profiles skip lists without digits or 目标 before any inspection/model/delivery',async t=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'goal-preflight-'));
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const goalsFile=path.join(work,'list.md');
  for(const profile of ['astra','fable']){
    for(const text of ['待办：稍后再说。','\ufeff# 备忘\r\n仅有普通文字\r\n','abc!?\n']){
      fs.writeFileSync(goalsFile,text);const logs=[];let inspections=0;
      const result=await tick(profile,{work,goalsFile,inspectSource:async()=>{inspections++;throw Error('preflight must stop before inspection')},logFn:(event,details)=>logs.push({event,...details})});
      assert.deepEqual(result,{skipped:'no-digit-or-target',modelCalls:0});assert.equal(inspections,0);
      assert.ok(logs.some(e=>e.event==='skip'&&e.profile===profile&&e.reason==='local-goal-list-no-digit-or-target'&&e.modelCalls===0));
      assert.equal(fs.existsSync(path.join(work,profile+'-latest-prompt.txt')),false);
      assert.equal(fs.existsSync(path.join(work,profile+'-latest-result.json')),false);
      assert.equal(fs.existsSync(path.join(work,'deliveries.json')),false);
      assert.equal(fs.existsSync(path.join(work,profile+'-lock','lock')),false);
    }
  }
});
test('digit OR 目标 independently permits inspection; each tick rereads the list',async t=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'goal-preflight-'));
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const goalsFile=path.join(work,'list.md');
  for(const profile of ['astra','fable']){
    let inspections=0;
    const options={work,goalsFile,dryRun:true,inspectSource:async()=>{inspections++;return {sessions:[],processes:[]}},logFn:()=>{}};
    for(const text of ['完成第0项','1','目标：完成回归','第３项','第٣项','完成3项目标']){
      fs.writeFileSync(goalsFile,text);const before=inspections;const result=await tick(profile,options);
      assert.equal(result.dryRun,true,text);assert.equal(result.modelCalls,0);assert.equal(inspections,before+1);
      assert.ok(fs.readFileSync(result.promptFile,'utf8').includes(text));
    }
    const promptFile=path.join(work,profile+'-latest-prompt.txt'),prior=fs.readFileSync(promptFile,'utf8');
    fs.writeFileSync(goalsFile,'稍后再说');const before=inspections;
    assert.equal((await tick(profile,options)).skipped,'no-digit-or-target');assert.equal(inspections,before);
    assert.equal(fs.readFileSync(promptFile,'utf8'),prior,'skip preserves prior review assets');
    for(const text of ['', '\ufeff \r\n', '# 长目标清单\r\n', '# 长目标清单\n当前没有长目标。']){
      fs.writeFileSync(goalsFile,text);assert.equal((await tick(profile,options)).skipped,'empty');assert.equal(inspections,before);
    }
  }
});
test('unreadable goal list fails before inspection and releases its lock',async t=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'goal-preflight-'));
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  for(const profile of ['astra','fable']){
    const logs=[];let inspections=0;
    await assert.rejects(tick(profile,{work,goalsFile:path.join(work,'missing.md'),inspectSource:async()=>{inspections++;throw Error('unexpected inspection')},logFn:(event,details)=>logs.push({event,...details})}),/ENOENT/);
    assert.equal(inspections,0);assert.ok(logs.some(e=>e.event==='tick-failed'&&e.profile===profile&&/ENOENT/.test(e.reason)));
    assert.equal(fs.existsSync(path.join(work,profile+'-lock','lock')),false);
  }
});
test('both review prompts use the merged autonomy requirement without the superseded sentence',()=>{
  assert.equal(AUTONOMY_GUIDANCE,'在请求人工介入前，先检查是否因自身核查不够全面而误判为必须人工，补齐必要检查，并寻找现有授权范围内可自行完成的更好方案；能自行处理就直接执行。只有确实必须人工操作或授权时才请求介入，并说明已核实的原因。');
  for(const profile of ['astra','fable']){const prompt=reviewPrompt(profile,goal,{sessions:[]});assert.ok(prompt.includes(AUTONOMY_GUIDANCE));assert.ok(!prompt.includes('除必须的人工介入外，有更好的方案而无需人工介入。'))}
});
test('done/observe/blocked never call source APIs',async()=>{for(const action of ['done','observe','blocked']){const f=fixture();f.args.decision.action=action;assert.equal((await deliver(f.args)).status,action);assert.equal(f.calls.length,0)}});
test('idle resumes exact original dialogue on Astra xhigh, with readback',async()=>{const f=fixture();const r=await deliver(f.args);assert.equal(r.mode,'resume');assert.equal(r.readback,true);assert.equal(f.calls.some(c=>c.route.includes('/new')),false);assert.equal(f.calls.filter(c=>c.type==='prompt').length,1);assert.ok(f.calls.find(c=>c.type==='prompt').message.includes(AUTONOMY_GUIDANCE))});
test('outgoing advice from either reviewer includes the merged rule exactly once',async()=>{
  for(const profile of ['astra','fable']){const f=fixture();f.args.profile=profile;await deliver(f.args);const text=f.calls.find(c=>c.type==='prompt').message;assert.equal(text.split(AUTONOMY_GUIDANCE).length-1,1);assert.ok(!text.includes('除必须的人工介入外，有更好的方案而无需人工介入。'))}
});
test('Opus quota-fallback advice names its actual model and xhigh, while executor remains Astra xhigh',async()=>{
  const f=fixture();Object.assign(f.args,{profile:'fable',reviewModel:'claude-opus-5',reviewEffort:'xhigh'});await deliver(f.args);
  const text=f.calls.find(c=>c.type==='prompt').message;assert.ok(text.includes('claude-opus-5 / xhigh / 4小时'));assert.ok(!text.includes('Fable5.1 high'));assert.ok(text.includes(AUTONOMY_GUIDANCE));
  assert.ok(reviewPrompt('fable',goal,{sessions:[]}).includes('原生CLI明确报告额度耗尽'));
});
test('running source is steered without changing its model',async()=>{const f=fixture({busy:true});const r=await deliver(f.args);assert.equal(r.mode,'steer');assert.equal(f.calls.some(c=>c.type==='set_model'||c.type==='set_thinking_level'),false)});
test('running transition is rechecked; no model change',async()=>{const f=fixture({busy:true});f.args.decision.action='resume';assert.equal((await deliver(f.args)).mode,'steer')});
test('goal edits and new human instructions invalidate stale review',async()=>{const f=fixture();f.args.readGoals=()=>goal+'暂停';assert.equal((await deliver(f.args)).status,'stale-goals');assert.equal(f.calls.length,0);const g=fixture();g.v.lastHumanId='new-human';assert.equal((await deliver(g.args)).status,'new-user');assert.equal(g.calls.length,0)});
test('paused/aborted source is not resumed',async()=>{for(const change of [{lastHuman:'暂停'},{lastStopReason:'aborted'}]){const f=fixture();Object.assign(f.v,change);assert.equal((await deliver(f.args)).status,'paused');assert.equal(f.calls.length,0)}});
test('background jobs prevent duplicate execution',async()=>{const f=fixture({processes:[{pid:42,command:'python D:/project-under-test/backtest.py'}]});assert.equal((await deliver(f.args)).status,'background-running');assert.equal(f.calls.some(c=>c.type==='prompt'),false)});
test('same-project active peer conversation prevents a second executor',async()=>{const other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';const f=fixture({other});f.args.startSessions.push({id:other,cwd:f.v.cwd});f.args.decision.relatedSessionIds=[other];assert.equal((await deliver(f.args)).status,'other-session')});
test('source queued input is not spammed',async()=>{const f=fixture({busy:true,queued:true});assert.equal((await deliver(f.args)).status,'queued')});
test('shared cross-profile de-duplication',async()=>{const f=fixture();await deliver(f.args);f.args.profile='fable';assert.equal((await deliver(f.args)).status,'duplicate');assert.equal(f.calls.filter(c=>['prompt','steer'].includes(c.type)).length,1)});
test('ambiguous HTTP acceptance is not replayed',async()=>{const f=fixture({ambiguous:true});await assert.rejects(deliver(f.args),/acceptance unknown/);assert.equal((await deliver(f.args)).status,'duplicate');assert.equal(f.calls.filter(c=>c.type==='prompt').length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.work,'deliveries.json'),'utf8'))[0].status,'uncertain')});
test('shared generic cwd does not serialize unrelated goals',async()=>{const other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';const f=fixture({other});f.args.startSessions.push({id:other,cwd:f.v.cwd});assert.equal((await deliver(f.args)).status,'accepted')});
test('known unrelated service does not permanently block a goal',async()=>{const p={pid:42,created:'2026-01-01',command:'node D:/project-under-test/sms.mjs serve'};const f=fixture({processes:[p]});f.args.startProcesses=[p];assert.equal((await deliver(f.args)).status,'accepted')});
test('model-confirmed background PID still blocks even if pre-existing',async()=>{const p={pid:42,created:'2026-01-01',command:'python replay.py'};const f=fixture({processes:[p]});f.args.startProcesses=[p];f.args.decision.backgroundPids=[42];assert.equal((await deliver(f.args)).status,'background-running')});
test('explicitly rejected prompt can retry, unlike ambiguous delivery',async()=>{const f=fixture({rejected:true});await assert.rejects(deliver(f.args),/prompt_rejected/);await assert.rejects(deliver(f.args),/prompt_rejected/);assert.equal(f.calls.filter(c=>c.type==='prompt').length,2)});
test('two overlapping reviews of the same source do not send different stale advice',async()=>{const f=fixture();f.args.startSessions[0].reviewStartedAt=Date.now()-1000;await deliver(f.args);f.args.profile='fable';f.args.decision.advice='另一项不同的建议';assert.equal((await deliver(f.args)).status,'duplicate')});
test('source runtime outage is not treated as idle',async()=>{const f=fixture();f.args.request=async()=>{throw Error('service offline')};await assert.rejects(deliver(f.args),/offline/);assert.equal(f.calls.length,0)});
test('pagination is explicit, and credential roots cannot be read',()=>{assert.equal(pageText('x'.repeat(70000),0,60000).next,60000);assert.equal(pageText('x'.repeat(70000),60000,60000).next,null);assert.throws(()=>safePath('C:/Users/lop/.ssh/id_ed25519'));});
test('audit regression: no-action resumes never inspect runtime, select a model, or send',async()=>{
  for(const reason of ['东方财富等次日09:31自然采集，仅确认状态后结束','作者暂无新公开材料，零动作','SQL双车道已在原方案中，没有新证据']){
    const f=fixture();Object.assign(f.args.decision,{intervention:'none',reason,advice:''});
    assert.equal(parseDecisions(JSON.stringify({decisions:[f.args.decision]}),goal).length,1);
    f.args.view=()=>{throw Error('must not inspect or wake original session')};
    assert.equal((await deliver(f.args)).status,'no-intervention');assert.equal(f.calls.length,0);
    assert.ok(f.logs.some(e=>e.event==='send-skipped'&&e.reason==='no-actionable-intervention'&&e.detail===reason));
    assert.equal(fs.existsSync(path.join(f.work,'deliveries.json')),false);
  }
});
test('missing or invalid intervention basis is not silently delivered',async()=>{
  for(const intervention of [undefined,'waiting','new-evidence-but-unverified']){
    const f=fixture();f.args.decision.intervention=intervention;
    assert.throws(()=>parseDecisions(JSON.stringify({decisions:[f.args.decision]}),goal),/intervention basis/);
    assert.equal((await deliver(f.args)).status,'no-intervention');assert.equal(f.calls.length,0);
  }
});
test('a real new route, new evidence, and interrupted work remain deliverable',async()=>{
  for(const intervention of ['new-route','new-evidence','unfinished-action']){
    const f=fixture();f.args.decision.intervention=intervention;
    if(intervention==='new-route')f.args.decision.advice='V01精度受限：枚举全部可能首名分支，保留UNKNOWN，以独立回放验证是否所有分支都低于目标。';
    const result=await deliver(f.args);assert.equal(result.status,'accepted');assert.equal(result.readback,true);
    const record=JSON.parse(fs.readFileSync(path.join(f.work,'deliveries.json'),'utf8'))[0];assert.equal(record.intervention,intervention);
  }
});
test('both prompts require incremental value and preserve original acceptance and authority',()=>{
  for(const profile of ['astra','fable']){
    const prompt=reviewPrompt(profile,goal,{sessions:[]});
    for(const part of ['未达标本身不是恢复理由','recentAdvice','同一问题同一方案换措辞也不是增量','执行方的纠正','哪个关键假设已被证据否定','最小验证能区分什么','对会改变建议的运行进展','缩样、代理指标','none=没有可推进事项',ADVICE_BOUNDARY])assert.ok(prompt.includes(part),part);
    assert.ok(!prompt.includes('未达标且没有任何相关后台执行：resume'));
  }
});
test('both reviewers must reflect and improve after more than three delivered reminders',()=>{
  for(const profile of ['astra','fable']){
    const prompt=reviewPrompt(profile,goal,{sessions:[]});assert.equal(prompt.split(REPEATED_REMINDER_GUIDANCE).length-1,1);
    for(const part of ['超过3次（至少4次）','首先反思巡检建议本身','优化建议之后再继续提醒','没有有依据的改进就observe','不把observe或未送达尝试计入','跨巡检模型、会话压缩或换措辞不清零','本轮一次评审内完成反思与优化','不降低原验收'])assert.ok(prompt.includes(part),part);
    assert.ok(prompt.indexOf(REPEATED_REMINDER_GUIDANCE)<prompt.indexOf('对每个目标都给出结论'));
  }
});
test('delivered reminder counts are not capped by the three-item recent window',()=>{
  const users=[{text:'请继续'},...Array.from({length:4},(_,i)=>({id:'advice-'+i,text:`【长目标巡检建议 · ${i%2?'Fable':'Astra'}】第${i+1}次`})),{text:'普通用户提到【长目标巡检建议'}];
  assert.equal(reviewAdviceCount([]),0);assert.equal(reviewAdviceCount(users.slice(0,4)),3);assert.equal(reviewAdviceCount(users),4);
  assert.equal(recentReviewAdvice(users).length,3);assert.deepEqual(recentReviewAdvice(users).map(u=>u.id),['advice-1','advice-2','advice-3']);
});
test('outgoing advice is explicitly not new authorization and allows justified non-adoption',async()=>{
  const f=fixture();await deliver(f.args);const text=f.calls.find(c=>c.type==='prompt').message;
  assert.ok(text.includes(ADVICE_BOUNDARY));assert.ok(text.includes('已处理、前提不成立或与用户边界冲突则不采纳'));
  assert.ok(text.includes('没有授权内可推进事项时可以正常结束'));assert.ok(!text.includes('继续实际执行与验证'));
});
test('recent advice comes from native dialogue even when recent execution records omit it',()=>{
  const users=[{id:'human',text:'请继续'},{id:'a',text:'【长目标巡检建议 · A】旧办法'},...['b','c','d'].map(id=>({id,text:'【长目标巡检建议 · '+id+'】办法'})),{id:'human2',text:'这项建议我不同意'}];
  assert.deepEqual(recentReviewAdvice(users).map(x=>x.id),['b','c','d']);assert.equal(users.length,6);
  assert.deepEqual(recentReviewAdvice([{text:'普通用户提到【长目标巡检建议'}]),[]);
});
function searchFixture(t){
  const dir=fs.mkdtempSync(path.join('C:/Users/lop/Documents','goal-search-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const put=(file,text='NEEDLE -n [a]')=>{const p=path.join(dir,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);return p};
  return {dir,put};
}
test('literal source and structured-artifact search works through the inspection tool',async t=>{
  const {dir,put}=searchFixture(t);for(const name of ['src/main.mjs','src/view.tsx','src/job.py','result.json','events.jsonl','notes.md','trace.log'])put(name);
  const result=await inspect({op:'search',path:dir,query:'NEEDLE -n [a]'});
  assert.equal(result.scannedFiles,7);assert.equal(result.complete,true);assert.equal(result.next,null);
  for(const name of ['main.mjs','view.tsx','job.py','result.json','events.jsonl','notes.md','trace.log'])assert.ok(result.text.includes(name+':1:'),name);
});
test('recursive search excludes credentials, generated trees, and junction escape paths',t=>{
  const {dir,put}=searchFixture(t);put('src/ok.ts');
  for(const name of ['auth.json','.env','account-pool.json','private-token.ts','secrets/data.json','credentials/data.json'])put(name,'NEEDLE SECRET_MUST_NOT_APPEAR');
  for(const name of ['node_modules/vendor.js','.git/state.json','dist/output.js','_历史版本/old.json'])put(name,'NEEDLE GENERATED_MUST_NOT_APPEAR');
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'goal-search-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'outside.ts'),'NEEDLE OUTSIDE_MUST_NOT_APPEAR');fs.symlinkSync(outside,path.join(dir,'linked-source'),'junction');
  const r=searchProject({path:dir,query:'NEEDLE'});
  assert.ok(r.text.includes('ok.ts'));assert.ok(!r.text.includes('MUST_NOT_APPEAR'));assert.equal(r.skipped.sensitive,6);assert.equal(r.skipped.generated,4);assert.equal(r.skipped.symlink,1);
  assert.throws(()=>searchProject({path:path.join(dir,'auth.json'),query:'NEEDLE'}),/denied/);
  assert.throws(()=>searchProject({path:path.join(dir,'linked-source'),query:'NEEDLE'}),/denied/);
});
test('source search paginates without dropping matches and distinguishes no hits',t=>{
  const {dir,put}=searchFixture(t);put('many.ts',Array.from({length:90},(_,i)=>`needle line ${i}`).join('\n'));
  const full=searchProject({path:dir,query:'needle',limit:60000});let offset=0,text='',pages=0;
  do{const r=searchProject({path:dir,query:'needle',offset,limit:1000});text+=r.text;offset=r.next;pages++;assert.ok(pages<20);if(offset!==null){assert.equal(r.reason,'page-limit');assert.equal(r.totalChars,null)}}while(offset!==null);
  assert.equal(text,full.text);assert.ok(pages>1);
  const missing=searchProject({path:dir,query:'absent'});assert.equal(missing.text,'');assert.equal(missing.complete,true);assert.equal(missing.totalChars,0);
});
test('large lines are explicit excerpts; oversized files and time budget are not hidden',t=>{
  const {dir,put}=searchFixture(t);put('long.json','x'.repeat(4000)+'NEEDLE'+'y'.repeat(4000));
  const big=put('big.json','');const fd=fs.openSync(big,'r+');try{fs.ftruncateSync(fd,32*1024*1024+1)}finally{fs.closeSync(fd)}
  const r=searchProject({path:dir,query:'NEEDLE'});assert.ok(r.text.includes('NEEDLE'));assert.ok(r.text.includes('[line excerpt; use read]'));assert.equal(r.skipped.oversize,1);
  let calls=0;t.mock.method(Date,'now',()=>++calls===1?0:16000);
  const timed=searchProject({path:dir,query:'NEEDLE'});assert.equal(timed.complete,false);assert.match(timed.reason,/search-budget-reached/);assert.equal(timed.totalChars,null);
});
