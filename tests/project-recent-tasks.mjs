import './piweb-craft-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RECENT_TASK_LIMIT, RECENT_TASK_VISIBLE, isTestTask, recentTaskCandidates, recentTasks, sortProjectGroups } from '../assets/piweb-overlay/recent-tasks.mjs';
const now = Date.parse('2026-10-27T12:00:00Z');
const family = (id, modified, created = modified, child = []) => ({ root: { id, modified, created }, subagents: child });
test('recent view takes ten by actual assistant reply, without a one-hour cutoff or running priority', () => {
  const entries = Array.from({ length: 14 }, (_, i) => family(`task-${String(i).padStart(2, '0')}`, '2026-10-27T11:59:00Z', '2026-10-01T00:00:00Z'));
  entries[0].subagents = [{ id: 'child' }];
  const running = new Set(['child']), replies = Object.fromEntries(entries.map((f, i) => [f.root.id, new Date(Date.UTC(2026, 9, i + 1)).toISOString()]));
  assert.equal(recentTaskCandidates(entries, running, now).length, 14);
  const expected = entries.slice(4).reverse().map(f => f.root.id);
  assert.deepEqual(recentTasks(entries, running, replies, now).map(f => f.root.id), expected);
  assert.deepEqual(recentTasks(entries, new Set(), replies, now + 86400000).map(f => f.root.id), expected);
  assert.equal(RECENT_TASK_LIMIT, 10); assert.equal(RECENT_TASK_VISIBLE, 5);
  assert.deepEqual(entries.map(f => f.root.id), Array.from({ length: 14 }, (_, i) => `task-${String(i).padStart(2, '0')}`));
});
test('explicit test sessions are excluded before ranking and older real work fills the list', () => {
  const entries = Array.from({ length: 14 }, (_, i) => family(`s${String(i).padStart(2, '0')}`, new Date(Date.UTC(2026, 9, i + 1)).toISOString()));
  entries[13].root.firstMessage = '【测试任务】只回答8加5';
  entries[12].root.testTask = true;
  entries[11].root.firstMessage = '我认为应该设立计划测试项目';
  entries[10].root.firstMessage = '这个按钮需要测试和验收';
  const ids = new Set(['s09']), running = new Set(['s09', 's13']);
  assert.equal(isTestTask(entries[13].root, ids), true); assert.equal(isTestTask(entries[12].root, ids), true);
  assert.equal(isTestTask(entries[11].root, ids), false); assert.equal(isTestTask(entries[10].root, ids), false);
  const candidates = recentTaskCandidates(entries, running, now, ids);
  assert.equal(candidates.length, 11);
  assert.deepEqual(recentTasks(entries, running, {}, now, ids).map(f => f.root.id), ['s11', 's10', 's08', 's07', 's06', 's05', 's04', 's03', 's02', 's01']);
  assert.equal(entries.length, 14); assert.equal(entries[9].root.id, 's09');
});
test('missing replies use creation time; equal timestamps have a deterministic order', () => {
  const entries = [family('b', '2026-10-27T11:59:00Z', '2026-10-01T00:00:00Z'), family('a', '2026-10-27T12:00:00Z', '2026-10-01T00:00:00Z')];
  assert.deepEqual(recentTasks(entries, new Set(), {}, now).map(f => f.root.id), ['a', 'b']);
});
test('projects sort by conversation count descending, then newest actual assistant reply', () => {
  const group = (name, ids) => ({ project: { name }, families: ids.map(id => family(id, '2026-10-27T11:59:00Z')) });
  const projects = [group('small-newest', ['x']), group('equal-old', ['a', 'b']), group('large-old', ['d', 'e', 'f']), group('equal-new', ['g', 'h']), group('equal-unknown', ['z', 'w'])];
  const replies = { x: '2026-10-27T11:59:00Z', a: '2026-10-25T12:00:00Z', b: '2026-10-25T11:00:00Z', d: '2026-10-20T00:00:00Z', g: '2026-10-26T23:00:00Z', h: '2026-10-27T10:00:00Z' };
  assert.deepEqual(sortProjectGroups(projects, replies).map(item => item.project.name), ['large-old', 'equal-new', 'equal-old', 'equal-unknown', 'small-newest']);
  assert.deepEqual(projects.map(item => item.project.name), ['small-newest', 'equal-old', 'large-old', 'equal-new', 'equal-unknown']);
  assert.deepEqual(sortProjectGroups([group('first', ['n']), group('second', ['m'])], {}).map(item => item.project.name), ['first', 'second']);
});
test('sidebar labels recent tasks, removes month headings and keeps monthly storage untouched', () => {
  const tree = fs.readFileSync(new URL('../assets/piweb-overlay/ProjectTree.tsx', import.meta.url), 'utf8');
  assert.match(tree, /name: '最近任务'/); assert.match(tree, /recentTasks\(allFamilies/); assert.match(tree, /\/api\/session-reply-times/);
  assert.match(tree, /name: '最近任务'[^\n]*\.\.\.sortProjectGroups\(result, allReplies\)/);
  assert.doesNotMatch(tree, /pw-tree-month|monthOf\(|最近1小时/); assert.match(tree, /ordered\.slice\(0, RECENT_TASK_VISIBLE\)/);
  assert.match(tree, /selectedGroup !== '__inbox'/); assert.match(tree, /aria-expanded=\{more\.has\(project\.key\)\}/);
  assert.match(tree, /recentArchive\.testIds === null \? \[\]/); assert.match(tree, /recentTasks\(allFamilies, runningSessionIds, allReplies, clock, testIds\)/);
  const route = fs.readFileSync(new URL('../assets/piweb-overlay/session-reply-times-route.ts', import.meta.url), 'utf8');
  assert.match(route, /recentTasks\(values\.map/); assert.doesNotMatch(route, /3600000|cutoff/);
  assert.match(route, /recent-test-sessions\.json/); assert.match(route, /new Set\(testSessionIds\)/); assert.match(route, /testSessionIds, incomplete/);
  const routing = fs.readFileSync(new URL('../assets/piweb-overlay/project-routing.mjs', import.meta.url), 'utf8'); assert.match(routing, /sessionMonth\(s\.header\.timestamp/);
});
