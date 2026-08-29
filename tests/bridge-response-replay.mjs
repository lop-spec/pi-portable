#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { responseReplayIdentity } from '../src/bridge/codex-cache-policy.mjs';
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

test('persistence prompt yields to host-verified deterministic final drafts', () => {
  const source = fs.readFileSync(new URL('../src/bridge/codex-responses-proxy.mjs', import.meta.url), 'utf8');
  assert.match(source, /gpt56-chain-replay-v7\.9\.2/u);
  assert.match(source, /both <deterministic-current-evidence> and <deterministic-final-draft/u);
  assert.match(source, /Do not call any tool, do not emit an acceptance checklist/u);
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
