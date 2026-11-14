import test from 'node:test';
import assert from 'node:assert/strict';
import { portableCjkEmphasis, splitCjkStrong } from '../assets/piweb-overlay/merge/lib/portable-cjk-emphasis.mjs';
import { resumeCandidates } from '../assets/piweb-overlay/merge/lib/portable-session-resume.mjs';
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
// 新会话页「继续任务」：运行、未读、最近修改排序。
// ---------------------------------------------------------------------------------------------
const session = (id, modified, extra = {}) => ({ id, modified, created: modified, ...extra });
const resolver = (table = {}) => s => table[s.id] ?? { status: 'todo', assigned: false };

test('resume candidates respect explicit statuses and include filters', () => {
  const sessions = [session('one', '2026-11-01T00:00:00Z', { project: 'x' }), session('two', '2026-11-02T00:00:00Z', { project: 'y' })];
  const picked = resumeCandidates({ sessions, statusOf: resolver(), isRunning: () => false, isUnread: s => s.id === 'two', include: s => s.project === 'y' });
  assert.deepEqual(picked.map(item => [item.session.id, item.column]), [['two', 'attention']]);
  const assigned = resumeCandidates({ sessions, statusOf: resolver({ two: { status: 'todo', assigned: true } }), isRunning: () => false, isUnread: s => s.id === 'two' });
  assert.equal(assigned[0].column, 'todo', 'explicit status wins over unread');
});

test('resume candidates: running, then new replies, then the most recent; stale needs-review, done, backlog and cancelled never crowd them out', () => {
  const sessions = [
    session('recent', '2026-11-08T12:00:00Z'), session('old', '2026-11-01T12:00:00Z'), session('review', '2026-11-05T12:00:00Z'),
    session('live', '2026-11-02T12:00:00Z'), session('finished', '2026-11-08T13:00:00Z'), session('dropped', '2026-11-08T14:00:00Z'),
    session('parked', '2026-11-08T15:00:00Z'), session('fresh', '2026-11-03T12:00:00Z'),
  ];
  const statusOf = resolver({
    review: { status: 'needs-review', assigned: true }, finished: { status: 'done', assigned: true },
    dropped: { status: 'cancelled', assigned: true }, parked: { status: 'backlog', assigned: true },
  });
  const picked = resumeCandidates({ sessions, statusOf, isRunning: s => s.id === 'live', isUnread: s => s.id === 'fresh', limit: 3 });
  assert.deepEqual(picked.map(item => item.session.id), ['live', 'fresh', 'recent']);
  assert.deepEqual(picked.map(item => item.column), ['running', 'attention', 'todo']);
  const more = resumeCandidates({ sessions, statusOf, isRunning: () => false, isUnread: () => false, limit: 10 });
  assert.deepEqual(more.map(item => item.session.id), ['recent', 'review', 'fresh', 'live', 'old'], 'needs-review is just another recent session here');
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
