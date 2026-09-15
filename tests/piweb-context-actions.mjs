import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { ProjectStore, withSessionMoveLock, assertSessionNotMoving } from '../assets/piweb-overlay/portable-project-store.mjs';
import { renamePhysicalProject, relocateCopiedProject, projectLeafTarget } from '../assets/piweb-overlay/portable-project-layout.mjs';
import { validateProjectDeletion, deleteProjectDirectory, deleteSessionFiles, withProjectDeletionLock, assertProjectAvailable } from '../assets/piweb-overlay/portable-context-store.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-context-'));
const folder = name => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
test('physical rename updates all native cwd headers, registry and nested projects; preserves every history byte and original JSONL paths', () => {
  const p = folder('中文 项目'), child = folder('中文 项目/sub'), marker = path.join(p, 'asset'); fs.writeFileSync(marker, 'unchanged');
  const store = new ProjectStore(path.join(root, 'projects.json')); store.add(p); store.add(child);
  const sessionRoot = folder('rename-sessions');
  const sessions = [p, child].map((cwd, i) => {
    const id = 'rename-' + i, file = path.join(sessionRoot, id + '.jsonl');
    const bytes = Buffer.from(JSON.stringify({type:'session',id,cwd}) + '\r\n{"type":"message","text":"历史"}\r\n'); fs.writeFileSync(file, bytes);
    return { id, cwd, path: file, bytes };
  });
  const args = { root: p, name: '新的项目名称', registry: store, sessions, sessionRoot, knownRoots: [p] };
  const result = renamePhysicalProject(args), target = path.join(root, args.name);
  assert.ok(!fs.existsSync(p)); assert.equal(fs.readFileSync(path.join(target,'asset'), 'utf8'), 'unchanged');
  assert.ok(new ProjectStore(store.file).read().projects.some(p => p.name === args.name && p.root === target));
  assert.ok(store.read().projects.some(p => p.root === path.join(target, 'sub')));
  assert.equal(result.sessionIds.length, 2); assert.ok(result.backups.length >= 3);
  sessions.forEach(s => { const b = fs.readFileSync(s.path); assert.deepEqual(b.subarray(b.indexOf(10)+1), s.bytes.subarray(s.bytes.indexOf(10)+1)); assert.equal(JSON.parse(b.subarray(0,b.indexOf(10))).cwd, path.join(target,path.relative(p,s.cwd))); });
  store.remove(target); assert.ok(fs.existsSync(path.join(target, 'asset')));
});
test('rename rejects path traversal, reserved names, target conflicts and invalid session headers before any filesystem change', () => {
  const p = folder('rename-reject'), conflict = folder('conflict'), sessionRoot = folder('reject-sessions');
  const store = new ProjectStore(path.join(root,'reject.json')); store.add(p);
  for (const name of [' ', '..', '../escape', 'a/b', 'a\\\\b', 'NUL', 'CON.txt', 'a.', 'a ', 'LPT1', 'a:b']) assert.throws(() => projectLeafTarget(p, name), name);
  const args = {root:p,name:'conflict',registry:store,sessions:[],sessionRoot,knownRoots:[p]};
  assert.throws(() => renamePhysicalProject(args)); assert.ok(fs.existsSync(conflict)); assert.ok(fs.existsSync(p));
  const file=path.join(sessionRoot,'bad.jsonl');fs.writeFileSync(file,'{"type":"session","id":"other"}\n');
  assert.throws(() => renamePhysicalProject({...args,name:'valid',sessions:[{id:'bad',cwd:p,path:file}]}));assert.ok(fs.existsSync(p));assert.ok(!fs.existsSync(path.join(root,'valid')));
});
test('rename rolls back folder and headers if registry commit fails', () => {
  const p=folder('rollback-project'), sessionRoot=folder('rollback-sessions'), file=path.join(sessionRoot,'s.jsonl');
  const before=Buffer.from(JSON.stringify({type:'session',id:'rollback',cwd:p})+'\n{"history":true}\n');fs.writeFileSync(file,before);
  const store=new ProjectStore(path.join(root,'rollback.json'));store.add(p);const registryBefore=fs.readFileSync(store.file);store.rebase=()=>{throw Error('injected registry failure')};
  assert.throws(()=>renamePhysicalProject({root:p,name:'rollback-target',registry:store,sessions:[{id:'rollback',cwd:p,path:file}],sessionRoot,knownRoots:[p]}),/injected/);
  assert.ok(fs.existsSync(p));assert.ok(!fs.existsSync(path.join(root,'rollback-target')));assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(store.file),registryBefore);
});
test('copy relocation preserves original folders, nested cwd, exact history, categories and deduplicated destination', () => {
  const p=folder('copy-source'), child=folder('copy-source/nested'), target=folder('copy-target'), sr=folder('copy-sessions'), file=path.join(sr,'copy.jsonl');
  const bytes=Buffer.from(JSON.stringify({type:'session',id:'copy',cwd:child})+'\n{"history":"same"}\n');fs.writeFileSync(file,bytes);
  const store=new ProjectStore(path.join(root,'copy-projects.json'));store.add(p);store.add(target);const state=store.read();state.categories=[{name:'local only',root}];store.save(state);
  const args={root:p,target,registry:store,sessions:[{id:'copy',cwd:child,path:file}],sessionRoot:sr,knownRoots:[p]};
  assert.throws(()=>relocateCopiedProject(args));assert.deepEqual(fs.readFileSync(file),bytes);
  folder('copy-target/nested');const result=relocateCopiedProject(args);assert.ok(fs.existsSync(p));assert.ok(fs.existsSync(target));
  assert.equal(store.read().projects.filter(p=>p.root===target).length,1);assert.deepEqual(store.read().categories,state.categories);assert.equal(result.sessionIds.length,1);
  const after=fs.readFileSync(file);assert.deepEqual(after.subarray(after.indexOf(10)+1),bytes.subarray(bytes.indexOf(10)+1));
  assert.equal(JSON.parse(after.subarray(0,after.indexOf(10))).cwd,path.join(target,'nested'));
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
test('row archive shortcut and reserved slot are hidden without touching the menu or archive-view entry', () => {
  const archive = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');
  assert.ok(archive.includes('.sidebar-container [data-pi-session-id]>div:has(>[data-pi-session-archive-action]),.sidebar-container [data-pi-session-id] [data-pi-session-archive-action]{display:none!important}'));
  assert.match(archive, /function ensureControl\(\)/u);
  assert.match(archive, /window.addEventListener\('pi-web:archive-session'/u);
  assert.doesNotMatch(archive, /\[data-pi-session-archive-control\]\{display:none/u);
});
console.log('Context-action fixtures:', root);
