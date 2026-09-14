import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore, directoryPath, projectKey, relocateSessionHeader, relocateSessionHeaders, assertSessionNotMoving, withSessionMoveLock, projectMutationAllowed } from '../assets/piweb-overlay/portable-project-store.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-projects-'));
const store = new ProjectStore(path.join(root, 'state', 'projects.json'));
const source = path.join(root, '项目 A'), target = path.join(root, '中文 空格', 'project B');
const sessions = path.join(root, 'sessions');
fs.mkdirSync(source); fs.mkdirSync(sessions);
const fixture = (id, cwd = source, parentSession) => {
  const file = path.join(sessions, id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01', ...(parentSession ? { parentSession } : {}) }) + '\r\n' + '{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"完整 历史"}}\r\n' + '{"type":"compaction","id":"b","parentId":"a","summary":"保留分支"}\r\n');
  return file;
};
test('creates real nested folder and persists an empty project without a session', () => {
  store.add(target, target, true);
  assert.ok(fs.statSync(target).isDirectory());
  assert.equal(new ProjectStore(store.file).read().projects[0].root, target);
  assert.equal(fs.readdirSync(sessions).length, 0);
});
test('add is idempotent; removal preserves physical files and can be restored', () => {
  const marker = path.join(target, 'important.txt'); fs.writeFileSync(marker, 'unchanged');
  store.add(target);
  assert.equal(store.read().projects.length, 1);
  store.remove(target); store.remove(target);
  assert.equal(store.read().projects.length, 0);
  assert.deepEqual(store.read().hidden, [projectKey(target)]);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
  store.add(target);
  assert.deepEqual(store.read().hidden, []);
});
test('rejects relative, blank, control characters and file-as-directory', () => {
  for (const p of ['', '  ', 'relative/project', 'D:relative', 'bad\0path']) assert.throws(() => directoryPath(p));
  assert.throws(() => store.add(path.join(target, 'important.txt')), /不是文件夹/);
  assert.equal(directoryPath('~'), os.homedir());
});
test('corrupt registry is not overwritten or silently ignored', () => {
  const p = path.join(root, 'bad.json'); fs.writeFileSync(p, '{bad');
  assert.throws(() => new ProjectStore(p).remove(source));
  assert.equal(fs.readFileSync(p, 'utf8'), '{bad');
});
test('moves native cwd preserving ID, full history bytes, fork links, path and verified backup', () => {
  const file = fixture('main', source, 'parent.jsonl'), before = fs.readFileSync(file);
  const result = relocateSessionHeader(file, 'main', target, sessions);
  assert.ok(result.changed);
  const after = fs.readFileSync(file), header = JSON.parse(after.subarray(0, after.indexOf(10)).toString());
  assert.equal(header.cwd, target); assert.equal(header.id, 'main'); assert.equal(header.parentSession, 'parent.jsonl');
  assert.ok(after.subarray(after.indexOf(10) + 1).equals(before.subarray(before.indexOf(10) + 1)));
  assert.ok(fs.readFileSync(result.backups[0]).equals(before));
  assert.ok(!relocateSessionHeader(file, 'main', target, sessions).changed);
});
test('full family validates before writing any header', () => {
  const a = fixture('family-a'), b = fixture('family-b'), before = fs.readFileSync(a);
  assert.throws(() => relocateSessionHeaders([{ id: 'family-a', path: a }, { id: 'wrong', path: b }], target, sessions), /身份/);
  assert.ok(fs.readFileSync(a).equals(before));
  relocateSessionHeaders([{ id: 'family-a', path: a }, { id: 'family-b', path: b }], target, sessions);
  for (const p of [a,b]) assert.equal(JSON.parse(fs.readFileSync(p,'utf8').split('\n')[0]).cwd, target);
});
test('rejects out-of-root sessions and missing destinations without mutation', () => {
  const file = fixture('outside'), before = fs.readFileSync(file);
  assert.throws(() => relocateSessionHeader(file, 'outside', target, source), /受管目录/);
  assert.throws(() => relocateSessionHeader(file, 'outside', path.join(root,'absent'), sessions));
  assert.ok(fs.readFileSync(file).equals(before));
});
test('mutation locks reject concurrent prompt/move and always release on failure', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const pending = withSessionMoveLock(['one', 'child'], () => gate);
  assert.throws(() => assertSessionNotMoving('one'), /正在移动/);
  assert.throws(() => assertSessionNotMoving('child'), /正在移动/);
  await assert.rejects(withSessionMoveLock(['one'], async () => {}), /正在移动/);
  release(); await pending; assert.doesNotThrow(() => assertSessionNotMoving('one'));
  await assert.rejects(withSessionMoveLock(['one'], async () => { throw Error('disk'); }), /disk/);
  assert.doesNotThrow(() => assertSessionNotMoving('one'));
});
test('origin checks use browser Host through reverse proxy, rejecting cross-site and malformed origins', () => {
  const request = headers => new Request('http://localhost:30140/api/projects', { headers });
  assert.ok(projectMutationAllowed(request({ host: '127.0.0.1:30141', origin: 'http://127.0.0.1:30141' })));
  assert.ok(!projectMutationAllowed(request({ host: '127.0.0.1:30141', origin: 'http://evil.example' })));
  assert.ok(!projectMutationAllowed(request({ host: '127.0.0.1:30141', origin: 'null' })));
  assert.ok(!projectMutationAllowed(request({ host: '127.0.0.1:30141', 'sec-fetch-site': 'cross-site' })));
});
test('native source uses busy checks, safe paths, and no new model or prompt calls', () => {
  const route = fs.readFileSync(new URL('../assets/piweb-overlay/portable-session-move-route.ts', import.meta.url),'utf8');
  const ui = fs.readFileSync(new URL('../assets/piweb-overlay/PortableProjects.tsx', import.meta.url),'utf8');
  assert.match(route, /isBusyForProjectMove/); assert.match(route, /isRpcSessionStarting/);
  assert.match(route, /invalidateSessionListCache/); assert.match(route, /withSessionMoveLock/);
  assert.doesNotMatch(route, /type: ['"]prompt|startRpcSession|unlink|rmSync/);
  assert.match(ui, /showModal/); assert.match(ui, /role="alert"/); assert.match(ui, /移动到项目/);
});
console.log('Project fixtures retained at', root);
