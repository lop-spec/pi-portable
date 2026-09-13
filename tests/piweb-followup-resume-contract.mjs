import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8').split('// Shared, event-driven geometry')[0];
function harness({ label = '目标 · 达标', active = false, legacy = false, missing = false, fail = false, switched = false, stale = false, unchanged = false } = {}) {
  const calls = [], logs = [], nodes = [];
  const location = { href: 'http://localhost:30141/?session=fixture' };
  function element(text = '') {
    const attrs = new Map(), events = new Map();
    return { textContent: text, attrs, events, style: {}, isConnected: true,
      setAttribute: (k, v) => attrs.set(k, v),
      addEventListener: (k, v) => events.set(k, v),
      getBoundingClientRect: () => ({ width: 980, height: 20, left: 10, right: 990, top: 800, bottom: 820 }) };
  }
  const text = element(`自动追问 · ${label} · ${active ? '2/8' : '已暂停'}`);
  // Native .extension-status-text is flex:1; its box is NOT its text width.
  const textRects = [{ width: 200, height: 20, left: 300, right: 500, top: 800, bottom: 820 }];
  let reads = 0, reloaded = false;
  const document = { readyState: 'loading', addEventListener() {},
    createRange: () => ({ selectNodeContents(node) { assert.equal(node, text); }, getClientRects: () => textRects }),
    querySelectorAll: () => [text], createElement: () => element(), body: { appendChild: node => nodes.push(node) } };
  const scope = { window: {}, document, location, URL, AbortSignal, innerWidth: 1000, innerHeight: 900,
    console: { error: (...args) => logs.push(args), info: (...args) => logs.push(args) },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, ...body });
      if (fail) return { ok: false, status: 502, json: async () => ({ error: 'upstream unavailable' }) };
      let data;
      if (body.type === 'get_state') {
        const first = reads++ === 0;
        data = { extensionStatuses: [{ key: 'lop-followup', text: `自动追问 · ${label} · ${first && !stale || unchanged ? active ? '2/8' : '已暂停' : active ? '已暂停' : '0/8'}` }] };
      }
      if (body.type === 'get_commands') {
        data = { commands: missing || (legacy && !reloaded) ? [] : [{ name: 'lop-followup-control', source: 'extension' }] };
        if (switched) location.href = 'http://localhost:30141/?session=other';
      }
      if (body.type === 'reload') reloaded = true;
      return { ok: true, json: async () => ({ success: true, data: data ?? null }) };
    } };
  const code = source.replace('  if (document.readyState === "loading")', '  window.test = { toggle, refresh, modeOf };\n  if (document.readyState === "loading")');
  vm.runInNewContext(code, scope);
  return { ...scope.window.test, text, textRects, calls, logs, nodes, location,
    button: () => nodes.find(node => node.id === 'pi-followup-toggle'),
    notice: () => nodes.find(node => node.id === 'pi-followup-resume-notice') };
}

test('all saved goal modes support paused, armed and active statuses', () => {
  const h = harness();
  for (const [label, mode] of [['目标 · 彻底', 'thorough'], ['目标 · 达标', 'target'], ['目标 · 根因', 'root-cause'], ['目标 · 根治', 'root-fix'], ['计划', 'plan']]) {
    for (const phase of ['已暂停', '待发送', '2/8']) assert.equal(h.modeOf(`自动追问 · ${label} · ${phase}`), mode);
  }
  assert.equal(h.modeOf('other extension · 已暂停'), undefined);
});

for (const active of [false, true]) test(`${active ? 'pause' : 'resume'} click uses explicit native control; duplicate clicks send once`, async () => {
  const h = harness({ active });
  await Promise.all([h.toggle(h.text), h.toggle(h.text)]);
  assert.deepEqual(h.calls.map(c => c.type), ['get_state', 'get_commands', 'prompt', 'get_state']);
  assert.equal(h.calls[2].message, `/lop-followup-control ${active ? 'pause' : 'resume'} target`);
  assert.equal(h.calls[2].url, '/api/agent/fixture');
  assert.equal(h.logs.length, 0);
  assert.match(h.notice().textContent, active ? /目标已暂停/ : /已恢复上次目标并继续执行/);
  assert.equal(h.button().disabled, false);
});

