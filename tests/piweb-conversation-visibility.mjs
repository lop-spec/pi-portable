import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const all = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
const marker = '// Conversation visibility: native progress stays readable after a turn ends.';
const source = all.slice(all.indexOf(marker));

function fixture() {
  const errors = [], timers = [], observers = [], roots = [];
  class Element {
    constructor(kind = 'other', title = '') { this.kind = kind; this.title = title; this.attrs = {}; this.children = []; this.isConnected = true; this.clicks = 0; }
    matches(selector) { return this.kind === 'button' ? selector.includes('button[') : this.kind === 'summary' ? selector.includes('.markdown-compaction-message') : false; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    getAttribute(key) { return key === 'title' ? this.title : this.attrs[key] ?? null; }
    setAttribute(key, value) { this.attrs[key] = value; }
    append(child) { child.parentElement = this; this.children.push(child); this.firstElementChild = this.children[0]; return child; }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    click() { this.clicks++; this.attrs['aria-expanded'] = 'true'; }
  }
  const doc = new Element();
  const document = { readyState: 'complete', documentElement: doc, head: new Element(), createElement: () => new Element(), addEventListener() {} };
  const window = {};
  const context = vm.createContext({ window, document, Element, WeakSet, Set,
    console: { info() {}, warn: (...a) => errors.push(a), error: (...a) => errors.push(a) },
    setTimeout: fn => timers.push(fn), queueMicrotask: fn => timers.push(fn),
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe(root) { roots.push(root); } },
  });
  const start = () => vm.runInContext(source, context);
  const notify = node => { observers[0].cb([{ type: 'childList', addedNodes: [node], target: node.parentElement }]); while (timers.length) timers.shift()(); };
  const button = title => { const group = doc.append(new Element()); const b = group.append(new Element('button', title)); b.attrs['aria-expanded'] = 'false'; return b; };
  const compaction = () => {
    const wrapper = doc.append(new Element()), card = wrapper.append(new Element()), header = card.append(new Element());
    const badge = header.append(new Element()); badge.textContent = 'compaction';
    const body = card.append(new Element()); header.nextElementSibling = body;
    const summary = body.append(new Element('summary')); summary.textContent = '保留给模型的摘要';
    return { wrapper, card, summary };
  };
  return { start, notify, button, compaction, errors, roots, doc, document, window, Element };
}

test('presentation controller exists and never rewrites requests, sessions or model text', () => {
  assert.ok(all.includes(marker), 'conversation visibility controller missing');
  const behavior = source.replace('style.textContent = \'[data-pi-compaction-hidden="true"]{display:none!important}\';', '');
  assert.doesNotMatch(behavior, /\bfetch\s*\(|setInterval|localStorage|innerHTML|\.textContent\s*=(?!=)|\.remove\(/);
});

test('completed/history progress groups default open in all native locales, not thinking/tools', () => {
  const f = fixture();
  const groups = ['展开处理详情', '展開處理詳細資料', 'Expand process details'].map(f.button);
  const others = ['思考', 'bash', '展开文件'].map(f.button);
  f.start();
  assert.deepEqual(groups.map(b => b.getAttribute('aria-expanded')), ['true', 'true', 'true']);
  assert.deepEqual(others.map(b => b.clicks), [0, 0, 0]);
  assert.equal(f.errors.length, 0);
});

test('stream completion and paginated history are handled once; manual collapse remains usable', () => {
  const f = fixture(); f.start();
  const b = f.button('Expand process details'); f.notify(b.parentElement);
  assert.equal(b.clicks, 1);
  b.setAttribute('aria-expanded', 'false'); f.notify(b.parentElement);
  assert.equal(b.clicks, 1, 'do not fight manual collapse');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  f.start(); assert.equal(b.clicks, 1, 'controller is idempotent');
});

test('compaction cards are hidden only in presentation, preserving their exact summary and DOM', () => {
  const f = fixture(); const c = f.compaction(); f.start();
  assert.equal(c.wrapper.getAttribute('data-pi-compaction-hidden'), 'true');
  assert.equal(c.summary.textContent, '保留给模型的摘要');
  assert.equal(c.wrapper.contains(c.summary), true);
  assert.match(f.document.head.children[0].textContent, /display:\s*none\s*!important/);
  const next = f.compaction(); f.notify(next.wrapper);
  assert.equal(next.wrapper.getAttribute('data-pi-compaction-hidden'), 'true');
});

test('unexpected compaction markup is not hidden silently or allowed to hide unrelated content', () => {
  const f = fixture(); const c = f.compaction(); c.card.firstElementChild.firstElementChild.textContent = 'ordinary answer';
  f.start(); assert.equal(c.wrapper.getAttribute('data-pi-compaction-hidden'), null);
  assert.equal(f.errors.length, 1);
});

test('failed native expansion is logged without retry loops or fake progress', () => {
  const f = fixture(); f.start(); const b = f.button('展开处理详情'); b.click = () => {};
  f.notify(b.parentElement); assert.equal(f.errors.length, 1);
});

test('native upstream anchors remain compatible when official source is available', t => {
  const base = new URL('../../scratch/pi-web-upstream-main/', import.meta.url);
  if (!fs.existsSync(base)) return t.skip('official checkout is not present on this runner');
  const chat = fs.readFileSync(new URL('components/ChatWindow.tsx', base), 'utf8');
  const view = fs.readFileSync(new URL('components/MessageView.tsx', base), 'utf8');
  assert.match(chat, /title=\{expanded \? t\("chat.collapseProcess"\) : t\("chat.expandProcess"\)\}/);
  assert.match(view, /<MarkdownBody className="markdown-compaction-message">/);
  for (const locale of ['en', 'zh-CN', 'zh-TW']) {
    const dict = fs.readFileSync(new URL(`lib/i18n/messages/${locale}.ts`, base), 'utf8');
    for (const key of ['expandProcess', 'collapseProcess']) {
      const title = dict.match(new RegExp(`"chat\\.${key}": "([^"]+)"`))[1];
      assert.ok(source.includes(JSON.stringify(title)), title);
    }
  }
});
