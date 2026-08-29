#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  listEvents,
  recordStop,
  resolveHistory,
  scanHistory,
} from '../src/chain/lop-memory.mjs';
import { canonicalStats } from '../src/chain/memory-canonical.mjs';

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lop-pi-history-'));
  const dataRoot = path.join(root, 'memory');
  const sessions = path.join(root, '.pi', 'agent', 'sessions', '--workspace--');
  const file = path.join(sessions, '2026-08-28T05-15-11-002Z_11111111-1111-7111-8111-111111111111.jsonl');
  const sshPrompt = '任务：配置本机 SSH，与另一台 Windows 建立双向免密互信。';
  writeJsonl(file, [
    { type: 'session', version: 3, id: '11111111-1111-7111-8111-111111111111', timestamp: '2026-08-28T05:15:11.002Z', cwd: 'D:\\work' },
    { type: 'session_info', id: 'name0001', parentId: null, timestamp: '2026-08-28T05:15:12.000Z', name: '配置双向 SSH 免密互信' },
    { type: 'message', id: 'user0001', parentId: 'name0001', timestamp: '2026-08-28T05:15:23.692Z', message: { role: 'user', content: [{ type: 'text', text: sshPrompt }], timestamp: 1787894123692 } },
    { type: 'message', id: 'assist01', parentId: 'user0001', timestamp: '2026-08-28T05:16:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '先检查 SSH 服务。' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } }], stopReason: 'toolUse', timestamp: 1787894160000 } },
    { type: 'message', id: 'tool0001', parentId: 'assist01', timestamp: '2026-08-28T05:16:01.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1787894161000 } },
    { type: 'message', id: 'assist02', parentId: 'tool0001', timestamp: '2026-08-28T05:16:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '对端返回 Permission denied，尚未成功。请写入公钥后回复确认。' }], stopReason: 'stop', timestamp: 1787894170000 } },
    { type: 'message', id: 'userstat', parentId: 'assist02', timestamp: '2026-08-28T05:16:20.000Z', message: { role: 'user', content: [{ type: 'text', text: '两边都能双向了吗？' }], timestamp: 1787894180000 } },
    { type: 'message', id: 'assistok', parentId: 'userstat', timestamp: '2026-08-28T05:16:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '双向 SSH 免密已实测成功：MACHINE1 到 MACHINE2 与反向均通过。' }], stopReason: 'stop', timestamp: 1787894190000 } },
    { type: 'message', id: 'user0002', parentId: 'assistok', timestamp: '2026-08-28T05:17:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '解释 JSONL 与 JSON 的关键区别。' }], timestamp: 1787894220000 } },
    { type: 'message', id: 'assist03', parentId: 'user0002', timestamp: '2026-08-28T05:17:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'JSONL 每行一个 JSON 值，JSON 通常是一个完整文档。' }], stopReason: 'stop', timestamp: 1787894225000 } },
  ]);
  const config = {
    enabled: true,
    scanOnPrompt: false,
    recordOnStop: true,
    weeklyEnabled: false,
    maxContextChars: 1000,
    maxContextBytes: 2048,
    topK: 4,
    recallTopK: 12,
    recallCandidateLimit: 150,
    recallMaxChars: 20000,
    categoryLeafLimit: 50,
    eventMaxChars: 20,
    clusterMaxChars: 30,
    promptMaxChars: 6000,
    answerMaxChars: 6000,
    lockStaleMinutes: 30,
    historyRoots: [{ kind: 'pi', path: sessions }],
  };
  return { root, dataRoot, config, sshPrompt, file };
}

test('Pi v3 JSONL is indexed as completed turns and deterministically canonicalized', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const scanned = await scanHistory({ dataRoot: fx.dataRoot, config: fx.config });
  assert.equal(scanned.physicalSources, 1);
  assert.equal(scanned.uniqueSources, 1);
  const events = listEvents({ dataRoot: fx.dataRoot, config: fx.config });
  assert.equal(events.length, 3);
  assert.ok(events.every((row) => row.kind === 'pi' && row.complete));
  assert.match(events.find((row) => row.prompt.includes('SSH')).answer, /Permission denied/u);
  assert.match(events.find((row) => row.prompt.includes('两边')).answer, /双向 SSH 免密已实测成功/u);

  const db = new DatabaseSync(path.join(fx.dataRoot, 'index.sqlite3'), { readOnly: true });
  try {
    const stats = canonicalStats(db);
    assert.equal(stats.events, 3);
    assert.equal(stats.inbox, 0);
  } finally {
    db.close();
  }

  fs.appendFileSync(fx.file, [
    { type: 'message', id: 'userlin1', parentId: 'assist03', timestamp: '2026-08-28T05:18:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '线性追加检查 Redis 状态。' }] } },
    { type: 'message', id: 'assistl1', parentId: 'userlin1', timestamp: '2026-08-28T05:18:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Redis 状态已确认。' }], stopReason: 'stop' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const linear = await scanHistory({ dataRoot: fx.dataRoot, config: fx.config });
  assert.equal(linear.appendedSources, 1);
  assert.ok(listEvents({ dataRoot: fx.dataRoot, config: fx.config })
    .some((row) => row.turnId === 'userlin1' && /Redis 状态已确认/u.test(row.answer)));

  fs.appendFileSync(fx.file, [
    { type: 'message', id: 'userbr01', parentId: 'assist02', timestamp: '2026-08-28T05:18:20.000Z', message: { role: 'user', content: [{ type: 'text', text: '分支复核 TLS 状态。' }] } },
    { type: 'message', id: 'assistb1', parentId: 'userbr01', timestamp: '2026-08-28T05:18:25.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'TLS 分支复核完成。' }], stopReason: 'stop' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const branched = await scanHistory({ dataRoot: fx.dataRoot, config: fx.config });
  assert.equal(branched.appendedSources, 0);
  assert.ok(listEvents({ dataRoot: fx.dataRoot, config: fx.config })
    .some((row) => row.turnId === 'userbr01' && /TLS 分支复核完成/u.test(row.answer)));
});

test('SSH history-reference paraphrase hits highly relevant summary20+full, unrelated intent stays out', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  await scanHistory({ dataRoot: fx.dataRoot, config: fx.config });

  const recursiveWrong = await recordStop({
    session_id: 'recursive-history-answer',
    turn_id: 'recursive-wrong-turn',
    prompt: 'SSH 双向免密是否成功？请只根据相关历史结论回答。',
    last_assistant_message: '仅根据当前相关历史结论，无法确认 SSH 双向免密已成功。',
    transcript_path: '',
  }, { dataRoot: fx.dataRoot, config: fx.config });
  assert.equal(recursiveWrong.canonical.saved, true, JSON.stringify(recursiveWrong));
  const constrainedHit = await resolveHistory(
    'SSH 双向免密是否成功？请只根据相关历史结论回答。',
    {
      dataRoot: fx.dataRoot,
      config: fx.config,
      refresh: false,
      sessionId: 'new-session',
      maxFullChars: 800,
    },
  );
  assert.equal(constrainedHit.hit, true, JSON.stringify(constrainedHit));
  assert.equal(constrainedHit.mode, 'assoc');
  assert.ok(constrainedHit.relevance >= 0.82);
  assert.notEqual(constrainedHit.eventId, recursiveWrong.canonical.eventId);
  assert.match(constrainedHit.summary20, /SSH|双向|免密/iu);
  assert.match(constrainedHit.full, /双向 SSH 免密已实测成功/iu);
  assert.doesNotMatch(constrainedHit.full, /无法确认|Permission denied/iu);

  const hit = await resolveHistory('刚刚的 SSH 双向免密对话是否成功？', {
    dataRoot: fx.dataRoot,
    config: fx.config,
    refresh: false,
    sessionId: 'new-session',
    maxFullChars: 800,
  });
  assert.equal(hit.hit, true, JSON.stringify(hit));
  assert.equal(hit.mode, 'assoc');
  assert.ok(hit.relevance >= 0.82);
  assert.match(hit.summary20, /SSH|双向|免密/iu);
  assert.match(hit.full, /双向 SSH 免密已实测成功/iu);
  assert.doesNotMatch(hit.full, /Permission denied/iu);
  assert.ok([...hit.summary20].length <= 20);
  assert.ok([...hit.full].length <= 800);

  const rootTaskHit = await resolveHistory('配置双向 SSH 免密互信', {
    dataRoot: fx.dataRoot,
    config: fx.config,
    refresh: false,
    sessionId: 'new-session',
    maxFullChars: 800,
  });
  assert.equal(rootTaskHit.hit, true, JSON.stringify(rootTaskHit));
  assert.match(rootTaskHit.full, /双向 SSH 免密已实测成功/iu);
  assert.doesNotMatch(rootTaskHit.full, /Permission denied/iu);

  const baseExpansionProbe = await resolveHistory('两台机器现在互通状态怎么样？', {
    dataRoot: fx.dataRoot,
    config: fx.config,
    refresh: false,
    sessionId: 'new-session',
  });
  assert.equal(baseExpansionProbe.hit, false, JSON.stringify(baseExpansionProbe));
  const expandedHit = await resolveHistory('两台机器现在互通状态怎么样？', {
    dataRoot: fx.dataRoot,
    config: fx.config,
    refresh: false,
    sessionId: 'new-session',
    candidateQuery: '两台机器现在互通状态怎么样 SSH 双向 免密 公钥认证',
    associationTerms: 'SSH 双向 免密',
  });
  assert.equal(expandedHit.hit, true, JSON.stringify(expandedHit));
  assert.equal(expandedHit.diagnostics.candidateQueryExpanded, true);

  const mismatch = await resolveHistory('解释 SSH 与 TLS 的协议层区别。', {
    dataRoot: fx.dataRoot,
    config: fx.config,
    refresh: false,
    sessionId: 'new-session',
  });
  assert.equal(mismatch.hit, false, JSON.stringify(mismatch));
});

test('Stop without a model-authored marker still creates canonical summary20+full', async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const saved = await recordStop({
    session_id: 'live-pi',
    turn_id: 'live-turn',
    prompt: '检查 SSH 双向免密状态',
    last_assistant_message: '已实测两个方向均成功。',
    transcript_path: '',
  }, { dataRoot: fx.dataRoot, config: fx.config });
  assert.equal(saved.canonical.saved, true, JSON.stringify(saved));
  assert.equal(saved.canonical.derived, true);
  const db = new DatabaseSync(path.join(fx.dataRoot, 'index.sqlite3'), { readOnly: true });
  try {
    assert.equal(canonicalStats(db).events, 1);
    assert.equal(canonicalStats(db).inbox, 0);
  } finally {
    db.close();
  }
});
