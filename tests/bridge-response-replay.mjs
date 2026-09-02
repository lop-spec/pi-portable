#!/usr/bin/env node
// 桥 v8 slim 合同:只保留 ①兼容剥离 ②账号池 ③出口/过载 ④观测 ⑤prompt_cache_key;
// persistence/memo/history 快路/tier 兜底必须不存在;协议文本改由 launcher 同步进 AGENTS.md。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { rewriteCodexRequestBody } from '../src/bridge/codex-cache-policy.mjs';
import { extractUsage } from '../src/bridge/codex-stream-metrics.mjs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('stream metrics surface the upstream-applied service tier (v7.17.0)', () => {
  const tail = 'data: {"type":"response.completed","response":{"id":"r","service_tier":"default","usage":{"input_tokens":822,"input_tokens_details":{"cached_tokens":0},"output_tokens":362,"output_tokens_details":{"reasoning_tokens":41}}}}\n';
  const usage = extractUsage(tail);
  assert.equal(usage.serviceTier, 'default');
  assert.equal(usage.outputTokens, 362);
  assert.equal(extractUsage('data: {"type":"response.completed","response":{"usage":{"output_tokens":1}}}').serviceTier, null);
});

test('v8 slim: proxy keeps compat/pool/egress/overload/metrics/cache-key and nothing else', () => {
  const source = read('../src/bridge/codex-responses-proxy.mjs');
  const policy = read('../src/bridge/codex-cache-policy.mjs');
  const adversary = read('../src/chain/portable-adversary.mjs');
  assert.match(source, /gpt56-slim-v8\.0\.0/u);
  // 保留项
  assert.match(source, /兼容剥离：max_output_tokens/u);
  assert.match(source, /sendWithAccountFailover/u);
  assert.match(source, /requestWithOverloadRetry/u);
  assert.match(source, /selected\.prefixChunks/u);
  assert.match(source, /gpt-5\.6-terra,gpt-5\.6-luna,gpt-reserve/u);
  assert.match(source, /x-lop-upstream-model/u);
  assert.match(source, /currentEgress\(\)/u);
  assert.match(source, /upstreamTier: usage\.serviceTier/u);
  assert.match(source, /tier 回显不一致：请求/u);
  assert.match(source, /cache 未注入：/u);
  // 撤掉项(源级钉死,任何回流先红)
  for (const gone of [/PERSISTENCE/u, /appendPersistence/u, /ExactResponseMemo/u, /responseMemo/u, /HISTORY_REPLAY_EFFORT/u, /CODEX_PROXY_TIER/u, /CODEX_FORCE_REASONING_EFFORT/u, /keep going until the query or task is completely resolved/u]) {
    assert.doesNotMatch(source, gone);
  }
  for (const gone of [/responseReplayIdentity/u, /applyHistoryReplayEffort/u, /EXACT_HISTORY/u, /tierApplied/u]) {
    assert.doesNotMatch(policy, gone);
  }
  assert.equal(fs.existsSync(new URL('../src/bridge/codex-response-memo.mjs', import.meta.url)), false);
  // 预审 lane 仍显式 max;桥不改写任何请求的 reasoning/service_tier。
  assert.match(adversary, /reasoning: \{ effort: "max" \}/u);
  const rewritten = rewriteCodexRequestBody(Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'low', summary: 'auto' },
    service_tier: 'priority',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'probe' }] }],
  })), { 'content-type': 'application/json' }, {});
  const payload = JSON.parse(rewritten.body.toString('utf8'));
  assert.equal(payload.reasoning.effort, 'low');
  assert.equal(payload.service_tier, 'priority');
  assert.equal(rewritten.meta.effectiveTier, 'priority');
  assert.equal(rewriteCodexRequestBody(Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: 'probe' }] }],
  })), { 'content-type': 'application/json' }, {}).meta.effectiveTier, null, '无 tier 时不得兜底注入');
});

test('protocol text lives in the AGENTS managed block asset and launcher syncs it', () => {
  const asset = read('../assets/pi-agents-protocol.md');
  const launcher = read('../src/launcher.mjs');
  assert.match(asset, /^<!-- lop-protocol:begin -->/u);
  assert.match(asset, /<!-- lop-protocol:end -->\s*$/u);
  assert.match(asset, /keep going until the query or task is completely resolved/u);
  assert.match(asset, /both <deterministic-current-evidence> and <deterministic-final-draft/u);
  assert.match(asset, /Do not call any tool, do not emit an acceptance checklist/u);
  // 与 lop-chain collapsedAcceptanceChecklist / checklist gate 的协议闭环:任一端单边删改先红。
  assert.match(asset, /【验收清单】N\/N 全部完成/u);
  assert.match(asset, /exact number of frozen contract items/u);
  assert.match(asset, /Only two item states are valid/u);
  assert.match(asset, /Never use '\[~\]'/u);
  assert.match(asset, /checked item saying the target was not met/u);
  assert.match(asset, /Do not restate the full checklist in later replies/u);
  assert.match(asset, /listing just the changed items/u);
  assert.match(asset, /Highest-priority output rule/u);
  assert.match(asset, /acceptance-evidence\.md/u);
  assert.match(asset, /one-line conclusions, key numbers, and the evidence file path/u);
  assert.match(asset, /preloaded shell helper `ev <cmd\.\.\.>`/u);
  assert.match(asset, /Never re-type command outputs/u);
  assert.match(launcher, /function syncAgentsProtocol\(\)/u);
  assert.match(launcher, /syncAgentsProtocol\(\);/u);
  assert.match(launcher, /assets", "pi-agents-protocol\.md"/u);
});

// pi 形态:pi-ai 序列化=单条 developer 字符串系统提示 + user 块数组。
function piPayload(task, turns = 1) {
  const input = [
    { role: 'developer', content: 'PI 系统提示常量前缀(含 AGENTS 协议块)。' },
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

test('non-JSON or unsupported bodies pass through untouched (fail-open)', () => {
  const raw = Buffer.from('not json');
  const rewritten = rewriteCodexRequestBody(raw, { 'content-type': 'application/json' }, {});
  assert.equal(rewritten.meta.parseFailed, true);
  assert.equal(rewritten.body, raw);
  const other = rewriteCodexRequestBody(Buffer.from(JSON.stringify({ model: 'gpt-4.1', input: [] })), { 'content-type': 'application/json' }, {});
  assert.equal(other.meta.cacheApplied, false);
  assert.equal(other.meta.cache.reason, 'unsupported-model');
});
