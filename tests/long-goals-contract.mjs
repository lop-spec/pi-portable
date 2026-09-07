import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLongGoals, loadLongGoals } from '../src/long-goals.mjs';
import { buildTasks } from '../src/quota-idle-scheduler.mjs';
const block = '## [ ] 示例目标\n- 标识：demo\n- 目录：C:/work\n- 来源会话：\n- 目标：实际执行\n- 验收：测试通过\n';
test('enabled goals parse; optional source; checked goals and fenced template never execute', () => {
  const text = '# 长目标清单\n### 使用方法\n```markdown\n'+block+'```\n'+block+'\n## [x] 已完成\n';
  assert.equal(parseLongGoals(text).length, 1);
  assert.equal(parseLongGoals(text)[0].sourceId, '');
  assert.equal(parseLongGoals('# 长目标清单\n当前没有长目标。').length, 0);
});
test('invalid list is observable; no hardcoded fallback', () => {
  assert.throws(() => parseLongGoals(block + block), /重复/);
  assert.throws(() => parseLongGoals(block.replace('验收：测试通过', '验收：')), /缺少验收/);
  assert.throws(() => parseLongGoals(block.replace('C:/work', 'work')), /绝对路径/);
  const logs=[];assert.deepEqual(loadLongGoals('C:/nonexistent-long-goals.md', (...a)=>logs.push(a)), []);
  assert.equal(logs[0][0], 'long-goals-unavailable');
});
test('machine-local files are isolated and reread each tick; arbitrary new goal needs no historical session', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-goals-'));
  const local=path.join(root,'local.md'),peer=path.join(root,'peer.md');
  fs.writeFileSync(local,'# 长目标清单\n'); fs.writeFileSync(peer,block.replace('C:/work',root));
  assert.equal(loadLongGoals(local,()=>{}).length,0);assert.equal(loadLongGoals(peer,()=>{}).length,1);
  const tasks=buildTasks([],Date.now(),()=>{},{longGoals:loadLongGoals(peer,()=>{})});
  assert.equal(tasks.length,1);assert.match(tasks[0].source.users[0],/实际执行/);
  fs.writeFileSync(peer,block.replace('[ ]','[x]'));
  assert.equal(loadLongGoals(peer,()=>{}).length,0);assert.equal(loadLongGoals(local,()=>{}).length,0);
});
