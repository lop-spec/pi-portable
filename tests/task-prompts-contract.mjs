import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {taskPrompt,stripTaskPrompts,renderTaskPrompt,loadTaskPrompt,taskModelSettings,loadTaskModelSettings,globalRuleSection} from '../src/task-prompts.mjs';
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
