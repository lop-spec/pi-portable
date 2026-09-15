import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { ProjectStore, withSessionMoveLock, assertSessionNotMoving } from '../assets/piweb-overlay/portable-project-store.mjs';
import { validateProjectDeletion, deleteProjectDirectory, deleteSessionFiles, withProjectDeletionLock, assertProjectAvailable } from '../assets/piweb-overlay/portable-context-store.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-context-'));
const folder = name => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
test('project rename preserves folder, project identity and restart-persisted name', () => {
  const p = folder('中文 项目'), marker = path.join(p, 'asset'); fs.writeFileSync(marker, 'unchanged');
  const store = new ProjectStore(path.join(root, 'projects.json'));
  store.add(p); store.rename(p, '新的项目名称');
  assert.equal(new ProjectStore(store.file).read().projects[0].name, '新的项目名称');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
  assert.throws(() => store.rename(p, ' '));
  store.remove(p); assert.ok(fs.existsSync(marker));
});
test('physical project deletion demands exact confirmation and known identity', async () => {
  const p = folder('delete-me'); fs.writeFileSync(path.join(p, 'asset'), 'fixture');
  assert.throws(() => validateProjectDeletion(p, 'delete', { knownRoots: [p] }));
  assert.throws(() => validateProjectDeletion(p, p, { knownRoots: [] }));
  assert.ok(fs.existsSync(p));
  await deleteProjectDirectory(p, p, { knownRoots: [p] }); assert.ok(!fs.existsSync(p));
});
test('roots, runtime ancestors, user home and protected data cannot be deleted', () => {
  for (const p of [path.parse(root).root, os.homedir(), process.cwd()]) assert.throws(() => validateProjectDeletion(p, p, { knownRoots: [p] }));
  const p = folder('protected'); assert.throws(() => validateProjectDeletion(p, p, { knownRoots: [p], protectedRoots: [path.join(p, 'agent')] }));
});
test('symlink/junction projects and linked worktrees are rejected; child links never erase targets', async () => {
  const p = folder('external'), link = path.join(root, 'link'); fs.writeFileSync(path.join(p, 'keep'), 'safe');
  fs.symlinkSync(p, link, 'junction');
  assert.throws(() => validateProjectDeletion(link, link, { knownRoots: [link] }));
  const checkout = folder('checkout'); fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: elsewhere');
  assert.throws(() => validateProjectDeletion(checkout, checkout, { knownRoots: [checkout] }));
  const parent = folder('link-parent'); fs.symlinkSync(p, path.join(parent, 'child'), 'junction');
  await deleteProjectDirectory(parent, parent, { knownRoots: [parent] }); assert.equal(fs.readFileSync(path.join(p, 'keep'), 'utf8'), 'safe');
});
test('project deletion locks reject nested start/send and concurrent delete, release on failure', async () => {
  const p = folder('lock');
  await assert.rejects(withProjectDeletionLock(p, async () => {
    assert.throws(() => assertProjectAvailable(path.join(p, 'child')));
    await assert.rejects(withProjectDeletionLock(p, async () => {}));
    throw Error('fixture failure');
  }));
  assert.doesNotThrow(() => assertProjectAvailable(p));
});
test('session physical deletion validates full family before deleting and preserves independent files', () => {
  const sessions = folder('sessions');
  const fixture = id => { const p = path.join(sessions, id + '.jsonl'); fs.writeFileSync(p, JSON.stringify({type:'session', id})+'\n{"type":"message"}\n'); return {id, path:p}; };
  const a = fixture('parent'), b = fixture('child'), independent = fixture('fork');
  assert.throws(() => deleteSessionFiles([a, {...b,id:'wrong'}], sessions, 'parent', 'parent'));
  assert.ok(fs.existsSync(a.path)); assert.throws(() => deleteSessionFiles([a], sessions, '', 'parent'));
  assert.equal(deleteSessionFiles([a,b], sessions, 'parent', 'parent').length, 2);
  assert.ok(!fs.existsSync(a.path)); assert.ok(!fs.existsSync(b.path)); assert.ok(fs.existsSync(independent.path));
});
test('session file deletion rejects out-of-root files', () => {
  const sessions = folder('other-sessions'), p = path.join(root, 'outside.jsonl'); fs.writeFileSync(p, '{"type":"session","id":"outside"}\n');
  assert.throws(() => deleteSessionFiles([{id:'outside',path:p}], sessions, 'outside', 'outside')); assert.ok(fs.existsSync(p));
});
test('session lock is shared with moving and blocks concurrent writes', async () => {
  await withSessionMoveLock(['delete-id'], async () => { assert.throws(() => assertSessionNotMoving('delete-id')); });
  assert.doesNotThrow(() => assertSessionNotMoving('delete-id'));
});
test('icon menus reuse native event and immediate archive, no model calls or polling', () => {
  const ui = fs.readFileSync(new URL('../assets/piweb-overlay/PortableContextActions.tsx', import.meta.url), 'utf8');
  assert.match(ui, /pi-web:session-row-contextmenu/); assert.match(ui, /pi-web:archive-session/);
  assert.match(ui, /role="menuitem"/); assert.match(ui, /title=\{a.hint/); assert.match(ui, /Escape/);
  assert.doesNotMatch(ui, /setInterval|\/api\/agent/);
  const archive = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  assert.match(archive, /beginOptimisticAction\(row.querySelector/); assert.match(archive, /void performDirectAction\(pending, id\)/);
});
console.log('Context-action fixtures:', root);