test('small native button toggles icons beside the unchanged React status text', async () => {
  const h = harness(), original = h.text.textContent;
  h.refresh();
  const button = h.button();
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '▶');
  assert.equal(button.attrs.get('aria-label'), '恢复目标');
  assert.equal(button.style.left, '506px');
  assert.equal(h.text.textContent, original);
  assert.equal(h.text.attrs.size, 0);
  h.text.textContent = '自动追问 · 目标 · 达标 · 0/8'; h.refresh();
  assert.equal(h.button(), button);
  assert.equal(button.textContent, '⏸');
  assert.equal(button.attrs.get('aria-label'), '暂停目标');
  h.text.textContent = ''; h.refresh();
  assert.equal(button.hidden, true);
});

test('toggle follows the rendered text endpoint, including wrapped ANSI spans and viewport edges', () => {
  const h = harness();
  h.textRects.push({ width: 80, height: 20, left: 300, right: 380, top: 820, bottom: 840 });
  h.refresh();
  assert.equal(h.button().style.left, '386px');
  assert.equal(h.button().style.top, '818px');
  h.textRects.push({ width: 100, height: 20, left: 890, right: 990, top: 880, bottom: 900 });
  h.refresh();
  assert.equal(h.button().style.left, '972px');
  assert.equal(h.button().style.top, '876px');
  h.textRects.length = 0; h.refresh();
  assert.equal(h.button().hidden, true, 'unrendered text must not leave a floating button');
});

test('native click event routes through the current status without custom keyboard emulation', async () => {
  const h = harness(); h.refresh(); h.button().events.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 1);
  assert.equal(h.button().events.has('keydown'), false);
});

test('legacy live extension reloads resources once without aborting the agent', async () => {
  const h = harness({ legacy: true }); await h.toggle(h.text);
  assert.deepEqual(h.calls.map(c => c.type), ['get_state', 'get_commands', 'reload', 'get_commands', 'prompt', 'get_state']);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0][0], /old-extension-runtime/);
});

for (const condition of ['missing', 'stale', 'switched', 'fail']) test(`${condition}: no control prompt, failure logged visibly`, async () => {
  const h = harness({ [condition]: true }); await h.toggle(h.text);
  assert.equal(h.calls.some(c => c.type === 'prompt'), false);
  assert.ok(h.logs.length >= 1);
  if (condition !== 'switched') assert.equal(h.notice().attrs.get('role'), 'alert');
  assert.equal(h.button().disabled, false);
});

for (const active of [false, true]) test(`unchanged ${active ? 'active' : 'paused'} server state never reports success`, async () => {
  const h = harness({ active, unchanged: true }); await h.toggle(h.text);
  assert.equal(h.notice().attrs.get('role'), 'alert');
  assert.match(h.notice().textContent, /目标状态未切换/);
});

