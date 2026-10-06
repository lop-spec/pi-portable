import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// The archived-view list head: the count is the SELECTED project's archived conversations (published by the redesigned
// sidebar in html[data-pi-session-archive-project-count]), not the proxy's all-projects number (QA F13: "858 个对话"
// above 「没有已归档的会话」).
const source = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  function archivedHeaderCount()');
const end = source.indexOf('  // No per-row archive shortcut');
assert.ok(start > 0 && end > start, 'archivedHeaderCount + renderControl are present');
const header = source.slice(start, end);

function fixture({ view = 'archived', archivedCount = 858, projectCount, inSlot = true } = {}) {
  const dataset = {};
  if (projectCount !== undefined) dataset.piSessionArchiveProjectCount = String(projectCount);
  const attrs = {};
  const meta = { textContent: '', hidden: true };
  const control = { title: '', innerHTML: '', getAttribute: (name) => attrs[name] ?? null, setAttribute: (name, value) => { attrs[name] = value; } };
  const host = { closest: (selector) => (inSlot && selector === '[data-pi-archive-slot]' ? {} : null) };
  const context = vm.createContext({
    state: { view, archivedCount }, document: { documentElement: { dataset } },
    host, control, meta,
    words: () => ({ showActive: 'back', showArchived: (n) => `show ${n}`, back: '返回', archivedView: '归档', archivedConversations: (n) => `${n} 个对话` }),
    icon: () => '',
  });
  vm.runInContext(header, context);
  return { meta, run: () => vm.runInContext('renderControl()', context) };
}

test('archived view shows the selected project count, not the global one', () => {
  const f = fixture({ projectCount: 0 });
  f.run();
  assert.equal(f.meta.textContent, '0 个对话');
  assert.equal(f.meta.hidden, false);
  const three = fixture({ projectCount: 3 });
  three.run();
  assert.equal(three.meta.textContent, '3 个对话');
});

test('while the sidebar has not published a count (new list still loading) the head shows no number rather than a wrong one', () => {
  const f = fixture({ inSlot: true });
  f.run();
  assert.equal(f.meta.textContent, '');
  assert.equal(f.meta.hidden, true);
});

test('a sidebar without the archive slot never publishes a count, so the global number is kept', () => {
  const f = fixture({ inSlot: false });
  f.run();
  assert.equal(f.meta.textContent, '858 个对话');
  assert.equal(f.meta.hidden, false);
});

test('the active view shows no count text; its button badge stays the global archive count', () => {
  const f = fixture({ view: 'active', projectCount: 5 });
  f.run();
  assert.equal(f.meta.textContent, '');
  assert.equal(f.meta.hidden, true);
});

test('a malformed published count is treated as unknown', () => {
  const f = fixture({ projectCount: 'abc' });
  f.run();
  assert.equal(f.meta.hidden, true);
  const negative = fixture({ projectCount: -1 });
  negative.run();
  assert.equal(negative.meta.hidden, true);
});

test('the script publishes the global total for the sidebar and re-renders when the project count changes', () => {
  const decorate = source.slice(source.indexOf('  function decorate()'), source.indexOf('  function scheduleDecorate()'));
  assert.match(decorate, /document\.documentElement\.dataset\.piSessionArchiveTotal !== total\) document\.documentElement\.dataset\.piSessionArchiveTotal = total;/);
  // An event from the sidebar, not an observer on documentElement (piweb-conversation-visibility keeps those out).
  assert.match(source, /document\.addEventListener\("pi-web:archive-project-count", scheduleDecorate\);/);
  assert.doesNotMatch(source, /\.observe\(\s*document\.documentElement/);
});
