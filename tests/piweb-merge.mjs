import test from 'node:test';
import assert from 'node:assert/strict';
import { portableCjkEmphasis, splitCjkStrong } from '../assets/piweb-overlay/merge/lib/portable-cjk-emphasis.mjs';
import { BOARD_COLUMNS, COLUMN_STATUS, boardColumnOf, buildBoard, canDropInto, resumeCandidates } from '../assets/piweb-overlay/merge/lib/portable-session-board.mjs';
import { formatElapsed, timelineBreakdown, toolGroup } from '../assets/piweb-overlay/merge/lib/portable-timeline-summary.mjs';

// ---------------------------------------------------------------------------------------------
// 中文加粗：CommonMark 不认「**说明：**后文」，插件只补救同一文本节点里成对的 **…**。
// ---------------------------------------------------------------------------------------------
const text = value => ({ type: 'text', value });
const paragraph = (...children) => ({ type: 'paragraph', children });
const root = (...children) => ({ type: 'root', children });
const run = (tree, source) => { portableCjkEmphasis()(tree, { value: source }); return tree; };

test('splits a bold pair that touches Chinese punctuation, keeping the surrounding text', () => {
  assert.deepEqual(splitCjkStrong('**验证结果：**7 项测试通过，'), [
    { type: 'strong', children: [text('验证结果：')] },
    text('7 项测试通过，'),
  ]);
  assert.deepEqual(splitCjkStrong('前文**重点。**后文'), [text('前文'), { type: 'strong', children: [text('重点。')] }, text('后文')]);
  assert.deepEqual(splitCjkStrong('**甲**与**乙**'), [{ type: 'strong', children: [text('甲')] }, text('与'), { type: 'strong', children: [text('乙')] }]);
});

test('leaves lone stars, spaced stars and nested emphasis alone', () => {
  for (const value of ['没有星号', '只有 ** 一个', '2 ** 3 ** 4', '** 开头空格**', '**结尾空格 **', '****', '**含*星**']) {
    assert.equal(splitCjkStrong(value), null, value);
  }
});

test('rewrites text nodes in nested containers but never touches code, html or math', () => {
  const tree = root(
    paragraph(text('**标题：**说明'), { type: 'inlineCode', value: '**不动**' }),
    { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [text('**列：**值')] }] }] },
    { type: 'code', value: '**代码里的星号**' },
    { type: 'html', value: '<b>**html**</b>' },
    paragraph({ type: 'link', url: 'x', children: [text('**链接：**文字')] }),
  );
  run(tree);
  assert.deepEqual(tree.children[0].children, [{ type: 'strong', children: [text('标题：')] }, text('说明'), { type: 'inlineCode', value: '**不动**' }]);
  assert.deepEqual(tree.children[1].children[0].children[0].children, [{ type: 'strong', children: [text('列：')] }, text('值')]);
  assert.equal(tree.children[2].value, '**代码里的星号**');
  assert.equal(tree.children[3].value, '<b>**html**</b>');
  assert.deepEqual(tree.children[4].children[0].children, [{ type: 'strong', children: [text('链接：')] }, text('文字')]);
});

test('a text node whose source differs (escapes or entities) is never rewritten', () => {
  const source = String.raw`\*\*字面星号\*\*`;
  const literal = { type: 'text', value: '**字面星号**', position: { start: { offset: 0 }, end: { offset: source.length } } };
  run(root(paragraph(literal)), source);
  assert.equal(literal.value, '**字面星号**');
  const plain = '**真加粗：**后文';
  const real = { type: 'text', value: plain, position: { start: { offset: 0 }, end: { offset: plain.length } } };
  const tree = run(root(paragraph(real)), plain);
  assert.equal(tree.children[0].children[0].type, 'strong');
});

// ---------------------------------------------------------------------------------------------
// 状态看板：分栏、排序、限量、拖放。
// ---------------------------------------------------------------------------------------------
const session = (id, modified, extra = {}) => ({ id, modified, created: modified, ...extra });
const resolver = (table = {}) => s => table[s.id] ?? { status: 'todo', assigned: false };

test('column rules: running beats everything, unread only moves sessions without an assigned status', () => {
  assert.equal(boardColumnOf({ running: true, unread: true, status: 'done', assigned: true }), 'running');
  assert.equal(boardColumnOf({ running: false, unread: true, status: 'todo', assigned: false }), 'attention');
  assert.equal(boardColumnOf({ running: false, unread: true, status: 'todo', assigned: true }), 'todo', 'an explicit drag to todo must stick');
  assert.equal(boardColumnOf({ running: false, unread: true, status: 'done', assigned: true }), 'done');
  assert.equal(boardColumnOf({ running: false, unread: false, status: 'needs-review', assigned: true }), 'attention');
  assert.equal(boardColumnOf({ running: false, unread: false, status: 'backlog', assigned: true }), 'backlog');
  assert.equal(boardColumnOf({ running: false, unread: true, status: 'cancelled', assigned: true }), 'cancelled');
});

test('only workflow columns accept drops and each maps to a real status', () => {
  assert.equal(canDropInto('running'), false);
  for (const id of ['attention', 'todo', 'backlog', 'done', 'cancelled']) assert.equal(canDropInto(id), true, id);
  assert.deepEqual(Object.keys(COLUMN_STATUS).sort(), ['attention', 'backlog', 'cancelled', 'done', 'todo']);
  assert.equal(COLUMN_STATUS.attention, 'needs-review');
  assert.deepEqual(BOARD_COLUMNS.map(c => c.id), ['running', 'attention', 'todo', 'backlog', 'done', 'cancelled']);
});