function layoutHarness() {
  const full = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  const begin = full.indexOf('// Shared, event-driven geometry');
  const end = full.indexOf('  const VERSION = "piweb-session-archive', begin);
  const shared = full.slice(begin, full.lastIndexOf('(() => {', end));
  const frames = [], mutations = [], resizes = [], starts = [], listeners = new Map();
  class Element {
    constructor(selectors = [], rect = {}) {
      this.selectors = selectors; this.rect = { width: 32, height: 32, left: 1950, right: 1982, top: 1344, bottom: 1376, ...rect };
      this.isConnected = true; this.style = {}; this.classList = { contains: () => false };
    }
    matches(selector) { return selector.split(',').some(item => this.selectors.includes(item)); }
    closest() { return null; }
    querySelector() { return null; }
    getBoundingClientRect() { return this.rect; }
    setAttribute() {}
  }
  const model = new Element(['.model-selector.is-toolbar']);
  const shelf = new Element(['.extension-status-shelf'], { width: 1800, height: 56 });
  shelf.isConnected = false;
  const body = new Element(), root = new Element();
  model.parentElement = body; shelf.parentElement = body; body.parentElement = root;
  const document = {
    body, documentElement: root, readyState: 'loading', visibilityState: 'visible',
    querySelectorAll: selector => [model, shelf].filter(node => node.isConnected && node.matches(selector)),
    getElementById: () => ({}),
    addEventListener: (name, callback) => name === 'DOMContentLoaded' ? starts.push(callback) : listeners.set(name, callback),
  };
  const state = { host: { style: {} }, panel: { style: {} }, open: false };
  const button = new Element(), panel = { hidden: true };
  const scope = { document, state, button, panel, Element, HTMLElement: Element, innerWidth: 2560, innerHeight: 1400,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    requestAnimationFrame: callback => (frames.push(callback), frames.length),
    ResizeObserver: class { constructor(callback) { this.callback = callback; this.nodes = new Set(); resizes.push(this); } observe(node) { this.nodes.add(node); } disconnect() { this.nodes.clear(); } },
    MutationObserver: class { constructor(callback) { mutations.push(callback); } observe() {} },
  };
  const quota = full.slice(full.indexOf('  function isVisible(element)'), full.indexOf('  function relativeReset('));
  const tierBegin = full.indexOf('  function closePanel(focus = false)');
  const tier = full.slice(tierBegin, full.indexOf('  function render()', tierBegin));
  vm.runInNewContext(shared + quota + tier + '\nwindow.__piUiLayout.subscribe(positionUi); window.__piUiLayout.subscribe(position);', scope);
  starts.forEach(start => start());
  const flush = () => { let n = 0; while (frames.length) { assert.ok(n++ < 10, 'geometry must settle, not poll'); frames.shift()(); } };
  flush();
  return { model, shelf, body, state, button, resizes, frames, flush,
    mutate: record => mutations.forEach(callback => callback([record])) };
}

test('adding/removing the native status shelf keeps quota and tier on the model row', () => {
  const h = layoutHarness();
  assert.equal(h.button.style.top, '1344px');
  assert.equal(h.state.host.style.top, '1344px');
  h.shelf.isConnected = true; h.model.rect.top = 1288;
  h.mutate({ type: 'childList', target: h.body, addedNodes: [h.shelf], removedNodes: [] }); h.flush();
  assert.equal(h.button.style.top, '1288px', 'tier must move up with composer, not stay in footer');
  assert.equal(h.state.host.style.top, '1288px', 'quota must move up with composer');
  assert.ok(h.resizes.some(observer => observer.nodes.has(h.shelf)), 'status shelf must be a resize dependency');
  h.model.rect.top = 1240;
  h.resizes.forEach(observer => observer.callback([{ target: h.shelf }])); h.flush();
  assert.equal(h.button.style.top, '1240px', 'widget expansion must reposition controls');
  h.shelf.isConnected = false; h.model.rect.top = 1344;
  h.mutate({ type: 'childList', target: h.body, addedNodes: [], removedNodes: [h.shelf] }); h.flush();
  assert.equal(h.button.style.top, '1344px');
  assert.equal(h.state.host.style.top, '1344px');
});

test('status geometry remains event-driven: unrelated transcript changes do not schedule work', () => {
  const h = layoutHarness();
  h.mutate({ type: 'childList', target: h.body, addedNodes: [], removedNodes: [] });
  assert.equal(h.frames.length, 0);
});

test('UI delegates to the saved native mode, never waits for another message or interrupts work', () => {
  assert.doesNotMatch(source, /setInterval|下一条消息|type: ["']abort|message: ["']继续/);
  assert.match(source, /AbortSignal.timeout\(15000\)/);
  assert.match(source, /width:24px;height:24px/);
});
