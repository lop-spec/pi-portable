import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runClaudeAttempts,quotaExhausted,FABLE_MODEL,OPUS_MODEL} from '../src/goal-claude-review.mjs';
import {reviewSessionBinding} from '../src/goal-review-session.mjs';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture({first='quota',second='ok',initiallyBound=true}={}){
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'goal-quota-')),binding=reviewSessionBinding(work);if(initiallyBound)binding.bind(id);
  const calls=[],events=[];
  const execute=async(bin,args,options)=>{
    const model=args[args.indexOf('--model')+1],mode=calls.length?second:first;calls.push({args,input:options.input,timeout:options.timeout});
    const emit=e=>options.onLine(JSON.stringify(e));
    emit({type:'system',subtype:'init',session_id:mode==='identity'?'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb':id,model});
    if(mode==='warning')emit({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning',rateLimitType:'seven_day',utilization:.99}});
    if(['ok','warning','model-mismatch'].includes(mode)){
      emit({type:'assistant',message:{model:mode==='model-mismatch'?'claude-sonnet-5':model,content:[{type:'text',text:'ok'}]}});
      emit({type:'result',is_error:false,session_id:id,result:'ok'});return {};
    }
    if(mode==='identity'){throw Error('native failed')}
    if(mode==='quota-event'){emit({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'seven_day_fable',resetsAt:1800000000}})}
    const text={quota:"You've hit your Fable limit · resets 3:45pm",'quota-event':'Request rejected',auth:'Invalid authentication token',overload:'API Error: 529 overloaded',throttle:'Request rejected (429)',context:'Context limit reached',network:'Connection reset'}[mode];
    emit({type:'assistant',error:mode==='auth'?'authentication_failed':'rate_limit',message:{model:'<synthetic>',content:[{type:'text',text}]}});
    emit({type:'result',is_error:true,session_id:id,result:text});throw Error('CLI exit 1');
  };
  const args={job:{source:'desktop-3egb4lb',probe:true,prompt:'巡检模型：claude-fable-5-1/high。'},bin:'claude.exe',env:{},work,binding,execute,emit:e=>events.push(e)};
  return {args,calls,events,binding};
}
test('primary success and warning never call a second model',async()=>{for(const first of ['ok','warning']){const f=fixture({first});const r=await runClaudeAttempts(f.args);assert.equal(f.calls.length,1);assert.equal(r.model,FABLE_MODEL);assert.equal(r.effort,'high');assert.equal(r.fallback,undefined)}});
test('native quota text or rejected subscription quota resumes the same session on Opus 5 xhigh',async()=>{for(const first of ['quota','quota-event']){const f=fixture({first});const r=await runClaudeAttempts(f.args);assert.equal(f.calls.length,2);assert.equal(r.model,OPUS_MODEL);assert.equal(r.effort,'xhigh');assert.equal(r.reviewSession,id);assert.equal(r.fallback.reason,'quota-exhausted');assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--resume')+1],id);assert.ok(f.calls[1].input.includes('巡检模型：claude-opus-5/xhigh。'));assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--effort')+1],'xhigh');assert.ok(f.events.some(e=>e.event==='claude-fallback'&&e.reason==='quota-exhausted'));assert.ok(!f.calls[1].args.includes('--fork-session'))}});
test('an exhausted first-ever turn binds its init identity before fallback',async()=>{const f=fixture({initiallyBound:false});await runClaudeAttempts(f.args);assert.equal(f.binding.id,id);assert.equal(f.calls[0].args.includes('--resume'),false);assert.ok(f.calls[1].args.includes('--resume'))});
test('authentication, overload, generic 429, network, context and model mismatch never trigger quota fallback',async()=>{for(const first of ['auth','overload','throttle','network','context','model-mismatch','identity']){const f=fixture({first});await assert.rejects(runClaudeAttempts(f.args));assert.equal(f.calls.length,1);assert.ok(f.events.some(e=>e.event==='claude-attempt-failed'))}});
test('Opus failure is terminal, not a chain or loop',async()=>{const f=fixture({second:'quota'});await assert.rejects(runClaudeAttempts(f.args));assert.equal(f.calls.length,2);assert.ok(f.events.some(e=>e.event==='claude-attempt-failed'&&e.model===OPUS_MODEL))});
test('each scheduler round starts with Fable again without stale fallback state',async()=>{const f=fixture();await runClaudeAttempts(f.args);f.calls.length=0;await runClaudeAttempts(f.args);assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--model')+1],FABLE_MODEL)});
test('unbound quota failure cannot create a second dialogue; logs why',async()=>{
  const f=fixture({initiallyBound:false});f.args.execute=async(bin,args,{onLine})=>{onLine(JSON.stringify({type:'result',is_error:true,result:"You've hit your Fable limit"}));throw Error('exit 1')};
  await assert.rejects(runClaudeAttempts(f.args),/refusing to create/);assert.ok(f.events.some(e=>e.event==='claude-fallback-skipped'));
});
test('quota wording in a successful model answer is not a failure signal',async()=>{
  const f=fixture();f.args.execute=async(bin,args,{onLine})=>{onLine(JSON.stringify({type:'assistant',message:{model:FABLE_MODEL}}));onLine(JSON.stringify({type:'result',session_id:id,is_error:false,result:"You've hit your Fable limit"}));return {}};
  const r=await runClaudeAttempts(f.args);assert.equal(r.model,FABLE_MODEL);assert.equal(r.fallback,undefined);
});
test('both attempts keep read-only MCP, session lock scope, thinking enabled and one total deadline',async()=>{
  const f=fixture();f.args.job.probe=false;await runClaudeAttempts(f.args);
  for(const c of f.calls){assert.equal(c.args[c.args.indexOf('--allowedTools')+1],'mcp__goal_source__goal_inspect');assert.equal(c.args[c.args.indexOf('--tools')+1],'');assert.equal(JSON.parse(c.args[c.args.indexOf('--settings')+1]).alwaysThinkingEnabled,true);assert.ok(c.timeout<=35*60000)}
  assert.ok(f.calls[1].timeout<=f.calls[0].timeout);
});
test('quota classification excludes context, throttles, warnings and model-generated text',()=>{
  for(const text of ["You've hit your limit · resets 4pm",'Credit balance is too low','Usage limit reached','quota_exceeded','Fable usage credits exhausted'])assert.equal(quotaExhausted({text}),true,text);
  for(const text of ['Request rejected (429)','Too many requests','Rate limit exceeded','Context limit reached',"You've hit your context limit",'Prompt is too long','Authentication failed','Usage credits required for 1M context'])assert.equal(quotaExhausted({text}),false,text);
  assert.equal(quotaExhausted({rateLimit:{status:'allowed_warning',rateLimitType:'five_hour'}}),false);
  assert.equal(quotaExhausted({rateLimit:{status:'rejected'}}),false);
});
