import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { applyServiceTierRpc, TIER_MARK } from '../tools/patch-piweb-service-tier.mjs';

const fixture = 'async function send(a){switch(a.type){case"set_thinking_level":{let b=a.level;return this.inner.setThinkingLevel(b)}default:throw Error("Unknown command")}}';
function runtime() {
  const calls = [], logs = [];
  const base = function(model, context, options) { calls.push({ model, context, options }); return 'native-stream'; };
  const agent = { streamFunction: base };
  const patched = applyServiceTierRpc(fixture);
  const send = vm.runInNewContext(`(${patched.out})`, { console: { info: (...a) => logs.push(a), warn: (...a) => logs.push(a) } });
  return { agent, calls, logs, send: command => send.call({ inner: { agent } }, command) };
}

test('native service tier uses provider options without extra model calls', async () => {
  const r = runtime();
  const context = { messages: [{ role: 'user', content: 'unchanged' }] };
  for (const tier of ['default', 'priority', 'flex']) {
    await r.send({ type: 'set_service_tier', serviceTier: tier });
    const before = r.calls.length;
    assert.equal(r.agent.streamFunction({ api: 'openai-codex-responses' }, context, { sessionId: 'same-session', reasoningEffort: 'low' }), 'native-stream');
    assert.equal(r.calls.length, before + 1);
    const last = r.calls.at(-1);
    assert.equal(last.context, context);
    const payload = { model: 'test', input: context.messages, prompt_cache_key: 'same-session' };
    const body = await last.options.onPayload(payload);
    assert.equal(body.service_tier, tier);
    assert.equal(body.input, payload.input);
    assert.equal(body.prompt_cache_key, payload.prompt_cache_key);
    assert.equal(payload.service_tier, undefined);
    assert.equal(last.options.sessionId, 'same-session');
    assert.equal(last.options.reasoningEffort, 'low');
  }
});

test('preserves original onPayload and snapshots the selected tier per request', async () => {
  const r = runtime();
  await r.send({ type: 'set_service_tier', serviceTier: 'priority' });
  r.agent.streamFunction({ api: 'openai-codex-responses' }, {}, { onPayload: async body => ({ ...body, originalHook: true }) });
  await r.send({ type: 'set_service_tier', serviceTier: 'flex' });
  const body = await r.calls[0].options.onPayload({ input: [] });
  assert.equal(body.service_tier, 'priority');
  assert.equal(body.originalHook, true);
});

test('native reset preserves original options and never stacks wrappers', async () => {
  const r = runtime();
  await r.send({ type: 'set_service_tier', serviceTier: 'priority' });
  const wrapper = r.agent.streamFunction;
  await r.send({ type: 'set_service_tier', serviceTier: null });
  assert.equal(r.agent.streamFunction, wrapper);
  const options = { sessionId: 'native' };
  r.agent.streamFunction({ api: 'openai-codex-responses' }, {}, options);
  assert.equal(r.calls[0].options, options);
});

test('unknown tiers reject rather than silently mapping ultrafast to Fast', async () => {
  const r = runtime();
  await assert.rejects(r.send({ type: 'set_service_tier', serviceTier: 'ultrafast' }), /Unsupported service tier/);
  assert.equal(r.calls.length, 0);
});

test('unsupported providers are untouched and always emit a reason', async () => {
  const r = runtime();
  await r.send({ type: 'set_service_tier', serviceTier: 'priority' });
  const options = {};
  r.agent.streamFunction({ api: 'anthropic-messages' }, {}, options);
  assert.equal(r.calls[0].options, options);
  assert.ok(r.logs.some(row => String(row).includes('not applied: unsupported api')));
});

test('RPC patch is idempotent and refuses unknown bundle layouts', () => {
  const patched = applyServiceTierRpc(fixture);
  assert.ok(patched.out.includes(TIER_MARK));
  assert.deepEqual(applyServiceTierRpc(patched.out), { out: patched.out, applied: false });
  assert.throws(() => applyServiceTierRpc('unknown'), /anchor count/);
});

test('quota and tier use the model anchor, preserve native default and reject unapplied choices', () => {
  const ui = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  const anchor = ui.slice(ui.indexOf('  function findAnchor()'), ui.indexOf('  function positionUi()'));
  assert.ok(anchor.indexOf('.model-selector.is-toolbar') < anchor.indexOf('soundNames'));
  assert.match(ui, /explicitSelection && command/);
  assert.match(ui, /type: "set_service_tier"/);
  assert.match(ui, /code: "prompt_rejected", accepted: false/);
  assert.match(ui, /pi-service-tier-button/);
  assert.match(ui, /aria-checked/);
  const launcher = fs.readFileSync(new URL('../src/launcher.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /patch-piweb-service-tier\.mjs/);
});
