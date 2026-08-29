#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executeDeterministicFastPath,
  planDeterministicFastPath,
  renderDeterministicEvidence,
} from '../src/chain/deterministic-fast-path.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fast-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, '.lop-acceptance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'sync.mjs'), [
    "if (process.argv.includes('--check')) console.log(JSON.stringify({ok:true}));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, '.lop-acceptance', 'unified-chain.txt'), 'alpha\n', 'utf8');
  return root;
}

test('plans only bounded top-five deterministic actions and rejects traversal', (t) => {
  const root = fixture(t);
  assert.equal(planDeterministicFastPath(
    '只读排查 tools/sync.mjs 能否被 Node 正常解析；给出最小证据，不修改任何文件。', root
  )?.kind, 'node-syntax');
  assert.equal(planDeterministicFastPath(
    '把 .lop-acceptance/unified-chain.txt 中的 alpha 改为 beta，并读回验证；只改这个文件。', root
  )?.kind, 'literal-replace');
  assert.equal(planDeterministicFastPath(
    '解释 JSONL 与 JSON 的一个关键区别，并给出各自一个最小适用场景。', root
  )?.kind, 'jsonl-json-explanation');
  assert.equal(planDeterministicFastPath(
    '只读检查 tools/sync.mjs 的文件大小，精确报告字节数；不修改文件。', root
  )?.kind, 'file-stat');
  assert.equal(planDeterministicFastPath(
    '执行 node tools/sync.mjs --check，并只报告是否通过；不得修改任何文件。', root
  )?.kind, 'node-check-run');
  assert.equal(planDeterministicFastPath(
    '只读检查 ../secret.txt 的文件大小，精确报告字节数；不修改文件。', root
  ), null);
  assert.equal(planDeterministicFastPath('执行任意生产命令', root), null);
});

test('executes direct argv/stat/literal replacement with readback and target hash evidence', (t) => {
  const root = fixture(t);
  const syntax = executeDeterministicFastPath(planDeterministicFastPath(
    '只读排查 tools/sync.mjs 能否被 Node 正常解析；给出最小证据，不修改任何文件。', root
  ), { cwd: root });
  assert.equal(syntax.status, 0);
  assert.equal(syntax.unchanged, true);

  const explanation = executeDeterministicFastPath(planDeterministicFastPath(
    '解释 JSONL 与 JSON 的一个关键区别，并给出各自一个最小适用场景。', root
  ));
  assert.equal(explanation.countsAsTool, false);
  assert.match(renderDeterministicEvidence(explanation, { usageToken: 'h_test' }),
    /逐字只输出[\s\S]*history-used:h_test/u);

  const stat = executeDeterministicFastPath(planDeterministicFastPath(
    '只读检查 tools/sync.mjs 的文件大小，精确报告字节数；不修改文件。', root
  ));
  assert.equal(stat.bytes, fs.statSync(path.join(root, 'tools', 'sync.mjs')).size);

  const run = executeDeterministicFastPath(planDeterministicFastPath(
    '执行 node tools/sync.mjs --check，并只报告是否通过；不得修改任何文件。', root
  ), { cwd: root });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /"ok":true/u);
  assert.equal(run.unchanged, true);

  const replacementPlan = planDeterministicFastPath(
    '把 .lop-acceptance/unified-chain.txt 中的 alpha 改为 beta，并读回验证；只改这个文件。', root
  );
  const changed = executeDeterministicFastPath(replacementPlan);
  assert.equal(changed.ok, true);
  assert.equal(fs.readFileSync(path.join(root, '.lop-acceptance', 'unified-chain.txt'), 'utf8'), 'beta\n');
  assert.match(renderDeterministicEvidence(changed), /读回为 "beta"/u);

  const second = executeDeterministicFastPath(replacementPlan);
  assert.equal(second.ok, false);
  assert.equal(second.count, 0);
  assert.equal(fs.readFileSync(path.join(root, '.lop-acceptance', 'unified-chain.txt'), 'utf8'), 'beta\n');
});
