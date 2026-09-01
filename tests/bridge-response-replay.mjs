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

test('proxy passes session reasoning through untouched (v7.15.0 revokes forced max)', () => {
  const source = fs.readFileSync(new URL('../src/bridge/codex-responses-proxy.mjs', import.meta.url), 'utf8');
  const adversary = fs.readFileSync(new URL('../src/chain/portable-adversary.mjs', import.meta.url), 'utf8');
  assert.match(source, /gpt56-chain-replay-v7\.16\.0/u);
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
  // 2026-09-01 lop 裁决:reasoning 强度完全由会话控制,桥不得全局强制。
  assert.doesNotMatch(source, /CODEX_FORCE_REASONING_EFFORT/u);
  assert.match(adversary, /reasoning: \{ effort: "max" \}/u);
  assert.match(adversary, /PI_CODING_AGENT_DIR/u);
  assert.match(adversary, /\.pi", "agent", "auth\.json"/u);
  assert.doesNotMatch(adversary, /reasoning: \{ effort: "low" \}/u);

  const rewritten = rewriteCodexRequestBody(Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'low', summary: 'auto' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'probe' }] }],
  })), { 'content-type': 'application/json' }, {});
  const payload = JSON.parse(rewritten.body.toString('utf8'));
  assert.equal(payload.reasoning.effort, 'low');
  assert.equal(payload.reasoning.summary, 'auto');
  assert.equal(rewritten.meta.reasoningApplied, false);
  assert.equal(rewritten.meta.forcedReasoningApplied, undefined);
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
  // v13 增量协议 + 最高优先级落盘规则(2026-09-01 lop 裁决)。
  assert.match(source, /Highest-priority output rule/u);
  assert.match(source, /Do not restate the full checklist in later replies/u);
  assert.match(source, /listing just the changed items/u);
});

// v7.16.0 pi 形态:pi-ai 序列化=单条 developer 字符串系统提示 + user 块数组。
function piPayload(task, turns = 1) {
  const input = [
    { role: 'developer', content: 'PI 系统提示常量前缀,含 Autonomy and Persistence 附录。' },
    { role: 'user', content: [{ type: 'input_text', text: task }] },
  ];
  for (let i = 1; i < turns; i += 1) {
    input.push({ role: 'assistant', content: [{ type: 'output_text', text: `第${i}轮回答`, annotations: [] }] });
    input.push({ role: 'user', content: [{ type: 'input_text', text: `追问${i}` }] });
  }
  return { model: 'gpt-5.6-sol', stream: true, input };
}

function rewriteKey(payload) {
  const rewritten = rewriteCodexRequestBody(
    Buffer.from(JSON.stringify(payload)), { 'content-type': 'application/json' }, {},
  );
  assert.equal(rewritten.meta.cacheApplied, true, JSON.stringify(rewritten.meta.cache));
  return { key: JSON.parse(rewritten.body.toString('utf8')).prompt_cache_key, meta: rewritten.meta };
}

test('pi string-form developer prompt gets a cache key without content mutation (v7.16.0)', () => {
  const payload = piPayload('任务A:修复缓存注入');
  const { key, meta } = rewriteKey(payload);
  assert.equal(meta.cache.itemIndex, 0);
  assert.equal(meta.cache.blockIndex, -1);
  // 字符串边界无块可挂断点:即使 explicitBreakpoint 默认开也必须恒 key-only。
  assert.equal(meta.cache.breakpointApplied, false);
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const out = JSON.parse(rewriteCodexRequestBody(
    Buffer.from(JSON.stringify(payload)), { 'content-type': 'application/json' }, {},
  ).body.toString('utf8'));
  assert.equal(out.input[0].content, payload.input[0].content);
});

test('concurrent sessions key apart while one session keys constant across turns (v7.16.0)', () => {
  const a1 = rewriteKey(piPayload('会话A的任务')).key;
  const a3 = rewriteKey(piPayload('会话A的任务', 3)).key;
  const b1 = rewriteKey(piPayload('会话B的任务')).key;
  assert.equal(a1, a3, '单会话跨轮 key 必须恒定');
  assert.notEqual(a1, b1, '并发会话 key 必须互异');
});

test('codex block-form developer prefix keeps explicit breakpoint behavior (v7.16.0)', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: '块形态稳定前缀' }] },
      { role: 'user', content: [{ type: 'input_text', text: '任务' }] },
    ],
  };
  const rewritten = rewriteCodexRequestBody(
    Buffer.from(JSON.stringify(payload)), { 'content-type': 'application/json' }, {},
  );
  assert.equal(rewritten.meta.cacheApplied, true);
  assert.equal(rewritten.meta.cache.blockIndex, 0);
  assert.equal(rewritten.meta.cache.breakpointApplied, true);
  const out = JSON.parse(rewritten.body.toString('utf8'));
  assert.deepEqual(out.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
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
