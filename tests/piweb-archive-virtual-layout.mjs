import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
const actions = source.slice(source.indexOf('  function sessionRow('), source.indexOf('  function immediateActionClick('));
function fixture({ selected = false, fail = false, reducedMotion = false } = {}) {
  const timers = [], microtasks = [], errors = [];
  const parent = {};
  const rows = Array.from({ length: 4 }, (_, i) => {
    const wrapper = { style: { position: 'absolute', top: `${i * 54}px` }, parentElement: parent, isConnected: true, animations: [] };
    wrapper.animate = (frames, options) => {
      const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
      wrapper.animations.push(animation); return animation;
    };
    const row = { dataset: { piSessionId: `s${i}` }, style: { height: '54px', display: 'flex', background: selected && i === 0 ? 'var(--bg-selected)' : '', borderLeftColor: '', opacity: '', transform: '', pointerEvents: '', transition: '' }, isConnected: true, parentElement: wrapper, clicks: 0,
      setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ height: 54 }), animate: wrapper.animate, click() { this.clicks++; } };
    row.button = { parentElement: row, dataset: {}, isConnected: true };
    return row;
  });
  let refreshes = 0;
  const state = { optimisticActions: new Set(), optimisticLayouts: new Map(), pendingActions: [], view: 'active', archivedCount: 0 };
  const context = vm.createContext({ state, document: { body: {}, documentElement: { dataset: {} }, querySelectorAll: () => rows.filter(r => r.isConnected) },
    getComputedStyle: () => ({ opacity: '1', transform: 'none' }), matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: t => { if (t) t.cancelled = true; },
    queueMicrotask: fn => microtasks.push(fn), requestAnimationFrame() {}, performance, location: { href: 'http://localhost/?session=s0' }, URL,
    history: { state: {}, replaceState() {} }, nativeFetch: async () => ({ ok: !fail, status: fail ? 409 : 200, json: async () => ({ error: 'running session' }) }),
    words: () => ({ requestFailed: 'failed' }), console: { error: (...a) => errors.push(a) }, showError() {}, scheduleDecorate() {}, requestNativeRefresh: () => refreshes++ });
  vm.runInContext(actions, context);
  return { context, rows, state, timers, errors, flush: () => { while (microtasks.length) microtasks.shift()(); }, refreshes: () => refreshes };
}
const offset = row => row.parentElement.animations.filter(a => !a.cancelled).at(-1)?.frames.at(-1)?.transform || 'none';

test('absolute virtual rows close the gap immediately, completing within 180ms', () => {
  const f = fixture();
  f.context.beginOptimisticAction(f.rows[1].button);
  assert.equal(offset(f.rows[2]), 'translateY(-54px)');
  assert.equal(offset(f.rows[3]), 'translateY(-54px)');
  assert.ok(f.rows[2].parentElement.animations.at(-1).options.duration <= 180);
  assert.equal(f.rows[2].parentElement.style.top, '108px', 'React-owned virtual coordinates stay untouched');
});

test('rapid archives accumulate offsets and rollback restores only its own gap', () => {
  const f = fixture();
  const first = f.context.beginOptimisticAction(f.rows[0].button);
  f.context.beginOptimisticAction(f.rows[1].button);
  assert.equal(offset(f.rows[3]), 'translateY(-108px)');
  f.context.restoreOptimisticAction(first);
  assert.equal(offset(f.rows[3]), 'translateY(-54px)');
  assert.equal(f.context.adjacentSessionRow(f.rows[0]), f.rows[2], 'handoff skips pending archives');
});

test('native reconciliation releases offsets without double shifting the list', () => {
  const f = fixture();
  f.context.beginOptimisticAction(f.rows[0].button);
  f.rows[0].isConnected = false;
  f.rows[0].parentElement.isConnected = false;
  for (const row of f.rows.slice(1)) row.parentElement.style.top = `${Number.parseFloat(row.parentElement.style.top) - 54}px`;
  f.context.syncOptimisticLayout();
  assert.equal(offset(f.rows[1]), 'none');
  assert.equal(f.state.optimisticLayouts.size, 0);
});

test('selected conversation handoff and successful refresh have no fixed wait', async () => {
  const f = fixture({ selected: true });
  const pending = f.context.beginOptimisticAction(f.rows[0].button);
  pending.pointerStartedAt = performance.now();
  f.context.handOffSelectedConversation(pending);
  f.flush();
  assert.equal(f.rows[1].clicks, 1, 'native selection starts in the same event turn, not after 190ms');
  await f.context.performDirectAction(pending, 's0');
  f.flush();
  assert.equal(f.refreshes(), 1, 'no 1400ms handoff refresh delay');
});

test('reduced motion skips wrapper animation and nonselected refresh has no fixed wait', async () => {
  const f = fixture({ reducedMotion: true });
  const pending = f.context.beginOptimisticAction(f.rows[0].button);
  assert.equal(f.rows[1].parentElement.animations.at(-1).options.duration, 0);
  await f.context.performDirectAction(pending, 's0');
  f.flush();
  assert.equal(f.refreshes(), 1);
});

test('ordinary flow rows retain their existing collapse animation', () => {
  const f = fixture();
  for (const row of f.rows) row.parentElement.style.position = '';
  const pending = f.context.beginOptimisticAction(f.rows[0].button);
  assert.equal(pending.animation.frames.at(-1).height, '0px');
  assert.equal(f.state.optimisticLayouts.size, 0);
});

test('server rejection restores the row and virtual offsets with a visible error', async () => {
  const f = fixture({ fail: true });
  const pending = f.context.beginOptimisticAction(f.rows[0].button);
  await f.context.performDirectAction(pending, 's0');
  assert.equal(f.rows[0].style.display, 'flex');
  assert.equal(f.rows[0].dataset.piSessionArchivePending, undefined);
  assert.equal(offset(f.rows[1]), 'none');
  assert.equal(f.state.optimisticActions.size, 0);
  assert.equal(f.errors.length, 1);
});
