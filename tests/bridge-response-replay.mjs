#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { responseReplayIdentity, rewriteCodexRequestBody } from '../src/bridge/codex-cache-policy.mjs';
import { ExactResponseMemo } from '../src/bridge/codex-response-memo.mjs';

function payload(token) {
  return {
    model: 'gpt-5.6-sol',
    stream: true,
    metadata: { volatile: 'session-a' },
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: `<history-resolved mode="exact" relevance="1" usage="${token}">same semantic history</history-resolved>`,
      }],
    }, {
      role: 'user',
      content: [{ type: 'input_text', text: '解释 JSONL 与 JSON 的区别' }],
    }],
  };
}

test('Pi user-role exact history participates in stable response replay identity', () => {
  const first = responseReplayIdentity(payload('h_12345678'));
  const second = responseReplayIdentity(payload('h_abcdef123456'));
  assert.equal(first.enabled, true, JSON.stringify(first));
  assert.equal(second.enabled, true, JSON.stringify(second));
  assert.equal(first.key, second.key);
  assert.equal(first.usageToken, 'h_12345678');
  assert.equal(second.usageToken, 'h_abcdef123456');
});

test('proxy defaults every GPT-5.6 request to maximum reasoning', () => {
  const source = fs.readFileSync(new URL('../src/bridge/codex-responses-proxy.mjs', import.meta.url), 'utf8');
  const adversary = fs.readFileSync(new URL('../src/chain/portable-adversary.mjs', import.meta.url), 'utf8');
  assert.match(source, /gpt56-chain-replay-v7\.13\.0/u);
  assert.match(source, /requestWithOverloadRetry/u);
  assert.match(source, /selected\.prefixChunks/u);
  assert.match(source, /selected\.exhausted/u);
  assert.match(source, /gpt-5\.6-terra,gpt-5\.6-luna,gpt-reserve/u);
  assert.match(source, /x-lop-upstream-model/u);
  assert.match(source, /usedModelFallback/u);
  assert.match(source, /Only two item states are valid/u);
  assert.match(source, /Never use '\[~\]'/u);
  assert.match(source, /checked item saying the target was not met/u);
  assert.match(source, /CODEX_HISTORY_REPLAY_EFFORT \|\| "max"/u);
  assert.match(source, /CODEX_FORCE_REASONING_EFFORT \|\| "max"/u);
  assert.match(adversary, /reasoning: \{ effort: "max" \}/u);
  assert.match(adversary, /PI_CODING_AGENT_DIR/u);
  assert.match(adversary, /\.pi", "agent", "auth\.json"/u);
  assert.doesNotMatch(adversary, /reasoning: \{ effort: "low" \}/u);

  const rewritten = rewriteCodexRequestBody(Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'low', summary: 'auto' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'probe' }] }],
  })), { 'content-type': 'application/json' }, { forceReasoningEffort: 'max' });
  const payload = JSON.parse(rewritten.body.toString('utf8'));
  assert.equal(payload.reasoning.effort, 'max');
  assert.equal(payload.reasoning.summary, 'auto');
  assert.equal(rewritten.meta.forcedReasoningApplied, true);
  assert.deepEqual(rewritten.meta.forcedReasoning, {
    applied: true,
    reason: 'forced',
    from: 'low',
    to: 'max',
  });
});

test('persistence prompt yields to host-verified deterministic final drafts', () => {
  const source = fs.readFileSync(new URL('../src/bridge/codex-responses-proxy.mjs', import.meta.url), 'utf8');
  assert.match(source, /both <deterministic-current-evidence> and <deterministic-final-draft/u);
  assert.match(source, /Do not call any tool, do not emit an acceptance checklist/u);
});

test('persistence prompt teaches completed-state collapse and evidence-to-file protocol', () => {
  // 与 lop-chain collapsedAcceptanceChecklist 的协议闭环:任一端被单边删改时此钉先红。
  const source = fs.readFileSync(new URL('../src/bridge/codex-responses-proxy.mjs', import.meta.url), 'utf8');
  assert.match(source, /【验收清单】N\/N 全部完成/u);
  assert.match(source, /exact number of frozen contract items/u);
  assert.match(source, /acceptance-evidence\.md/u);
  assert.match(source, /one-line conclusions, key numbers, and the evidence file path/u);
});

test('memo replays equivalent SSE while replacing 8-16 hex history token', () => {
  const memo = new ExactResponseMemo();
  const body = Buffer.from('data: {"type":"response.output_text.done","text":"ok <!-- history-used:h_1234567890abcdef -->"}\n\n');
  assert.equal(memo.set('same', {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream', 'content-length': String(body.length) },
    body,
    usageToken: 'h_1234567890abcdef',
  }), true);
  const replay = memo.get('same', 'h_abcdef12');
  assert.equal(replay.statusCode, 200);
  assert.match(replay.body.toString('utf8'), /history-used:h_abcdef12/u);
  assert.doesNotMatch(replay.body.toString('utf8'), /h_1234567890abcdef/u);
  assert.equal(replay.headers['x-lop-exact-response-cache'], 'hit');
});
