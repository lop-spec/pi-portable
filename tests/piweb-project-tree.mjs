import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProject, ensureInbox, moveProjectSessions, sessionIndex, sessionAssignments, projectTag, validProjectName, renameManagedProject, renameSessionTitle, indexedSessionPath } from '../assets/piweb-overlay/project-routing.mjs';
import { SessionArchiveStore } from '../src/piweb-ui-proxy.mjs';
import { atomicWrite, isManagedSessionPath } from '../assets/piweb-overlay/portable-project-store.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-routing-')), agentDir = path.join(root, 'agent'), baseRoot = path.join(root, 'projects'), inbox = path.join(root, 'inbox');
fs.mkdirSync(path.join(agentDir, 'sessions', 'legacy'), { recursive: true });
atomicWrite(path.join(agentDir, 'web-projects.json'), JSON.stringify({ version: 1, projects: [], hidden: [], baseRoot, inbox }));
const history = Buffer.from('{"type":"message","id":"user","message":{"role":"user","content":"历史和图片"}}\r\n{"type":"message","id":"reply","parentId":"user","message":{"role":"assistant","content":[{"type":"image","data":"AA=="}]}}\r\n');
const fixture = id => { const file = path.join(agentDir, 'sessions', 'legacy', '2026_' + id + '.jsonl'); fs.writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify({ type: 'session', version: 3, id, cwd: root }) + '\r\n'), history])); return { id, path: file, cwd: root }; };
test('project names are concrete, one level, canonical and case-insensitive', () => {
  assert.equal(validProjectName(' windows '), 'Windows');
  for (const name of ['', '../escape', 'a/b', 'a\\b', '其他', '综合工作台', 'con', 'foo.', 'bad\0x']) assert.throws(() => validProjectName(name));
});
test('inbox is not registered as a project and SDK discovery uses one index level', () => {
  assert.equal(ensureInbox(agentDir), inbox);
  assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'web-projects.json'))).projects.length, 0);
  assert.equal(fs.realpathSync(sessionIndex(agentDir, inbox)), path.join(inbox, '会话'));
});
test('create reuses an exact canonical name, never creates duplicate Windows/windows', () => {
  const a = createProject(agentDir, 'windows'), b = createProject(agentDir, 'Windows');
  assert.equal(a.cwd, b.cwd); assert.equal(b.projects.length, 1);
});
test('physically moves full transcript into project/会话/file, preserving ID, body bytes and timestamps', async () => {
  const s = fixture('move'), mtime = fs.statSync(s.path).mtimeMs;
  const result = await moveProjectSessions({ agentDir, sessions: [s], name: 'Android' });
  assert.equal(fs.existsSync(s.path), false);
  const file = result.info.path, bytes = fs.readFileSync(file), end = bytes.indexOf(10);
  assert.equal(file, path.join(baseRoot, 'Android', '会话', '2026_move.jsonl'));
  assert.equal(path.relative(baseRoot, file).split(path.sep).length, 3);
  assert.equal(JSON.parse(bytes.subarray(0, end)).id, s.id);
  assert.equal(JSON.parse(bytes.subarray(0, end)).cwd, result.cwd);
  assert.ok(bytes.subarray(end + 1).equals(history));
  assert.ok(Math.abs(fs.statSync(file).mtimeMs - mtime) < 2);
  assert.ok(isManagedSessionPath(file, path.join(agentDir, 'sessions')));
  assert.equal(fs.realpathSync(path.join(sessionIndex(agentDir, result.cwd), path.basename(file))), file);
  assert.equal(sessionAssignments(agentDir)[s.id].path, file);
  assert.equal((await moveProjectSessions({ agentDir, sessions: [result.info], name: 'Android' })).changed, false);
});
test('moves associated families together and preserves automation execution cwd', async () => {
  const a = fixture('automation'), b = fixture('child');
  const result = await moveProjectSessions({ agentDir, sessions: [a, b], name: '数据运维', preserveCwd: true });
  for (const id of ['automation', 'child']) {
    const assigned = sessionAssignments(agentDir)[id];
    assert.equal(JSON.parse(fs.readFileSync(assigned.path, 'utf8').split('\n')[0]).cwd, root);
    assert.equal(assigned.root, result.cwd);
  }
});
test('rejects foreign sessions and destination collisions before moving any source', async () => {
  const outsider = path.join(root, 'outside.jsonl'); fs.writeFileSync(outsider, '{}\n');
  await assert.rejects(moveProjectSessions({ agentDir, sessions: [{ id: 'foreign', path: outsider }], name: 'Android' }), /受管/);
  const a = fixture('collision'), b = fixture('collision-child'), dest = createProject(agentDir, '图文生成');
  fs.writeFileSync(path.join(dest.cwd, '会话', path.basename(b.path)), 'do not replace');
  await assert.rejects(moveProjectSessions({ agentDir, sessions: [a, b], name: '图文生成' }), /拒绝覆盖/);
  assert.ok(fs.existsSync(a.path)); assert.ok(fs.existsSync(b.path));
});
test('only final assistant text may supply a tag; no tool iterations or user text can route', () => {
  const content = [{ type: 'text', text: '正常回复\n<归属 项目="Windows">修复耳机音频切换</归属>' }];
  assert.deepEqual(projectTag({ role: 'assistant', stopReason: 'stop', content }), { project: 'Windows', title: '修复耳机音频切换' });
  for (const message of [{ role: 'user', content }, { role: 'assistant', stopReason: 'toolUse', content }, { role: 'assistant', content: [...content, { type: 'toolCall' }] }, { role: 'assistant', content: [{ type: 'text', text: '<归属 项目="Windows">修复耳机音频切换</归属>解释' }] }]) assert.equal(projectTag(message), null);
});
test('one operation also assigns a native title without changing any historical entry', async () => {
  const s = fixture('title');
  const result = await moveProjectSessions({ agentDir, sessions: [s], name: 'Pi规则与扩展', title: '首轮自动整理项目和标题' });
  const bytes = fs.readFileSync(result.info.path), body = bytes.subarray(bytes.indexOf(10) + 1);
  assert.ok(body.subarray(0, history.length).equals(history));
  const last = JSON.parse(body.toString().trim().split('\n').at(-1));
  assert.equal(last.type, 'session_info'); assert.equal(last.parentId, 'reply'); assert.equal(last.name, '首轮自动整理项目和标题');
  const size = bytes.length; renameSessionTitle(result.info.path, '首轮自动整理项目和标题'); assert.equal(fs.statSync(result.info.path).size, size);
});
test('a physically moved archived conversation remains archived and physical paths are accepted through the managed index', async () => {
  const s = fixture('archived'), archiveFile = path.join(agentDir, 'session-archive.json');
  new SessionArchiveStore(archiveFile).archiveMany([s]);
  const result = await moveProjectSessions({ agentDir, sessions: [s], name: '视频画质增强' });
  const store = new SessionArchiveStore(archiveFile);
  assert.equal(store.partition([{ ...result.info, path: indexedSessionPath(agentDir, result.info.path) }]).archived.length, 1);
  assert.equal(store.archiveMany([result.info]).created, false);
  assert.equal(store.restore(s.id).restored, true);
});
test('managed rename moves real files, rewrites cwd and preserves SDK index and assignment', async () => {
  const s = fixture('rename'), moved = await moveProjectSessions({ agentDir, sessions: [s], name: '临时测名' });
  const renamed = await renameManagedProject({ agentDir, root: moved.cwd, name: '正式项目', sessions: [moved.info] });
  const file = path.join(renamed.cwd, '会话', path.basename(s.path));
  assert.ok(fs.existsSync(file)); assert.equal(fs.existsSync(moved.cwd), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).cwd, renamed.cwd);
  assert.equal(sessionAssignments(agentDir)[s.id].root, renamed.cwd);
  assert.equal(fs.realpathSync(sessionIndex(agentDir, renamed.cwd)), path.join(renamed.cwd, '会话'));
});
const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repo, 'upstream/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
test('real Pi emits exactly one assistant reply, strips routing metadata, and launches one hidden post-reply CLI with project and title', { skip: !fs.existsSync(cli) }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hook-')), agent = path.join(work, 'data/.pi/agent'), tools = path.join(work, 'tools'), record = path.join(work, 'called.json');
  fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'pi-project.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));`);
  const result = spawnSync(process.execPath, [cli, '--mode', 'json', '--no-extensions', '-e', path.join(repo, 'tests/project-routing-provider.ts'), '-e', path.join(repo, 'src/extensions/pi-project-router/index.ts'), '--session-dir', path.join(work, 'sessions'), '--model', 'project-fixture/scripted', '--no-tools', '测试'], {
    cwd: work, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_PORTABLE_HOME: work, HOME: work, USERPROFILE: work, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const file = fs.readdirSync(path.join(work, 'sessions')).find(f => f.endsWith('.jsonl'));
  const entries = fs.readFileSync(path.join(work, 'sessions', file), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const replies = entries.filter(e => e.type === 'message' && e.message.role === 'assistant');
  assert.equal(replies.length, 1); assert.equal(replies[0].message.content.find(b => b.type === 'text').text, '完成。');
  for (let i = 0; !fs.existsSync(record) && i < 50; i++) await new Promise(r => setTimeout(r, 100));
  const args = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(args[0], 'move'); assert.equal(args[args.indexOf('--project') + 1], 'Windows'); assert.equal(args[args.indexOf('--title') + 1], '修复音频设备切换'); assert.ok(args.includes('--defer'));
});
test('runtime routing never prompts or starts another agent and all UI creation/move share the same core', () => {
  const route = fs.readFileSync(new URL('../assets/piweb-overlay/project-routing-route.ts', import.meta.url), 'utf8');
  const extension = fs.readFileSync(new URL('../src/extensions/pi-project-router/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(route + extension, /sendUserMessage|sendMessage\(|startRpcSession|type: ['"]prompt/);
  assert.match(route, /isBusyForProjectMove/); assert.match(route, /withSessionMoveLock/);
  assert.match(extension, /pi\.on\('agent_end'/); assert.match(extension, /windowsHide: true, detached: true, shell: false/);
});
