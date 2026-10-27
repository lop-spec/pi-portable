import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectKey, ProjectStore, atomicWrite } from '../assets/piweb-overlay/portable-project-store.mjs';
import { createProject, moveProjectSessions, sessionAssignments, sessionMonth } from '../assets/piweb-overlay/project-routing.mjs';
import { projectCounts, verifyProjectBalance, previewProjectPlan, validateProjectPlan, balanceProjects } from '../tools/project-balance.mjs';

const project = name => ({ name, root: path.resolve(os.tmpdir(), 'balance-fixture', name), key: projectKey(path.resolve(os.tmpdir(), 'balance-fixture', name)) });
const row = (id, p, name = '分表加索引执行变慢') => ({ id, cwd: p.root, projectRoot: p.root, projectKey: p.key, name });
const rows = (prefix, p, count) => Array.from({ length: count }, (_, i) => row(prefix + i, p));
const ids = (prefix, count) => Array.from({ length: count }, (_, i) => prefix + i);
function fixture(projects, conversations, archived = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-project-plan-')), registry = { managed: true, projects: [...projects], hidden: [] }, mutations = [];
  const request = async (url, body) => {
    if (!body) return structuredClone(url.startsWith('/api/sessions') ? { sessions: conversations, runningSessionIds: [] } : registry);
    mutations.push(body);
    if (url === '/api/projects') { const p = registry.projects.find(p => p.root === body.cwd), next = project(body.name); for (const s of conversations) if (s.projectRoot === p.root) Object.assign(s, { projectRoot: next.root, projectKey: next.key }); Object.assign(p, next); return {}; }
    assert.equal(body.action, 'move');
    let destination = registry.projects.find(p => p.name === body.project); if (!destination) { destination = project(body.project); registry.projects.push(destination); }
    Object.assign(conversations.find(s => s.id === body.id), { projectRoot: destination.root, projectKey: destination.key }); return {};
  };
  const options = { agentDir: root, request, loadArchive: () => archived, forgetEmpty: async p => { registry.projects = registry.projects.filter(x => x.key !== p.key); } };
  return { root, registry, rows: conversations, mutations, options };
}

