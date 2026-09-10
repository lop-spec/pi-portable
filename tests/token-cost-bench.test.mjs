import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packText, unpackText, comparePair, quality, normalizedCost, validUsage, discoverCases } from '../tools/token-cost-bench.mjs';
const CASES = [
  { id: 'single', prefix: '2099-01-01T00-00-01', checks: { fact: /expected-fact/ } },
  { id: 'continuation', prefix: '2099-01-01T00-00-02', userIndex: 1, checks: { fact: /expected-fact/ } },
];

test('literal dictionary round trips unicode, huge integers, duplicate keys, escapes and marker collisions', () => {
  for (const prefix of ['', '⟦D0⟧', '⟦DD2⟧']) {
    const text = prefix + Array.from({ length: 70 }, (_, i) => `{"very_long_repeated_field_name":"instance-repeated-abcdefghijklmnop","n":900719925474099312345,"n":-0,"text":"中文\\n\\\"","i":${i}}`).join('\r\n');
    const packed = packText(text);
    assert.equal(packed.encoded, true);
    assert.equal(unpackText(packed), text);
    assert.ok(packed.text.length < text.length);
  }
});
test('no-op must explain why and preserve all text', () => {
  const text = '无任何重复内容 {} null 0 error forbidden';
  const packed = packText(text);
  assert.equal(packed.encoded, false);
  assert.ok(packed.reason);
  assert.equal(unpackText(packed), text);
});
const valid = extra => ({ completed: true, usageComplete: true, qualityReviewed: true, quality: { correct: true },
  fixtureHash: 'same', model: 'same', thinking: 'xhigh', priceHash: 'price', requests: 2,
  tokens: 1000, estimatedUSD: 1, ...extra });
test('both targets inclusive and no average percentage trick', () => {
  assert.equal(comparePair(valid(), valid({ tokens: 700, estimatedUSD: .7 })).passed, true);
  assert.equal(comparePair(valid(), valid({ tokens: 701, estimatedUSD: .1 })).passed, false);
  assert.equal(comparePair(valid(), valid({ tokens: 100, estimatedUSD: .701 })).passed, false);
});
test('incomplete, unreviewed, unknown usage and quality regressions never pass', () => {
  for (const bad of [{ completed: false }, { usageComplete: false }, { qualityReviewed: false }, { quality: {} }, { quality: { a: false } },
    { fixtureHash: 'changed' }, { model: 'other' }, { thinking: 'low' }, { priceHash: 'other' }]) {
    assert.equal(comparePair(valid(), valid({ tokens: 100, estimatedUSD: .1, ...bad })).passed, false);
  }
  assert.equal(comparePair(undefined, undefined).passed, false);
});
test('quality checks do not count presence of an answer as task completion', () => {
  for (const c of CASES) assert.ok(Object.values(quality('已完成，可以继续。', c.checks)).every(v => !v));
});
test('zero/invalid/missing accounting cannot masquerade as 100% savings', () => {
  for (const bad of [{ tokens: 0 }, { tokens: NaN }, { tokens: -1 }, { estimatedUSD: 0 }, { estimatedUSD: Infinity },
    { requests: 0 }, { requests: undefined }, { quality: { correct: 'true' } }]) {
    assert.equal(comparePair(valid(), valid({ tokens: 100, estimatedUSD: .1, ...bad })).passed, false);
  }
});
test('provider total reconciles including cached input; reasoning is not double-counted', () => {
  const u = { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, reasoning: 20, totalTokens: 1050 };
  assert.equal(validUsage(u), true);
  for (const bad of [{ cacheRead: undefined }, { totalTokens: 1070 }, { input: -1 }, { output: NaN }]) assert.equal(validUsage({ ...u, ...bad }), false);
});
test('same frozen price, long-context tier, cold inputs, cache and output all included', () => {
  const prices = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }] };
  const u = { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 100 };
  assert.equal(normalizedCost(u, prices), .017);
  assert.equal(normalizedCost({ ...u, cacheRead: 300000 }, prices), .6275);
});
test('later user followups cannot mutate the original fixed episode; continuation retains prior messages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-token-episode-'));
  const sessions = path.join(root, 'sessions', 'fixture'); fs.mkdirSync(sessions, { recursive: true });
  const wrap = message => JSON.stringify({ type: 'message', message }) + '\n';
  for (const c of CASES) {
    let data = '';
    for (let i = 0; i < (c.userIndex === undefined ? 1 : c.userIndex + 2); i++) {
      data += wrap({ role: 'user', content: [{ type: 'text', text: 'question-' + i }] });
      data += wrap({ role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'evidence-' + i }] });
      data += wrap({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'answer-' + i }] });
    }
    fs.writeFileSync(path.join(sessions, c.prefix + '-fixture.jsonl'), data);
  }
  const before = discoverCases(root, CASES);
  for (const c of CASES) fs.appendFileSync(path.join(sessions, c.prefix + '-fixture.jsonl'), wrap({ role: 'user', content: 'later unrelated followup' }));
  const after = discoverCases(root, CASES);
  assert.deepEqual(after.map(c => c.fixtureHash), before.map(c => c.fixtureHash));
  const continuation = before.find(c => c.userIndex !== undefined);
  assert.equal(continuation.history.length, continuation.userIndex * 3);
  assert.equal(continuation.evidence.length, 1);
});
