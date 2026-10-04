import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {taskPrompt,stripTaskPrompts,renderTaskPrompt,loadTaskPrompt,taskModelSettings,loadTaskModelSettings,globalRuleSection,providerExtensionArgs,usesCodexQuota} from '../src/task-prompts.mjs';
import {site} from '../src/goal-inspect.mjs';
import path from 'node:path';
import {reviewPrompt,activeGoalText,emptyGoals,parseDecisions} from '../src/goal-review.mjs';
import {parseLongGoals} from '../src/long-goals.mjs';
const wrap=(id,body,settings='openai-codex/gpt-6-astra/low')=>`<!-- scheduled-prompts:start -->\n## ${id}〔${settings}〕\n<!-- task-prompt:${id} -->\n${body}\n<!-- /task-prompt:${id} -->\n<!-- scheduled-prompts:end -->`;
test('extract only selected task; reject missing, duplicate, empty and malformed boundaries',()=>{
  assert.equal(taskPrompt(wrap('a','hello'),'a'),'hello');
  for(const text of [wrap('b','hello'),wrap('a',''),wrap('a','x')+wrap('a','x'),wrap('a','x').replace('<!-- scheduled-prompts:end -->','')]) assert.throws(()=>taskPrompt(text,'a'));
  assert.throws(()=>stripTaskPrompts('<!-- scheduled-prompts:start -->'));
});
test('scheduled task model settings are read from heading suffixes and never become goals',()=>{
  // Exact parsing is pinned on fixtures; the live list is user-editable, so only its validity is checked.
  const fixture=wrap('goal-review-fable','x','claude-code/claude-fable-5-1/high;fallback=claude-opus-5/xhigh');
  const parsed=taskModelSettings(fixture,'goal-review-fable');
  assert.deepEqual([parsed.provider,parsed.model,parsed.thinkingLevel],['claude-code','claude-fable-5-1','high']);
  assert.deepEqual(parsed.fallback,{model:'claude-opus-5',thinkingLevel:'xhigh',effort:'xhigh'});
  const astra=taskModelSettings(wrap('goal-review-astra','x','openai-codex/gpt-6-astra/low'),'goal-review-astra');
  assert.deepEqual([astra.provider,astra.model,astra.thinkingLevel],['openai-codex','gpt-6-astra','low']);
  const root=path.dirname(site().data),text=fs.readFileSync(path.join(site().data,'长目标清单.md'),'utf8');
  const ids=[...text.matchAll(/<!-- task-prompt:([a-z0-9-]+) -->/g)].map(m=>m[1]);
  assert.ok(ids.length>0,'live goal list must define scheduled task prompts');
  for(const id of ids){
    const value=loadTaskModelSettings(root,id);
    assert.ok(value.provider&&value.model&&value.thinkingLevel,`live task ${id} must carry a full model triple`);
    assert(!activeGoalText(text).includes(id));
  }
  assert.throws(()=>taskModelSettings(wrap('a','x','not-a-model'),'a'),/模型配置无效/);
});
test('prompt area never becomes active goals, including legacy structured parser',()=>{
  const area=wrap('a','## not a goal\nprivate other task');
  assert.equal(activeGoalText(area+'\n# 长目标清单').trim(),'# 长目标清单');
  assert(emptyGoals(area+'\n# 长目标清单'));
  assert.deepEqual(parseLongGoals(area+'\n# 长目标清单'),[]);
  assert.throws(()=>parseDecisions(JSON.stringify({decisions:[{goalQuote:'private other task',action:'observe',reason:'x',backgroundPids:[]}]}),area+'\n真正目标'));
});
test('edited per-profile prompt is used directly; runtime text is not recursively interpolated',()=>{
  const text=wrap('goal-review-astra','用户新版提示 {{goals}} {{model}} {{catalog}}','openai-codex/gpt-6-luna/max')+'\n# 真实目标 {{unknown}}';
  const result=reviewPrompt('astra',text,{sessions:[]});
  assert(result.startsWith('用户新版提示'));
  assert(result.includes('# 真实目标 {{unknown}}'));
  assert(result.includes('gpt-6-luna'));
  assert(result.includes('"effort":"max"'));
  assert(!result.includes('scheduled-prompts'));
  assert(result.includes(globalRuleSection(site().agent,'目标实现')));
  assert(result.includes('不由巡检执行'));
  assert.throws(()=>reviewPrompt('fable',text,{sessions:[]}));
  assert.throws(()=>renderTaskPrompt('{{missing}}',{}));
});
test('a review profile removed from the goal list is skipped before any inspection',async()=>{
  const {tick}=await import('../src/goal-review.mjs');
  const os=await import('node:os');
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'profile-removed-')),goalsFile=path.join(work,'goals.md');
  fs.writeFileSync(goalsFile,wrap('goal-review-astra','review')+'\n# 长目标清单\n1. 目标：只保留 Astra 巡检');
  const events=[];
  const result=await tick('fable',{work,goalsFile,logFn:(event,details)=>events.push([event,details?.reason]),inspectSource:()=>{throw Error('must not inspect')},quotaCheck:async()=>{throw Error('must not reserve')}});
  assert.deepEqual(result,{skipped:'profile-not-configured',modelCalls:0});
  assert.ok(events.some(([event,reason])=>event==='skip'&&reason==='profile-not-in-goal-list'),'skip reason must be logged');
});
test('web-model task headings load the shared web extension and skip the codex quota',()=>{
  const agent=fs.mkdtempSync(path.join(os.tmpdir(),'task-provider-'));
  fs.mkdirSync(path.join(agent,'extensions','pi-chatgpt-web'),{recursive:true});
  fs.writeFileSync(path.join(agent,'extensions','pi-chatgpt-web','index.ts'),'');
  const file=path.join(agent,'extensions','pi-chatgpt-web','index.ts');
  for(const provider of ['pi-chatgpt-web','pi-mimo-web']){
    assert.deepEqual(providerExtensionArgs(agent,provider),['--extension',file]);
    assert.equal(usesCodexQuota(provider),false);
  }
  assert.deepEqual(providerExtensionArgs(agent,'openai-codex'),[]);
  assert.equal(usesCodexQuota('openai-codex'),true);
  assert.deepEqual(taskModelSettings(wrap('m','x','pi-mimo-web/mimo-web-pro/high'),'m'),{provider:'pi-mimo-web',model:'mimo-web-pro',thinkingLevel:'high',effort:'high'});
  fs.rmSync(agent,{recursive:true,force:true});
});
test('alternate=on rotates primary/fallback per run and first-round model failures are detected',async()=>{
  const {modelOrder,modelKey,firstRoundModelFailure,switchSessionModel}=await import('../src/task-prompts.mjs');
  const head='pi-mimo-web/mimo-web-pro/high;fallback=pi-gemini-web/gemini-web-3.8-flash/high;alternate=on;resume=pi-mimo-web/mimo-web-pro/high';
  const settings=taskModelSettings(wrap('goal-review-astra','x',head),'goal-review-astra');
  assert.equal(settings.alternate,true);
  assert.throws(()=>taskModelSettings(wrap('a','x','pi-mimo-web/mimo-web-pro/high;alternate=on'),'a'),/alternate 需要 fallback/);
  assert.throws(()=>taskModelSettings(wrap('a','x',head.replace('alternate=on','alternate=yes')),'a'),/alternate 只接受 on/);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotation-'));const file=path.join(dir,'r.json');
  const firsts=[1,2,3,4].map(()=>modelOrder(settings,file).order[0].provider);
  assert.deepEqual(firsts,['pi-mimo-web','pi-gemini-web','pi-mimo-web','pi-gemini-web']);
  const {order}=modelOrder(settings,file);assert.deepEqual(order.map(modelKey),['pi-mimo-web/mimo-web-pro/high','pi-gemini-web/gemini-web-3.8-flash/high']);
  // 无 alternate：固定首选在前，不写状态
  const fixed=taskModelSettings(wrap('m','x','pi-mimo-web/mimo-web-pro/high;fallback=pi-gemini-web/gemini-web-3.8-flash/high'),'m');
  const f2=path.join(dir,'none.json');assert.deepEqual(modelOrder(fixed,f2).order.map(m=>m.provider),['pi-mimo-web','pi-gemini-web']);assert.equal(fs.existsSync(f2),false);
  // 只写 model/level 的 fallback 沿用首选 provider
  assert.equal(modelOrder(taskModelSettings(wrap('m','x','openai-codex/gpt-6-sol/high;fallback=gpt-6-luna/high'),'m')).order[1].provider,'openai-codex');
  // 第一轮失败判定
  const sess=(...ms)=>{const p=path.join(dir,`s${Math.random()}.jsonl`);fs.writeFileSync(p,ms.map(m=>JSON.stringify({type:'message',message:m})).join('\n'));return p;};
  assert.equal(firstRoundModelFailure(sess({role:'user'},{role:'assistant',stopReason:'error',errorMessage:'ACBOTER_ROW_AMBIGUOUS'})),'ACBOTER_ROW_AMBIGUOUS');
  assert.equal(firstRoundModelFailure(sess({role:'user'},{role:'assistant',stopReason:'toolUse'},{role:'toolResult'},{role:'assistant',stopReason:'error'})),null,'after a tool ran, never replay');
  assert.equal(firstRoundModelFailure(sess({role:'user'},{role:'assistant',stopReason:'stop'})),null);
  assert.equal(firstRoundModelFailure(path.join(dir,'missing.jsonl')),null);
  // 同会话切模型并读回
  const calls=[];const api=async(route,body)=>{calls.push(body.type);return body.type==='get_state'?{data:{model:{provider:'pi-gemini-web',id:'gemini-web-3.8-flash'},thinkingLevel:'high'}}:{}};
  await switchSessionModel(api,'/r',order[1]);assert.deepEqual(calls,['set_model','set_thinking_level','get_state']);
  await assert.rejects(switchSessionModel(api,'/r',order[0]),/读回不一致/);
  fs.rmSync(dir,{recursive:true,force:true});
});
