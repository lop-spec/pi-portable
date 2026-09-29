import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The guard is opt-in (PI_GOAL_REVIEW_QUOTA_GUARD=1) and read at module load; these cases exercise it enabled.
process.env.PI_GOAL_REVIEW_QUOTA_GUARD='1';
const {tick}=await import('../src/goal-review.mjs');
import {site} from '../src/goal-inspect.mjs';
import {forecast,evaluateReserve,normalizeAccount} from '../src/scheduled-quota-policy.mjs';
const now=1800000000000,H=3600000;
const a=(remaining,h=100,cards=[])=>({remaining,resetAt:now+h*H,cards});
test('both real review entrypoints deny before inspection or model startup',async()=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'quota-denial-'));
  const goalsFile=path.join(work,'goals.md');fs.writeFileSync(goalsFile,'# 长目标清单\n1. 目标：核验额度预留拒绝路径，不调用任何模型');
  for(const profile of ['astra','fable']){
    let inspected=0,checked=0;
    const result=await tick(profile,{work,goalsFile,inspectSource:()=>{inspected++;throw Error('must not inspect');},logFn:()=>{},quotaCheck:async()=>{checked++;return {allow:false,reason:'test-low-quota'};}});
    assert.equal(result.skipped,'quota-reserve');assert.equal(result.modelCalls,0);assert.equal(inspected,0);assert.equal(checked,1);
  }
});
test('no refresh: two days 120 + 10% rate margin + 6 immediate + 10 task = 148',()=>{assert.equal(evaluateReserve([a(74),a(74)],{now}).allow,true);assert.equal(evaluateReserve([a(73),a(74)],{now}).allow,false);});
test('refill makes a material difference; not counted before its timestamp',()=>{assert.equal(evaluateReserve([a(80,20),a(0,25)],{now}).allow,true);assert.equal(evaluateReserve([a(80,60),a(0,65)],{now}).allow,false);assert.equal(evaluateReserve([a(14,20),a(0,25)],{now}).allow,false);});
test('cannot borrow tomorrow quota to bridge today gap',()=>{assert.equal(forecast([a(1,1),a(0,2),a(0,3)],0,now),false);});
test('near refresh allows draining old balance but protects every segment',()=>{const early=evaluateReserve([a(90,1),a(60,30)],{now});const late=evaluateReserve([a(90,60),a(60,70)],{now});assert.ok(early.expectedMinimumPercent<late.expectedMinimumPercent);assert.ok(early.expectedMinimumPercent>=18.75-0.01);});
test('cards reserved for human demand; cannot fund automated spend',()=>{assert.equal(forecast([a(0,100,['one','two'])],0,now),true);assert.equal(evaluateReserve([a(0,100,['one','two'])],{now}).allow,false);assert.equal(evaluateReserve([a(20,100,['one','two'])],{now}).allow,true);});
test('card cancels old natural reset, no double counting',()=>{assert.equal(forecast([a(0,10,['one'])],0,now),false);});
test('reservations cannot be double-spent by overlapping jobs',()=>{const pool=[a(80),a(80)];assert.equal(evaluateReserve(pool,{now,reserved:10}).allow,true);assert.equal(evaluateReserve(pool,{now,reserved:20}).allow,false);});
test('missing capacity and stale reset excluded, never rounded up',()=>{const usage={plan_type:'pro',rate_limit:{allowed:true,primary_window:{used_percent:98.7,reset_at:(now+H)/1000,limit_window_seconds:604800}}};const account=normalizeAccount({id:'a',usage},now);assert.ok(Math.abs(account.remaining-1.3)<1e-8);assert.ok(normalizeAccount({id:'a',usage:{...usage,plan_type:'prolite'}},now).excluded);assert.ok(normalizeAccount({id:'a',usage},now+2*H).excluded);});
test('bank balance alone is not a usable reset card',()=>{const usage={plan_type:'pro',rate_limit:{allowed:true,primary_window:{used_percent:50,reset_at:(now+100*H)/1000,limit_window_seconds:604800}}};const card={id:'c',status:'available',is_supported_by_plan:true,reset_type:'codex_weekly',expires_at:new Date(now+49*H).toISOString()};const norm=(cards,autoReset=true)=>normalizeAccount({id:'a',usage,cards,autoReset},now);assert.equal(norm({available_count:5}).cards.length,0);assert.equal(norm({available_count:2,credits:[card,card]}).cards.length,1);assert.equal(norm({available_count:1,credits:[card]},false).cards.length,0);assert.equal(norm({available_count:1,credits:[{...card,reset_type:'codex_five_hour'}]}).cards.length,0);assert.equal(norm({available_count:1,credits:[{...card,expires_at:new Date(now+47*H).toISOString()}]}).cards.length,0);});
test('reserve threshold reports shortage rather than current balance + 10',()=>{const r=evaluateReserve([a(14)],{now});assert.equal(r.expectedMinimumPercent,148);});
test('no future refill at horizon can cover preceding shortfall',()=>{assert.equal(evaluateReserve([a(0,48)],{now}).allow,false);});
test('monotonic spend and temporal coverage in varied fixtures',()=>{for(let i=0;i<80;i++){const pool=[a(i%101,1+i%47),a((i*7)%101,10+i%61)];let failed=false;for(let spend=0;spend<=200;spend+=2){const ok=forecast(pool,spend,now);if(!ok)failed=true;else assert.equal(failed,false);}}});
test('only high-frequency entries opt in; daily/3-day automations unchanged',()=>{const review=fs.readFileSync(new URL('../src/goal-review.mjs',import.meta.url),'utf8');const quotaAt=review.indexOf('task:`long-goals-${profile}`'),inspectAt=review.indexOf("inspectSource({op:'catalog'})");assert.ok(quotaAt>0&&inspectAt>quotaAt,'quota admission must precede the first inspection');for(const dir of ['daily-astra-ideas','daily-pi-memory','prod-rds-mysql-prod','sql-insight-sync-health']){const candidates=[path.join(site().agent,'automations',dir,'run.mjs'),path.join(site().data,'.pi/agent/automations',dir,'run.mjs')];const file=candidates.find(f=>fs.existsSync(f));assert.ok(file,`missing actual task source: ${dir}`);const text=fs.readFileSync(file,'utf8');assert.equal(text.includes('scheduled-quota-guard'),false);}});