test('buildBoard sorts newest first, hides cancelled by default and limits long columns until expanded', () => {
  const sessions = Array.from({ length: 14 }, (_, i) => session(`t${i}`, `2026-11-0${1 + (i % 8)}T10:${String(i).padStart(2, '0')}:00Z`));
  sessions.push(session('r1', '2026-11-08T08:00:00Z'), session('c1', '2026-11-08T09:00:00Z'), session('d1', '2026-11-08T07:00:00Z'));
  const statusOf = resolver({ c1: { status: 'cancelled', assigned: true }, d1: { status: 'done', assigned: true } });
  const input = { sessions, statusOf, isRunning: s => s.id === 'r1', isUnread: () => false };
  const board = buildBoard(input);
  assert.deepEqual(board.map(c => c.id), ['running', 'attention', 'todo', 'backlog', 'done'], 'cancelled column is hidden');
  const todo = board.find(c => c.id === 'todo');
  assert.equal(todo.total, 14);
  assert.equal(todo.items.length, 10);
  assert.equal(todo.hidden, 4);
  for (let i = 1; i < todo.items.length; i += 1) assert.ok(Date.parse(todo.items[i - 1].modified) >= Date.parse(todo.items[i].modified), 'newest first');
  assert.equal(board.find(c => c.id === 'running').items[0].id, 'r1');
  const expanded = buildBoard({ ...input, expanded: new Set(['todo']), showCancelled: true });
  assert.equal(expanded.find(c => c.id === 'todo').items.length, 14);
  assert.equal(expanded.find(c => c.id === 'todo').hidden, 0);
  assert.equal(expanded.find(c => c.id === 'cancelled').items[0].id, 'c1');
});

test('buildBoard honours the include filter and routes unread to the attention column', () => {
  const sessions = [session('a', '2026-11-01T00:00:00Z', { project: 'x' }), session('b', '2026-11-02T00:00:00Z', { project: 'y' })];
  const board = buildBoard({ sessions, statusOf: resolver(), isRunning: () => false, isUnread: s => s.id === 'b', include: s => s.project === 'y' });
  assert.deepEqual(board.find(c => c.id === 'attention').items.map(s => s.id), ['b']);
  assert.equal(board.find(c => c.id === 'todo').total, 0);
});

test('resume candidates: running first, then attention, then the most recent; done and cancelled never', () => {
  const sessions = [
    session('recent', '2026-11-08T12:00:00Z'), session('old', '2026-11-01T12:00:00Z'), session('review', '2026-11-05T12:00:00Z'),
    session('live', '2026-11-02T12:00:00Z'), session('finished', '2026-11-08T13:00:00Z'), session('dropped', '2026-11-08T14:00:00Z'),
  ];
  const statusOf = resolver({ review: { status: 'needs-review', assigned: true }, finished: { status: 'done', assigned: true }, dropped: { status: 'cancelled', assigned: true } });
  const picked = resumeCandidates({ sessions, statusOf, isRunning: s => s.id === 'live', isUnread: () => false, limit: 3 });
  assert.deepEqual(picked.map(item => item.session.id), ['live', 'review', 'recent']);
  assert.deepEqual(picked.map(item => item.column), ['running', 'attention', 'todo']);
});

// ---------------------------------------------------------------------------------------------
// 过程折叠行摘要。
// ---------------------------------------------------------------------------------------------
const tool = toolName => ({ type: 'tool', block: { type: 'toolCall', toolName } });

test('tool names are grouped by what they do', () => {
  assert.equal(toolGroup('bash'), '命令');
  assert.equal(toolGroup('browser_task'), '网页');
  assert.equal(toolGroup('read'), '读取');
  assert.equal(toolGroup('write'), '编辑');
  assert.equal(toolGroup('edit'), '编辑');
  assert.equal(toolGroup('grep'), '搜索');
  assert.equal(toolGroup('ls'), '搜索');
  assert.equal(toolGroup('custom_tool'), '其他');
  assert.equal(toolGroup('tools_inventory'), '其他', '"ls" must not match inside other words');
});

test('elapsed time reads naturally from seconds to hours and stays quiet under a second', () => {
  assert.equal(formatElapsed(400), '');
  assert.equal(formatElapsed(Number.NaN), '');
  assert.equal(formatElapsed(26_400), '26 秒');
  assert.equal(formatElapsed(60_000), '1 分');
  assert.equal(formatElapsed(221_000), '3 分 41 秒');
  assert.equal(formatElapsed(3_600_000), '1 小时');
  assert.equal(formatElapsed(3_720_000), '1 小时 2 分');
});

test('breakdown lists the busiest groups, folds the rest into 其他 and appends the elapsed time', () => {
  const activities = [tool('read'), tool('grep'), { type: 'intermediate', block: { type: 'text' } }, tool('write'), tool('edit'), tool('bash')];
  assert.equal(timelineBreakdown(activities, 1_000, 27_000), '编辑 2 · 命令 1 · 读取 1 · 搜索 1 · 用时 26 秒');
  assert.equal(timelineBreakdown(activities, undefined, undefined), '编辑 2 · 命令 1 · 读取 1 · 搜索 1');
  const many = [tool('bash'), tool('bash'), tool('bash'), tool('read'), tool('read'), tool('edit'), tool('grep'), tool('browser'), tool('mystery')];
  assert.equal(timelineBreakdown(many, 0, 5_000), '命令 3 · 读取 2 · 网页 1 · 编辑 1 · 其他 2 · 用时 5 秒');
  assert.equal(timelineBreakdown([{ type: 'intermediate', block: { type: 'text' } }], 0, 100), '');
  assert.equal(timelineBreakdown([], 0, 90_000), '用时 1 分 30 秒');
});
