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
test('moves native cwd preserving ID, full history bytes, fork links, path and a journal of the original header', async () => {
  const file = fixture('main', source, 'parent.jsonl'), before = fs.readFileSync(file);
  const result = await relocateSessionHeader(file, 'main', target, sessions);
  assert.ok(result.changed);
  const after = fs.readFileSync(file), header = JSON.parse(after.subarray(0, after.indexOf(10)).toString());
  assert.equal(header.cwd, target); assert.equal(header.id, 'main'); assert.equal(header.parentSession, 'parent.jsonl');
  assert.ok(after.subarray(after.indexOf(10) + 1).equals(before.subarray(before.indexOf(10) + 1)));
  const journal = JSON.parse(fs.readFileSync(result.backups[0], 'utf8'));
  assert.equal(journal.sessions.length, 1);
  assert.equal(journal.sessions[0].header, before.subarray(0, before.indexOf(10) + 1).toString('utf8'), 'the journal holds the exact original header line, line ending included');
  assert.ok(!(await relocateSessionHeader(file, 'main', target, sessions)).changed);
});
test('a rename that fits the old header line is written in place: same size and inode, history never rewritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inplace-')), root2 = path.join(dir, 'sessions'); fs.mkdirSync(root2);
  const file = path.join(root2, 'big.jsonl'), long = path.join(dir, 'a-rather-long-project-folder-name'), short = path.join(dir, 'short');
  fs.mkdirSync(long); fs.mkdirSync(short);
  const history = ('{"type":"message","id":"x","message":{"role":"user","content":"' + 'h'.repeat(4000) + '"}}\n').repeat(2000);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'big', cwd: long }) + '\n' + history);
  const size = fs.statSync(file).size, ino = fs.statSync(file).ino;
  const result = await relocateSessionHeader(file, 'big', short, root2);
  const after = fs.readFileSync(file);
  assert.equal(after.length, size, 'the line is padded with spaces to its old length');
  assert.equal(fs.statSync(file).ino, ino, 'same file, no temp copy swapped in');
  assert.equal(JSON.parse(after.subarray(0, after.indexOf(10)).toString()).cwd, short);
  assert.equal(after.subarray(after.indexOf(10) + 1).toString(), history);
  assert.equal(fs.readdirSync(root2).length, 1, 'no leftover temp or backup copy next to the session');
  assert.ok(result.backups.length === 1 && result.backups[0].startsWith(path.join(dir, 'session-header-backups')));
});
test('a rename to a longer header streams once, leaves slack so the next one is in place, and the history stays exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-grow-')), root2 = path.join(dir, 'sessions'); fs.mkdirSync(root2);
  const file = path.join(root2, 'grow.jsonl'), a = path.join(dir, 'a'), b = path.join(dir, 'a-considerably-longer-folder-name-than-before'), c = path.join(dir, 'c');
  for (const p of [a, b, c]) fs.mkdirSync(p);
  const history = '{"type":"message","id":"m","message":{"role":"user","content":"历史 ' + 'y'.repeat(100000) + '"}}\n';
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'grow', cwd: a }) + '\r\n' + history);
  await relocateSessionHeader(file, 'grow', b, root2);
  let bytes = fs.readFileSync(file), end = bytes.indexOf(10);
  assert.equal(JSON.parse(bytes.subarray(0, end).toString()).cwd, b);
  assert.ok(bytes.subarray(0, end).toString().endsWith(' \r'), 'CRLF kept, slack spaces before it');
  assert.equal(bytes.subarray(end + 1).toString(), history);
  const grown = bytes.length, ino = fs.statSync(file).ino;
  await relocateSessionHeader(file, 'grow', c, root2);
  bytes = fs.readFileSync(file);
  assert.equal(bytes.length, grown, 'the second rename reuses the slack');
  assert.equal(fs.statSync(file).ino, ino);
  assert.equal(JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()).cwd, c);
  assert.equal(bytes.subarray(bytes.indexOf(10) + 1).toString(), history);
  assert.deepEqual(fs.readdirSync(root2), ['grow.jsonl']);
});
test('a session changed by another process after it was read is refused and left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-race-')), root2 = path.join(dir, 'sessions'); fs.mkdirSync(root2);
  const file = path.join(root2, 'race.jsonl'), a = path.join(dir, 'a'), b = path.join(dir, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'race', cwd: a }) + '\n{"type":"message"}\n');
  const { prepareSessionHeader, commitSessionHeaders } = await import('../assets/piweb-overlay/portable-project-store.mjs');
  const item = prepareSessionHeader(file, 'race', b, root2);
  fs.appendFileSync(file, '{"type":"message","late":true}\n');
  await assert.rejects(commitSessionHeaders([item], null), /其他进程修改/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).cwd, a);
});
test('full family validates before writing any header', async () => {
  const a = fixture('family-a'), b = fixture('family-b'), before = fs.readFileSync(a);
  await assert.rejects(async () => relocateSessionHeaders([{ id: 'family-a', path: a }, { id: 'wrong', path: b }], target, sessions), /身份/);
  assert.ok(fs.readFileSync(a).equals(before));
  await relocateSessionHeaders([{ id: 'family-a', path: a }, { id: 'family-b', path: b }], target, sessions);
  for (const p of [a,b]) assert.equal(JSON.parse(fs.readFileSync(p,'utf8').split('\n')[0]).cwd, target);
});
test('rejects out-of-root sessions and missing destinations without mutation', async () => {
  const file = fixture('outside'), before = fs.readFileSync(file);
  await assert.rejects(async () => relocateSessionHeader(file, 'outside', target, source), /受管目录/);
  await assert.rejects(async () => relocateSessionHeader(file, 'outside', path.join(root,'absent'), sessions));
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
