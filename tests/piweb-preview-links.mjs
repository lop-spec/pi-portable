import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const text = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
const start = text.indexOf('// File-preview links must not replace');
assert.ok(start >= 0, 'preview link handler missing');
const script = text.slice(start).replace(/\}\)\(\);\s*$/, 'globalThis.previewLinks = {resolveLink, fileUrl, encodeFilePath, openLink, handleClick, originalHtmlHref};\n})();');

function fixture(path = 'D:/工作 区/docs/说明 #1.md', sessionId = 'session-123', imageBytes = 256) {
  const calls = { open: [], post: [], events: {}, messages: [] };
  const source = {};
  class HTMLIFrameElement {}
  const frame = Object.assign(new HTMLIFrameElement(), { contentWindow: source, getAttribute: () => '<a href="./child.md">child</a>' });
  const download = { href: `http://127.0.0.1:30141/api/files/a?type=download&sessionId=${sessionId}` };
  const dialog = {
    errors: [],
    querySelector(selector) {
      if (selector.includes('small[title]')) return { getAttribute: () => path };
      if (selector.includes('a[download]')) return download;
      return null;
    },
    querySelectorAll() { return [frame]; },
    appendChild(element) { this.errors.push(element); },
  };
  class Element {
    constructor(href) { this.href = href; }
    closest(selector) { return selector.startsWith('dialog') ? dialog : this; }
    getAttribute() { return this.href; }
  }
  const document = {
    addEventListener(name, listener, capture) { calls.events[name] = { listener, capture }; },
    querySelector() { return dialog; },
    createElement(name) {
      if (name === 'template') return { content: { querySelector: () => null, querySelectorAll: () => [{ getAttribute: () => './child.md' }] }, set innerHTML(_) {} };
      return { dataset: {}, style: {}, setAttribute() {}, remove() {}, textContent: '' };
    },
  };
  const navigator = { userActivation: { isActive: false } };
  const window = {
    open(...args) { calls.open.push(args); },
    addEventListener(name, listener, capture) { calls.messages.push({ name, listener, capture }); },
  };
  const context = vm.createContext({ window, document, navigator, Element, HTMLIFrameElement, URL, URLSearchParams, AbortSignal, location: new URL('http://127.0.0.1:30141/?session=s'), setTimeout() {}, fetch: async (url, options) => {
    if (url.startsWith('/api/files/')) return { ok: true, json: async () => ({ size: imageBytes }) };
    calls.post.push({ url, ...JSON.parse(options.body) });
    return { ok: true };
  } });
  vm.runInContext(script, context);
  return { api: context.previewLinks, calls, dialog, frame, source, navigator, Element };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('resolve paths and preserve file and URL semantics', () => {
  const { api } = fixture();
  const base = 'D:/工作 区/docs/说明 #1.md';
  assert.deepEqual(plain(api.resolveLink('../资料/%E6%96%87%E4%BB%B6.md', base)), { kind: 'file', path: 'D:/工作 区/资料/文件.md', hash: '' });
  assert.deepEqual(plain(api.resolveLink('file:///C:/Users/me/a%20b.pdf#page=2', base)), { kind: 'file', path: 'C:/Users/me/a b.pdf', hash: '#page=2' });
  assert.deepEqual(plain(api.resolveLink('file://server/share/a.png', base)), { kind: 'file', path: '//server/share/a.png', hash: '' });
  assert.equal(api.resolveLink('file:///tmp/a.txt', '/tmp/parent.md').path, '/tmp/a.txt');
  assert.equal(api.resolveLink('#part', base).kind, 'anchor');
  assert.equal(api.resolveLink('https://example.com/x', base).kind, 'web');
  assert.equal(api.resolveLink('javascript:alert(1)', base).kind, 'blocked');
  assert.equal(api.encodeFilePath('//server/share/a b.png'), '%2F%2Fserver/share/a%20b.png');
});

test('browser files open separately; other files use existing authorized API', async () => {
  const { api, calls, dialog } = fixture();
  await api.openLink(dialog, '../图.pdf#page=3');
  const opened = new URL(calls.open[0][0]);
  assert.equal(opened.pathname, '/api/files/D%3A/%E5%B7%A5%E4%BD%9C%20%E5%8C%BA/%E5%9B%BE.pdf');
  assert.equal(opened.searchParams.get('sessionId'), 'session-123');
  assert.equal(opened.searchParams.get('type'), 'read');
  assert.equal(opened.hash, '#page=3');
  assert.deepEqual(calls.open[0].slice(1), ['_blank', 'noopener,noreferrer']);
  await api.openLink(dialog, './child.md');
  assert.deepEqual(calls.post[0], { url: '/api/open-local-file', path: 'D:/工作 区/docs/child.md', action: 'file', sessionId: 'session-123' });
  await api.openLink(dialog, './run.exe');
  assert.equal(calls.post.length, 1);
  assert.match(dialog.errors.at(-1).textContent, /不自动运行可执行文件/);
});

test('images beyond the existing preview limit use the system viewer', async () => {
  const small = fixture();
  await small.api.openLink(small.dialog, './picture.png');
  assert.equal(small.calls.open.length, 1);
  assert.equal(small.calls.post.length, 0);
  const large = fixture('D:/工作 区/docs/说明.md', 's', 11 * 1024 * 1024);
  await large.api.openLink(large.dialog, './picture.png');
  assert.equal(large.calls.open.length, 0);
  assert.equal(large.calls.post[0].path, 'D:/工作 区/docs/picture.png');
});

test('capture is scoped to the file preview and suppresses original navigation', () => {
  const { api, calls, Element } = fixture();
  let prevented = false, stopped = false;
  api.handleClick({ target: new Element('./child.md'), button: 0, defaultPrevented: false, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented && stopped, true);
  assert.equal(calls.post.length, 1);
  assert.equal(calls.events.click.capture, true);
  assert.equal(calls.events.auxclick.capture, true);
});

test('DOCX iframe links use the same external routing', () => {
  const { calls, frame, dialog } = fixture();
  const listeners = {};
  frame.src = 'http://127.0.0.1:30141/api/files/test.docx?type=preview';
  frame.closest = () => dialog;
  frame.contentDocument = { addEventListener(name, listener) { listeners[name] = listener; } };
  calls.events.load.listener({ target: frame });
  assert.equal(calls.events.load.capture, true);
  let prevented = false;
  listeners.click({ button: 0, defaultPrevented: false, target: { closest: () => ({ getAttribute: () => './child.md' }) }, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.equal(prevented, true);
  assert.equal(calls.post[0].path, 'D:/工作 区/docs/child.md');
  assert.ok(listeners.auxclick);
});

test('sandbox messages require the preview frame and a user activation', () => {
  const { calls, source, navigator } = fixture();
  const listener = calls.messages.find(x => x.name === 'message');
  assert.equal(listener.capture, true);
  let stopped = false;
  const event = { data: { __piPreview: 'link', url: 'http://127.0.0.1:30141/child.md' }, source, stopImmediatePropagation() { stopped = true; } };
  listener.listener(event);
  assert.equal(stopped, true);
  assert.equal(calls.post.length, 0);
  navigator.userActivation.isActive = true;
  listener.listener({ ...event, source: {} });
  assert.equal(calls.post.length, 0);
  listener.listener(event);
  assert.equal(calls.post[0].path, 'D:/工作 区/docs/child.md');
});
