import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
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

test('quota and tier live in the composer slot, preserve native default and reject unapplied choices', () => {
  const ui = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  // Both controls are appended into React's [data-pi-composer-slot] (before the model selector);
  // only pi-web builds without the slot fall back to a fixed host anchored on the model selector.
  assert.match(ui, /register\(\{ name: "quota", slot: "composer", order: 1/);
  assert.match(ui, /register\(\{ name: "tier", slot: "composer", order: 2/);
  assert.match(ui, /composer: \{ selector: "\[data-pi-composer-slot\]"/);
  const fallback = ui.slice(ui.indexOf('  function composerAnchor()'), ui.indexOf('  function insertOrdered('));
  assert.match(fallback, /\.model-selector\.is-toolbar/);
  assert.match(ui, /explicitSelection && SUBMISSIONS\.has\(type\)/);
  assert.match(ui, /type: "set_service_tier"/);
  assert.match(ui, /code: "prompt_rejected", accepted: false/);
  assert.match(ui, /pi-service-tier-button/);
  assert.match(ui, /aria-checked/);
  const launcher = fs.readFileSync(new URL('../src/launcher.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /patch-piweb-service-tier\.mjs/);
});

// P25: the TIER guard must not add serial round trips in front of every submission.
function tierHarness({ saved = 'native', applied = {}, model = { provider: 'openai-codex', id: 'gpt-6-sol' }, rtt = 15 } = {}) {
  const all = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  const source = all.slice(all.indexOf('// Speed / service TIER'));
  const calls = [];
  const storage = new Map([['pi-service-tier-applied', JSON.stringify(applied)]]);
  if (saved !== null) storage.set('pi-service-tier', saved);
  const origin = 'http://127.0.0.1:30141';
  const native = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const call = { path: new URL(String(input), origin).pathname, type: body?.type, tier: body?.serviceTier, start: performance.now(), end: 0 };
    calls.push(call);
    await new Promise(resolve => setTimeout(resolve, rtt));
    call.end = performance.now();
    if (body?.type === 'get_state') return Response.json({ data: { model } });
    if (body?.type === 'ensure_session') return Response.json({ sessionId: 'fresh-1' });
    return Response.json({ success: true });
  };
  const window = { fetch: native };
  vm.runInNewContext(source, {
    window, Response, Request, URL, AbortSignal, performance, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    location: { href: origin + '/?session=s1', origin },
    document: { readyState: 'loading', addEventListener() {} },
    console: { error() {}, info() {}, warn() {} },
  });
  const send = (path, command) => window.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  // Longest chain of strictly sequential requests (overlapping requests count once).
  const serial = () => {
    let depth = 0, until = -1;
    for (const call of [...calls].sort((a, b) => a.start - b.start)) {
      if (call.start >= until) { depth += 1; until = call.end; } else until = Math.max(until, call.end);
    }
    return depth;
  };
  return { send, calls, serial, storage };
}

test('默认 adds no request in front of a prompt once this browser knows the runtime is native', async () => {
  const known = tierHarness({ applied: { s1: 'native' } });
  assert.equal((await known.send('/api/agent/s1', { type: 'prompt', message: 'hi' })).status, 200);
  assert.deepEqual(known.calls.map(call => call.type), ['prompt']);
  const unknown = tierHarness();
  await unknown.send('/api/agent/s1', { type: 'prompt', message: 'hi' });
  assert.deepEqual(unknown.calls.map(call => call.type), ['set_service_tier', 'prompt'], 'an unknown runtime may still carry Fast: clear it once');
  assert.equal(unknown.calls[0].tier, null);
  await unknown.send('/api/agent/s1', { type: 'steer', message: 'more' });
  assert.deepEqual(unknown.calls.map(call => call.type), ['set_service_tier', 'prompt', 'steer']);
});

test('Fast checks the model and applies the tier in parallel, then sends', async () => {
  const h = tierHarness({ saved: 'priority', applied: { s1: 'priority' } });
  await h.send('/api/agent/s1', { type: 'prompt', message: 'hi' });
  assert.deepEqual(h.calls.map(call => call.type).sort(), ['get_state', 'prompt', 'set_service_tier']);
  assert.equal(h.calls.find(call => call.type === 'set_service_tier').tier, 'priority', 'Fast is re-applied every time: a recreated runtime silently starts native');
  assert.equal(h.serial(), 2, 'one parallel round trip, then the prompt');
  assert.equal(JSON.parse(h.storage.get('pi-service-tier-applied')).s1, 'priority');
});

test('Fast on an unsupported model is rejected before the prompt is sent', async () => {
  const h = tierHarness({ saved: 'priority', model: { provider: 'anthropic', id: 'claude' } });
  const response = await h.send('/api/agent/s1', { type: 'prompt', message: 'hi' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'prompt_rejected');
  assert.equal(h.calls.some(call => call.type === 'prompt'), false);
  assert.equal(JSON.parse(h.storage.get('pi-service-tier-applied')).s1, 'priority', 'the attempt may have left Fast on the runtime; 默认 must clear it later');
});

test('a new session is created once and its first prompt follows directly when 默认 is selected', async () => {
  const h = tierHarness();
  const response = await h.send('/api/agent/new', { type: 'prompt', message: 'hi', cwd: 'C:/work' });
  assert.equal((await response.json()).sessionId, 'fresh-1');
  assert.deepEqual(h.calls.map(call => call.type + ' ' + call.path), ['ensure_session /api/agent/new', 'prompt /api/agent/fresh-1']);
});

test('every GPT-6 model in the picker can switch to Fast', () => {
  const ui = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  const catalog = fs.readFileSync(new URL('../src/live-model-catalog.mjs', import.meta.url), 'utf8');
  const supported = new Set([...ui.match(/const supportedCodexModels = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
  const picker = [...catalog.match(/export const GPT6_CODEX_IDS = Object\.freeze\(\[([^\]]*)\]\)/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.ok(picker.length >= 4 && picker.includes('gpt-6.1-sol'), 'picker ids must be readable');
  for (const id of picker) assert.ok(supported.has(id), `${id} is in the model picker but the Fast switch is disabled for it`);
});