test('counts only visible main conversations, excluding archives, children and automation', () => {
  const p = project('Pi工作台'), conversations = [row('live', p), row('old', p), { ...row('child', p), relation: { kind: 'subagent', parentSessionId: 'live' } }, { ...row('task', p), cwd: 'C:/.pi/agent/automations/task' }];
  assert.equal(projectCounts({ projects: [p] }, conversations, { old: {} })[0].count, 1);
});
test('every project is 5–10, with at most eight but no fixed project count', () => {
  const projects = Array.from({ length: 9 }, (_, i) => project('主题' + i));
  for (let n = 1; n <= 8; n++) {
    const conversations = projects.slice(0, n).flatMap((p, i) => rows('s' + i + '-', p, i % 2 ? 10 : 5));
    assert.equal(verifyProjectBalance({ projects: projects.slice(0, n), hidden: [] }, conversations).ok, true);
  }
  const bad = [...rows('a', projects[0], 4), ...rows('b', projects[1], 11)];
  const result = verifyProjectBalance({ projects: projects.slice(0, 2), hidden: [] }, bad);
  assert.equal(result.ok, false); assert.match(result.errors.join(' '), /不足5/); assert.match(result.errors.join(' '), /超过10/);
  assert.equal(verifyProjectBalance({ projects, hidden: [] }, projects.flatMap((p, i) => rows('c' + i + '-', p, 5))).ok, false);
});
test('invalid or omitted plans cause no classification, moves or empty-project cleanup', async () => {
  const a = project('数据运维'), empty = project('空项目'), f = fixture([a, empty], rows('a', a, 11));
  await assert.rejects(balanceProjects(f.options), /未执行.*脚本不推测分类/);
  assert.deepEqual(f.mutations, []); assert.equal(f.registry.projects.length, 2);
  await assert.rejects(balanceProjects({ ...f.options, plan: { splits: [{ from: a.name, project: 'MySQL', ids: ['a0'] }] } }), /未满足数量要求/);
  assert.deepEqual(f.mutations, []);
});
test('one supplied plan merges small projects and splits oversized ones without guessing names or IDs', async () => {
  const a = project('数据运维'), b = project('Pi工作台'), c = project('Windows'), d = project('浏览器'), e = project('生活');
  const f = fixture([a, b, c, d, e], [...rows('a', a, 14), ...rows('b', b, 13), ...rows('c', c, 3), ...rows('d', d, 3), ...rows('e', e, 2)]);
  const plan = { merges: [{ from: [d.name, e.name], project: c.name }], splits: [{ from: b.name, project: '模型接入', ids: ids('b', 7) }, { from: a.name, project: 'MySQL', ids: ids('a', 7) }] };
  const result = await balanceProjects({ ...f.options, plan });
  assert.equal(result.ok, true); assert.equal(result.projects.length, 5); assert.deepEqual(result.projects.map(p => p.count).sort((x, y) => x - y), [6, 7, 7, 7, 8]);
  assert.deepEqual(result.operations.filter(o => o.action === 'split').map(o => o.before), [13, 14]);
  assert.deepEqual(f.mutations.filter(m => m.project === 'MySQL').map(m => m.id), ids('a', 7));
  const n = f.mutations.length; await balanceProjects({ ...f.options, plan }); assert.equal(f.mutations.length, n);
});
test('physical split preserves all session IDs, history, month paths and child sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-real-moves-')), agent = path.join(root, 'agent'), baseRoot = path.join(root, 'projects');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  atomicWrite(path.join(agent, 'web-projects.json'), JSON.stringify({ version: 1, managed: true, projects: [], hidden: [], baseRoot, inbox: path.join(root, 'inbox') }));
  createProject(agent, 'Pi工作台'); createProject(agent, 'Windows');
  const store = new ProjectStore(path.join(agent, 'web-projects.json')), projects = store.read().projects, a = projects.find(p => p.name === 'Pi工作台'), b = projects.find(p => p.name === 'Windows'), month = sessionMonth(), body = '{"type":"message","id":"message","message":{"role":"user","content":"内容与图片保留"}}\n';
  const make = (id, p, relation) => {
    const file = path.join(p.root, month, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd: p.root, timestamp: new Date().toISOString() }) + '\n' + body);
    return { id, path: file, cwd: p.root, projectRoot: p.root, projectKey: p.key, ...(relation ? { relation } : {}) };
  };
  const conversations = [...Array.from({ length: 12 }, (_, i) => make('a' + i, a)), ...Array.from({ length: 4 }, (_, i) => make('b' + i, b)), make('child', a, { kind: 'subagent', parentSessionId: 'a0' })];
  const request = async (url, command) => {
    if (!command) return structuredClone(url.startsWith('/api/sessions') ? { sessions: conversations } : store.read());
    assert.equal(command.action, 'move');
    const parent = conversations.find(s => s.id === command.id), family = [parent, ...conversations.filter(s => s.relation?.parentSessionId === command.id)];
    await moveProjectSessions({ agentDir: agent, sessions: family, name: command.project, preserveCwd: command.preserveCwd });
    const assigned = sessionAssignments(agent);
    for (const s of family) Object.assign(s, { path: assigned[s.id].path, projectRoot: assigned[s.id].root, projectKey: projectKey(assigned[s.id].root) });
    return {};
  };
  const result = await balanceProjects({ agentDir: agent, request, plan: { splits: [{ from: a.name, project: b.name, ids: ids('a', 6) }] } });
  assert.equal(result.ok, true); assert.deepEqual(result.projects.map(p => p.count).sort((x, y) => x - y), [6, 10]);
  for (const id of [...ids('a', 6), 'child']) {
    const s = conversations.find(r => r.id === id), text = fs.readFileSync(s.path, 'utf8');
    assert.equal(s.projectRoot, b.root); assert.equal(path.basename(path.dirname(s.path)), month); assert.equal(JSON.parse(text.split('\n')[0]).id, id); assert.equal(text.slice(text.indexOf('\n') + 1), body);
  }
});
test('preview includes the incoming session and reserves one oldest-reply archive at capacity', () => {
  const projects = Array.from({ length: 8 }, (_, i) => project('主题' + i)), inbox = project('收件');
  const conversations = [...projects.flatMap((p, i) => rows('s' + i + '-', p, 10)), row('incoming', inbox)];
  const preview = previewProjectPlan({ registry: { projects, hidden: [] }, sessions: conversations, incoming: { id: 'incoming', project: projects[0].name } });
  assert.equal(preview.ok, true); assert.equal(preview.needsArchive, true); assert.equal(preview.projects[0].count, 10); assert.equal(conversations.at(-1).projectRoot, inbox.root);
  assert.throws(() => previewProjectPlan({ registry: { projects, hidden: [] }, sessions: conversations, incoming: { id: 'incoming', project: '新分类' } }), /已满8个/);
});
test('fewer than five stay unassigned; one plan can classify four waiting sessions plus the current one', () => {
  const inbox = project('收件'), conversations = rows('wait', inbox, 4).concat(row('incoming', inbox));
  const plan = { moves: [{ project: 'Pi工作台', ids: ids('wait', 4) }] }, registry = { projects: [], hidden: [] };
  const preview = previewProjectPlan({ registry, sessions: conversations, plan, incoming: { id: 'incoming', project: 'Pi工作台' } });
  assert.equal(preview.ok, true); assert.deepEqual(preview.projects, [{ name: 'Pi工作台', count: 5 }]);
  const short = previewProjectPlan({ registry, sessions: conversations, plan: { moves: [{ project: 'Pi工作台', ids: ids('wait', 3) }] }, incoming: { id: 'incoming', project: 'Pi工作台' } });
  assert.equal(short.ok, false); assert.equal(conversations.every(s => s.projectRoot === inbox.root), true);
});
test('archive-only category is merged only into the model-named target, preserving archived state', async () => {
  const a = project('旧项目'), b = project('数据运维'), archive = { old: { archivedAt: '2026-10-01' } }, f = fixture([a, b], [row('old', a), ...rows('live', b, 5)], archive);
  const result = await balanceProjects({ ...f.options, plan: { merges: [{ from: [a.name], project: b.name }] } });
  assert.equal(result.ok, true); assert.equal(f.registry.projects.length, 1); assert.equal(archive.old.archivedAt, '2026-10-01'); assert.deepEqual(f.mutations.map(m => m.project), [b.name]);
});
test('plans require explicit names and IDs, with no automatic classifier', () => {
  assert.throws(() => validateProjectPlan({ autoClassify: true }), /未知整理参数/);
  assert.throws(() => validateProjectPlan({ splits: [{ from: '数据运维', project: 'MySQL' }] }), /指定会话ID/);
});
test('retry after a partially applied split moves only the remaining specified IDs', async () => {
  const a = project('数据运维'), b = project('MySQL'), all = [...rows('a', a, 8), ...rows('m', b, 2)], f = fixture([a, b], all);
  const plan = { splits: [{ from: a.name, project: b.name, ids: ['m0', 'm1', 'a0', 'a1', 'a2'] }] };
  const result = await balanceProjects({ ...f.options, plan });
  assert.equal(result.ok, true); assert.deepEqual(f.mutations.map(m => m.id), ['a0', 'a1', 'a2']);
});
test('running-conversation failure releases the lock', async () => {
  const p = project('数据运维'), f = fixture([p], rows('a', p, 10)), original = f.options.request;
  f.options.request = async (url, body) => { if (body) throw new Error('对话正在运行'); return original(url, body); };
  await assert.rejects(balanceProjects({ ...f.options, plan: { splits: [{ from: p.name, project: 'MySQL', ids: ids('a', 5) }] } }), /正在运行/);
  assert.equal(fs.existsSync(path.join(f.root, 'project-balance.lock')), false);
});
test('normal one-call CLI verifies counts and does not return conversation contents', async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-cli-')), p = project('主题'), inbox = project('收件'), conversations = [...rows('s', p, 5), row('incoming', inbox)], registry = { managed: true, projects: [p], hidden: [] }, saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    if (url.includes('/api/sessions')) return Response.json({ sessions: conversations });
    if (body?.action === 'move') { Object.assign(conversations.at(-1), { projectRoot: p.root, projectKey: p.key }); return Response.json({ ...registry, info: { ...conversations.at(-1), firstMessage: 'private raw text', messages: ['private history'] } }); }
    return Response.json({ ...registry, verification: { ok: true, errors: [] } });
  };
  try { const { run } = await import('../tools/pi-project.mjs'); const result = await run(['move', '--session', 'incoming', '--project', p.name, '--agent-dir', agent]); assert.equal(result.balance.ok, true); assert.equal(result.balance.projects[0].count, 6); assert.doesNotMatch(JSON.stringify(result), /private raw text|private history|firstMessage/); }
  finally { globalThis.fetch = saved; }
});
test('the 81st session archives exactly the oldest reply in its target before moving', async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-full-')), projects = Array.from({ length: 8 }, (_, i) => project('主题' + i)), inbox = project('收件');
  const conversations = [...projects.flatMap((p, i) => rows('s' + i + '-', p, 10)), row('incoming', inbox)], registry = { managed: true, projects, hidden: [] }, saved = globalThis.fetch, calls = [];
  for (let i = 0; i < 10; i++) {
    const s = conversations[i], timestamp = new Date(Date.UTC(2026, 9, i + 1)).toISOString(); s.path = path.join(agent, s.id + '.jsonl');
    fs.writeFileSync(s.path, JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', content: '回复' } }) + '\n');
  }
  const archive = path.join(agent, 'session-archive.json');
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    if (url.includes('/archive')) { const id = decodeURIComponent(url.split('/').at(-2)); calls.push(['archive', id]); fs.writeFileSync(archive, JSON.stringify({ sessions: { [id]: {} } })); return Response.json({ ok: true, archived: true }); }
    if (url.includes('/api/sessions')) return Response.json({ sessions: conversations });
    if (body?.action === 'move') { calls.push(['move', body.id]); Object.assign(conversations.at(-1), { projectRoot: projects[0].root, projectKey: projects[0].key }); return Response.json({ ...registry }); }
    return Response.json({ ...registry, verification: { ok: true, errors: [] } });
  };
  try { const { run } = await import('../tools/pi-project.mjs'); const result = await run(['move', '--session', 'incoming', '--project', projects[0].name, '--agent-dir', agent]); assert.deepEqual(calls, [['archive', 's0-0'], ['move', 'incoming']]); assert.equal(result.archivedOldest.id, 's0-0'); assert.equal(result.balance.ok, true); assert.equal(result.balance.projects[0].count, 10); }
  finally { globalThis.fetch = saved; }
});
test('an earlier archived member of an already-applied plan is an idempotent no-op', async () => {
  const a = project('数据运维'), b = project('MySQL'), archived = { old: { archivedAt: '2026-10-01' } }, f = fixture([a, b], [...rows('a', a, 5), ...rows('b', b, 5), row('old', b)], archived);
  const plan = { splits: [{ from: a.name, project: b.name, ids: ['old'] }] };
  const result = await balanceProjects({ ...f.options, plan }); assert.equal(result.ok, true); assert.deepEqual(f.mutations, []);
});
test('a running oldest conversation is not archived or replaced by a newer one', async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-busy-')), p = project('主题'), inbox = project('收件'), conversations = [...rows('s', p, 10), row('incoming', inbox)], registry = { managed: true, projects: [p], hidden: [] }, saved = globalThis.fetch, calls = [];
  for (let i = 0; i < 10; i++) { const s = conversations[i]; s.path = path.join(agent, s.id + '.jsonl'); fs.writeFileSync(s.path, JSON.stringify({ type: 'message', timestamp: new Date(Date.UTC(2026, 9, i + 1)).toISOString(), message: { role: 'assistant', content: 'x' } }) + '\n'); }
  globalThis.fetch = async (url, options) => { const body = options?.body ? JSON.parse(options.body) : undefined; if (url.includes('/archive')) { calls.push(decodeURIComponent(url.split('/').at(-2))); return Response.json({ error: 'Session is running' }, { status: 409 }); } if (body?.action === 'move') calls.push('move'); return Response.json(url.includes('/api/sessions') ? { sessions: conversations } : registry); };
  try { const { run } = await import('../tools/pi-project.mjs'); await assert.rejects(run(['move', '--session', 'incoming', '--project', p.name, '--agent-dir', agent]), /running/); assert.deepEqual(calls, ['s0']); assert.equal(fs.existsSync(path.join(agent, 'session-archive.json')), false); }
  finally { globalThis.fetch = saved; }
});
test('parallel incoming conversations serialize preview, oldest-reply archive and move', async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-concurrent-')), p = project('主题'), inbox = project('收件'), registry = { managed: true, projects: [p], hidden: [] };
  const conversations = [...rows('s', p, 9), row('incoming1', inbox), row('incoming2', inbox)], saved = globalThis.fetch, writes = [];
  for (let i = 0; i < conversations.length; i++) { const s = conversations[i]; s.path = path.join(agent, s.id + '.jsonl'); fs.writeFileSync(s.path, JSON.stringify({ type: 'message', timestamp: new Date(Date.UTC(2026, 9, i + 1)).toISOString(), message: { role: 'assistant', content: 'x' } }) + '\n'); }
  const archive = path.join(agent, 'session-archive.json');
  globalThis.fetch = async (url, options) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const body = options?.body ? JSON.parse(options.body) : undefined;
    if (url.includes('/archive')) { const id = decodeURIComponent(url.split('/').at(-2)); writes.push(['archive', id]); fs.writeFileSync(archive, JSON.stringify({ sessions: { [id]: {} } })); return Response.json({ ok: true, archived: true }); }
    if (url.includes('/api/sessions')) return Response.json({ sessions: conversations });
    if (body?.action === 'move') { writes.push(['move', body.id]); Object.assign(conversations.find(s => s.id === body.id), { projectRoot: p.root, projectKey: p.key }); return Response.json({ ...registry }); }
    return Response.json({ ...registry, verification: { ok: true, errors: [] } });
  };
  try {
    const { run } = await import('../tools/pi-project.mjs');
    const results = await Promise.all(['incoming1', 'incoming2'].map(id => run(['move', '--defer', '--session', id, '--project', p.name, '--agent-dir', agent])));
    assert.equal(results.every(r => r.balance.ok), true); assert.equal(writes.filter(x => x[0] === 'archive').length, 1); assert.deepEqual(writes.find(x => x[0] === 'archive'), ['archive', 's0']);
    assert.deepEqual(writes.map(x => x[0]), ['move', 'archive', 'move']); assert.equal(fs.existsSync(path.join(agent, 'project-balance.lock')), false);
  } finally { globalThis.fetch = saved; }
});
const repo = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = process.env.PI_PORTABLE_HOME ? fs.realpathSync(path.join(process.env.PI_PORTABLE_HOME, 'app/node_modules/@agegr/pi-web')) : '';
const piCli = packageRoot ? path.resolve(packageRoot, '../../@earendil-works/pi-coding-agent/dist/cli.js') : '';
test('real Pi captures one model reply and calls one worker with the supplied plan', { skip: !piCli || !fs.existsSync(piCli) }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-plan-hook-')), agent = path.join(root, 'data/.pi/agent'), tools = path.join(root, 'tools'), sessions = path.join(root, 'sessions'), receipt = path.join(root, 'worker.json');
  fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'pi-project.mjs'), `import fs from 'node:fs';const args=process.argv.slice(2),index=args.indexOf('--plan-file');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,plan:JSON.parse(fs.readFileSync(args[index+1],'utf8'))}));`);
  const plan = { splits: [{ from: '数据运维', project: 'MySQL', ids: ['model-selected-id'] }] };
  const result = spawnSync(process.execPath, [piCli, '--mode', 'json', '--no-extensions', '-e', path.join(repo, 'tests/project-routing-provider.ts'), '-e', process.env.PI_TEST_ROUTER || path.join(repo, 'src/extensions/pi-project-router/index.ts'), '--session-dir', sessions, '--model', 'project-fixture/scripted', '--no-tools', 'offline parameter capture'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_PORTABLE_HOME: root, HOME: root, USERPROFILE: root, PI_FIXTURE_PROJECT_PLAN: JSON.stringify(plan), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr); for (let i = 0; !fs.existsSync(receipt) && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const recorded = JSON.parse(fs.readFileSync(receipt)); assert.deepEqual(recorded.plan, plan); assert.equal(recorded.args[0], 'move');
  const entries = fs.readFileSync(path.join(sessions, fs.readdirSync(sessions).find(f => f.endsWith('.jsonl'))), 'utf8').trim().split('\n').map(line => JSON.parse(line)), replies = entries.filter(e => e.type === 'message' && e.message.role === 'assistant');
  assert.equal(replies.length, 1); assert.equal(replies[0].message.content.find(b => b.type === 'text').text, '完成。');
});
test('installed extension injects boundary counts and waiting-session candidates in the original request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-inject-')), agent = path.join(root, 'data/.pi/agent'), inbox = project('收件'), p = project('Windows');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'web-projects.json'), JSON.stringify({ managed: true, projects: [p], hidden: [], inbox: inbox.root }));
  const callbacks = {}, previousAgent = process.env.PI_CODING_AGENT_DIR, previousHome = process.env.PI_PORTABLE_HOME, saved = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PORTABLE_HOME = root;
  const conversations = [...rows('w', p, 10), row('waiting', inbox), row('current', inbox)];
  globalThis.fetch = async () => Response.json({ sessions: conversations, runningSessionIds: ['w0'] });
  try {
    const configured = process.env.PI_TEST_ROUTER || (previousAgent && path.join(previousAgent, 'extensions/pi-project-router/index.ts'));
    const installed = configured && fs.existsSync(configured) ? configured : path.join(repo, 'src/extensions/pi-project-router/index.ts');
    const router = await import(pathToFileURL(installed).href + '?injection-test');
    router.default({ on: (name, callback) => { callbacks[name] = callback; } });
    const event = { systemPromptOptions: { sections: {} } }, ctx = { cwd: inbox.root, sessionManager: { getSessionId: () => 'current', getSessionFile: () => path.join(inbox.root, 'current.jsonl') } };
    await callbacks.before_agent_start(event, ctx);
    const data = JSON.parse(event.systemPromptOptions.sections.pi_projects);
    assert.equal(data.requiresPlan, true); assert.equal(data.maxProjects, 8); assert.equal(data.minConversations, 5); assert.equal(data.maxConversations, 10);
    assert.equal(data.classificationCandidates.find(s => s.id === 'waiting').project, '未归属'); assert.equal(data.classificationCandidates.find(s => s.id === 'w0').running, true);
    assert.equal(data.classificationCandidates.some(s => s.id === 'current'), false); assert.ok(data.planSchema.moves);
    conversations.splice(5, 5); conversations.splice(conversations.findIndex(s => s.id === 'waiting'), 1);
    const ordinary = { systemPromptOptions: { sections: {} } }; await callbacks.before_agent_start(ordinary, ctx);
    assert.equal(JSON.parse(ordinary.systemPromptOptions.sections.pi_projects).requiresPlan, false);
  } finally { globalThis.fetch = saved; if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; if (previousHome === undefined) delete process.env.PI_PORTABLE_HOME; else process.env.PI_PORTABLE_HOME = previousHome; }
});
test('no semantic classifier, transcript scanner, extra model call or second worker', () => {
  const source = fs.readFileSync(new URL('../tools/project-balance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /projectScope|firstMessage|sessionSubject|readTopicEvidence|planProjectSplit|engineHits|sendUserMessage|sendMessage\(|type: ['"]prompt/);
  const extension = fs.readFileSync(new URL('../src/extensions/pi-project-router/index.ts', import.meta.url), 'utf8'); assert.equal((extension.match(/spawn\(process\.execPath/g) ?? []).length, 1); assert.match(extension, /p\.count < 5 \|\| p\.count > 10/);
});
