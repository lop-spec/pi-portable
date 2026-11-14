import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as base from '../assets/piweb-overlay/craft-session/model.mjs';
import * as runtime from '../assets/piweb-overlay/session-runtime/model.mjs';
import { readStatusStore, updateStatusStore } from '../assets/piweb-overlay/craft-session/store.mjs';
import { recentTasks } from '../assets/piweb-overlay/recent-tasks.mjs';
import { integrate } from '../tools/patch-piweb-source.mjs';

const before = '2026-11-14T10:00:00Z', classified = '2026-11-14T11:00:00Z', after = '2026-11-14T12:00:00Z';
for (const [name, model] of [['base', base], ['runtime', runtime]]) {
  test(`${name}: new user/assistant activity overlaps todo and every original status`, () => {
    for (const { id: status } of model.STATUSES) {
      const session = { id: 'old-search-result', created: before, modified: before };
      const records = { [session.id]: { status, statusAssigned: true, statusUpdatedAt: classified, flagged: false } };
      assert.equal(model.isTodoSession(records, session), status === 'todo');
      session.modified = after;
      assert.equal(model.isTodoSession(records, session), true);
      assert.equal(model.matchesSessionFilter(records, session, status), true);
      assert.equal(model.groupedSessions([session], records, 'todo').flatMap(g => g.items).length, 1);
      assert.equal(model.statusOf(records, session.id), status);
      assert.equal(recentTasks([{ root: session, subagents: [] }], new Set(), { [session.id]: after }, Date.now(), new Set(), records).length, 1);
      records[session.id].statusUpdatedAt = after;
      assert.equal(model.isTodoSession(records, session), status === 'todo');
    }
    assert.equal(model.hasAssignedStatus({}, 'legacy'), false);
    assert.equal(model.isTodoSession({}, { id: 'legacy', modified: after }), true);
  });
}
test('legacy migration freezes one baseline; flags do not acknowledge a new reply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-todo-'));
  try {
    const file = path.join(dir, 'web-session-status.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { old: { status: 'needs-review', flagged: false } } }));
    fs.utimesSync(file, new Date(classified), new Date(classified));
    const first = readStatusStore(dir).sessions.old;
    assert.equal(Date.parse(first.statusUpdatedAt), Date.parse(classified));
    updateStatusStore(dir, 'old', { flagged: true });
    assert.equal(readStatusStore(dir).sessions.old.statusUpdatedAt, first.statusUpdatedAt);
    assert.equal(runtime.isTodoSession(readStatusStore(dir).sessions, { id: 'old', modified: after }), true);
    updateStatusStore(dir, 'old', { status: 'needs-review' }, after);
    assert.equal(runtime.isTodoSession(readStatusStore(dir).sessions, { id: 'old', modified: after }), false);
    assert.equal(readStatusStore(dir).sessions.old.status, 'needs-review');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const upstream = process.env.PIWEB_UPSTREAM_SOURCE || [path.resolve('upstream'), 'D:/Documents/claude/scratch/piweb-redesign/upstream-src'].find(p => fs.existsSync(path.join(p, 'package.json')));
test('final integration gives search a sibling status button and unassigned circle', { skip: !upstream }, () => {
  const files = integrate(name => fs.readFileSync(path.join(upstream, name), 'utf8'));
  const search = files.get('components/SessionSearch.tsx'), tree = files.get('components/ProjectTree.tsx'), craft = files.get('components/CraftSessions.tsx');
  assert.match(search, /className="pw-search-row"[^]*renderStatus\?\.\(session\)[^]*<button/);
  assert.match(tree, /renderStatus=\{session => <StatusButton/);
  assert.match(craft, /assigned \? statusOf\(records, id\) : 'unassigned'/);
  assert.match(craft, /data-workflow-status=\{status\}/);
  assert.match(craft, /matchesSessionFilter\(records, s, item.id\)/);
  assert.match(tree, /resumedIds/);
  assert.match(files.get('app/api/session-reply-times/route.ts'), /resumedSessionIds/);
});
