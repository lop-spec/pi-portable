import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATUSES, statusOf, isFlagged, groupedSessions } from '../assets/piweb-overlay/craft-session/model.mjs';
import { readStatusStore, updateStatusStore } from '../assets/piweb-overlay/craft-session/store.mjs';

test('Craft status order and default are independent of processing and archive', () => {
  assert.deepEqual(STATUSES.map(x => x.id), ['backlog', 'todo', 'needs-review', 'done', 'cancelled']);
  assert.equal(statusOf({}, 'old'), 'todo');
  const records = { a: { status: 'done', flagged: true }, b: { status: 'needs-review', flagged: false } };
  const sessions = [{ id: 'a', modified: '2026-10-28T16:00:00Z', created: '2026-10-28T16:00:00Z' }, { id: 'b', modified: '2026-10-27T16:00:00Z', created: '2026-10-27T16:00:00Z' }];
  assert.deepEqual(groupedSessions(sessions, records, 'flagged').flatMap(x => x.items.map(y => y.id)), ['a']);
  assert.deepEqual(groupedSessions(sessions, records, 'needs-review').flatMap(x => x.items.map(y => y.id)), ['b']);
  assert.equal(isFlagged(records, 'a'), true); assert.equal(isFlagged(records, 'b'), false);
});
test('status survives reload, independent flag changes and project path moves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-craft-status-'));
  const id = 'session-123';
  updateStatusStore(dir, id, { status: 'needs-review' });
  updateStatusStore(dir, id, { flagged: true });
  assert.deepEqual(readStatusStore(dir).sessions[id], { status: 'needs-review', flagged: true });
  updateStatusStore(dir, id, { status: 'done' });
  assert.deepEqual(readStatusStore(dir).sessions[id], { status: 'done', flagged: true });
  updateStatusStore(dir, id, { flagged: false });
  updateStatusStore(dir, id, { status: 'todo' });
  assert.equal(readStatusStore(dir).sessions[id], undefined);
});
test('bad status, prototype ids and corrupt files fail closed without overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-craft-status-'));
  for (const id of ['constructor', '__proto__', '../other']) assert.throws(() => updateStatusStore(dir, id, { status: 'done' }));
  assert.throws(() => updateStatusStore(dir, 'good', { status: 'archive' }));
  assert.throws(() => updateStatusStore(dir, 'good', { flagged: 'yes' }));
  const file = path.join(dir, 'web-session-status.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => updateStatusStore(dir, 'good', { status: 'done' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('navigation keeps project view and uses existing guarded archive API', () => {
  const tree = fs.readFileSync(new URL('../assets/piweb-overlay/ProjectTree.tsx', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('../assets/piweb-overlay/craft-session/CraftSessions.tsx', import.meta.url), 'utf8');
  assert.match(tree, /useState<'status' \| 'project'>\('status'\)/);
  assert.match(tree, /groups\.map\(\(\{ project, families \}\)/);
  assert.match(tree, /\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/\$\{archived \? 'restore' : 'archive'\}/);
  assert.match(view, /筛选状态/); assert.match(view, /已标记/); assert.match(view, /已归档/);
  assert.doesNotMatch(view, /kill|abort|sendAgentCommand/);
});
