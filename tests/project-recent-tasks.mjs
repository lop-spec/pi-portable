import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recentTaskCandidates, recentTasks, sortProjectGroups } from '../assets/piweb-overlay/recent-tasks.mjs';
const now = Date.parse('2026-10-27T12:00:00Z');
const family = (id, modified, created = modified, child = []) => ({ root: { id, modified, created }, subagents: child });
test('recent view spans projects, includes all running families and orders by actual assistant reply', () => {
  const entries = [
    family('old', '2026-10-27T08:00:00Z'),
    family('user-new', '2026-10-27T11:58:00Z'),
    family('running', '2026-10-27T08:00:00Z', '2026-10-27T07:00:00Z', [{ id: 'child' }]),
    family('reply-early', '2026-10-27T11:50:00Z'),
    family('reply-late', '2026-10-27T10:00:00Z'),
  ];
  const running = new Set(['child']), replies = { 'user-new': '2026-10-27T10:00:00Z', running: '2026-10-27T08:00:00Z', 'reply-early': '2026-10-27T11:10:00Z', 'reply-late': '2026-10-27T11:45:00Z' };
  assert.deepEqual(recentTaskCandidates(entries, running, now).map(f => f.root.id), ['old', 'user-new', 'running', 'reply-early', 'reply-late']);
  assert.deepEqual(recentTasks(entries, running, replies, now).map(f => f.root.id), ['reply-late', 'reply-early', 'running']);
  assert.deepEqual(recentTasks(entries, new Set(), replies, now + 3600000).map(f => f.root.id), []);
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
  assert.doesNotMatch(tree, /pw-tree-month|monthOf\(/); assert.match(tree, /project\.key === '__inbox' \|\| more/);
  const routing = fs.readFileSync(new URL('../assets/piweb-overlay/project-routing.mjs', import.meta.url), 'utf8'); assert.match(routing, /sessionMonth\(s\.header\.timestamp/);
});
