import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isAutomationCwd, archiveAutomationResult } from '../tools/pi-task-results.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
test('only automation execution directories are classified as scheduled output', () => {
  for (const cwd of ['C:\\Users\\lop\\.pi\\agent\\automations\\daily', 'D:/Downloads/pi-protable/data/.pi/agent/automations/daily']) assert.equal(isAutomationCwd(cwd), true);
  for (const cwd of ['C:/Users/lop/Documents/Pi项目/数据运维', '/work/automations/manual', '/work/.pi/agent/automations-extra']) assert.equal(isAutomationCwd(cwd), false);
});
test('a completed task is archived only after its running guard clears; all history is preserved', async () => {
  const calls = []; let mutations = 0;
  const fetchImpl = async (url, init) => { calls.push([url, init]); if (url.includes('?force=')) return Response.json({ sessions: [{ id: 'task-1', cwd: 'D:/data/.pi/agent/automations/daily' }] }); mutations++; return mutations === 1 ? Response.json({ error: 'Session is running' }, { status: 409 }) : Response.json({ ok: true, archived: true, preserved: true, sessionIds: ['task-1'] }); };
  const result = await archiveAutomationResult({ id: 'task-1', defer: true, attempts: 2, fetchImpl, sleep: async () => {}, agentDir: null });
  assert.equal(result.preserved, true); assert.equal(calls.length, 3); assert.equal(calls[1][1].method, 'POST');
});
test('normal user conversations cannot be auto-archived, and permission failures are not retried', async () => {
  let calls = 0;
  await assert.rejects(archiveAutomationResult({ id: 'manual', defer: true, fetchImpl: async () => { calls++; return Response.json({ sessions: [{ id: 'manual', cwd: repo }] }); } }), /non-automation/);
  assert.equal(calls, 1);
  await assert.rejects(archiveAutomationResult({ id: 'task-1', defer: true, fetchImpl: async url => url.includes('?force=') ? Response.json({ sessions: [{ id: 'task-1', cwd: 'D:/.pi/agent/automations/job' }] }) : Response.json({ error: 'denied' }, { status: 403 }) }), /denied/);
});
test('bulk project routing cannot re-import archived task output', async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-marker-'));
  fs.mkdirSync(path.join(agentDir, 'automation-results'));
  fs.writeFileSync(path.join(agentDir, 'automation-results/task-guard.json'), JSON.stringify({ archived: true }));
  const { run } = await import('../tools/pi-project.mjs');
  await assert.rejects(run(['move', '--session', 'task-guard', '--project', 'Windows', '--agent-dir', agentDir]), /不参与项目归属/);
});
const webPackage = process.env.PI_PORTABLE_HOME && path.join(process.env.PI_PORTABLE_HOME, 'app/node_modules/@agegr/pi-web');
const cli = process.env.PI_TEST_CLI || (webPackage && fs.existsSync(webPackage) ? path.resolve(fs.realpathSync(webPackage), '../../@earendil-works/pi-coding-agent/dist/cli.js') : path.join(repo, 'upstream/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'));
const router = process.env.PI_TEST_ROUTER || path.join(repo, 'src/extensions/pi-project-router/index.ts');
for (const automation of [false, true]) test(`real Pi extension: ${automation ? 'scheduled output archives without project assignment' : 'normal conversation still routes to a project'}`, { skip: !fs.existsSync(cli) }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-routing-')), agent = path.join(root, 'data/.pi/agent'), tools = path.join(root, 'tools'), sessions = path.join(root, 'sessions'), receipt = path.join(root, 'worker.json'), cwd = automation ? path.join(agent, 'automations/test-job') : path.join(root, 'manual');
  fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(tools); fs.mkdirSync(cwd, { recursive: true });
  for (const worker of ['pi-project.mjs', 'pi-task-results.mjs']) fs.writeFileSync(path.join(tools, worker), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({worker:${JSON.stringify(worker)},args:process.argv.slice(2)}));`);
  const result = spawnSync(process.execPath, [cli, '--mode', 'json', '--no-extensions', '-e', path.join(repo, 'tests/project-routing-provider.ts'), '-e', router, '--session-dir', sessions, '--model', 'project-fixture/scripted', '--no-tools', 'offline routing acceptance'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_PORTABLE_HOME: root, HOME: root, USERPROFILE: root, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr);
  for (let i = 0; !fs.existsSync(receipt) && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const worker = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(worker.worker, automation ? 'pi-task-results.mjs' : 'pi-project.mjs');
  assert.equal(worker.args[0], automation ? 'archive' : 'move'); assert.ok(worker.args.includes('--defer'));
  if (automation) assert.ok(!worker.args.includes('--project'));
  const transcript = fs.readFileSync(path.join(sessions, fs.readdirSync(sessions).find(name => name.endsWith('.jsonl'))), 'utf8');
  const replies = transcript.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.message.role === 'assistant');
  assert.equal(replies.length, 1); assert.equal(replies[0].message.content.find(block => block.type === 'text').text, '完成。');
});
