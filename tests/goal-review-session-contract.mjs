import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reviewSessionBinding} from '../src/goal-review-session.mjs';
const one='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',two='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'goal-session-'));
test('Astra adopts then pins the exact existing native file across worker restarts',()=>{
  const work=temp(),file=path.join(work,'original.jsonl');fs.writeFileSync(file,'native history');
  const b=reviewSessionBinding(work);assert.deepEqual(b.args('astra'),['--continue']);b.bind(one,file);
  fs.writeFileSync(path.join(work,'newer-unrelated.jsonl'),'other history');
  assert.deepEqual(reviewSessionBinding(work).args('astra'),['--session',file]);
  assert.equal(reviewSessionBinding(work).bind(one,file),one);
});
test('Fable creates once then resumes its exact ID, never forks or disables persistence',()=>{
  const work=temp(),b=reviewSessionBinding(work);assert.deepEqual(b.args('fable'),[]);b.bind(one);
  assert.deepEqual(reviewSessionBinding(work).args('fable'),['--resume',one]);
  assert.equal(reviewSessionBinding(work).bind(one),one);
  const source=fs.readFileSync(new URL('../src/goal-claude-review.mjs',import.meta.url),'utf8');
  assert.ok(!source.includes('--no-session-persistence'));assert.ok(!source.includes('--fork-session'));
  assert.ok(source.includes("'fable',job.source"));assert.ok(source.includes('reviewSession:binding.id'));
});
test('unexpected identity change is rejected without overwriting the original binding',()=>{
  const work=temp(),b=reviewSessionBinding(work);b.bind(one);assert.throws(()=>b.bind(two),/changed unexpectedly/);
  assert.equal(reviewSessionBinding(work).id,one);
});
test('source machines have separate Fable identities',()=>{
  const root=temp();reviewSessionBinding(path.join(root,'desktop')).bind(one);reviewSessionBinding(path.join(root,'yangyong')).bind(two);
  assert.equal(reviewSessionBinding(path.join(root,'desktop')).id,one);assert.equal(reviewSessionBinding(path.join(root,'yangyong')).id,two);
});
test('missing pinned Pi history and corrupt identity do not silently start another dialogue',()=>{
  const work=temp();reviewSessionBinding(work).bind(one,path.join(work,'missing.jsonl'));
  assert.throws(()=>reviewSessionBinding(work).args('astra'),/refusing to create/);
  fs.writeFileSync(path.join(work,'review-session.json'),JSON.stringify({id:'invalid'}));
  assert.throws(()=>reviewSessionBinding(work),/Invalid fixed/);
});
