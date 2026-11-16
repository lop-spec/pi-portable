// Cline agent: the source integration lands on every anchor, and the process bridge
// keeps its contract with a Cline-shaped client (tests/fixtures/fake-cline.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { ClineTurn, resolveClineBinary } from '../assets/piweb-overlay/cline-agent/cline-bridge.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.PIWEB_SOURCE ?? path.join(repo, 'upstream');
const available = fs.existsSync(path.join(source, 'package.json'));
const stateFile = path.join(source, '.pi-portable-overlay.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
// An already integrated checkout is read through its backups; files the overlay generated do not exist upstream.
const read = name => {
  const record = state?.files[name];
  if (record && !record.backup) throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
  return fs.readFileSync(record?.backup || path.join(source, name), 'utf8');
};
const count = (text, needle) => text.split(needle).length - 1;
const fake = path.join(repo, 'tests/fixtures/fake-cline.mjs');

function startFake(t, options = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-agent-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return ClineTurn.start({ bin: process.execPath, binArgs: [fake], cwd: os.tmpdir(), homeDir, ...options });
}

test('integration wires the agent into the session, the prompt and the composer', { skip: !available }, () => {
  const files = integrate(read);
  for (const name of ['lib/cline-bridge.ts', 'lib/cline-agent.ts', 'lib/portable-agent-choice.ts', 'components/PortableAgentSwitch.tsx', 'app/api/cline-agent/route.ts']) {
    assert.ok(files.has(name), `${name} is generated`);
  }
  const rpc = files.get('lib/rpc-manager.ts');
  assert.equal(count(rpc, 'createClineAgent(sessionCwd)'), 1);
  assert.match(rpc, /const clineAgent = chatOnly \|\| subagentResources \? undefined : createClineAgent/, 'chat-only and subagent sessions stay Pi-only');
  assert.equal(count(rpc, '...(clineAgent ? [clineAgent.extension] : []),'), 1);
  assert.ok(rpc.indexOf('this.clineAgent?.setAgent(command.agent)') < rpc.indexOf('prompt = this.inner.prompt(command.message as string'), 'the agent is chosen before the run starts');
  assert.match(rpc, /if \(typeof command\.agent === "string"\) this\.clineAgent\?\.setAgent/, 'a prompt that names no agent keeps the current one');
  assert.equal(count(files.get('lib/agent-client.ts'), 'command.type === "prompt" ? { ...command, agent: agentForPrompt(sessionId) } : command'), 1);
  assert.equal(count(files.get('components/ChatInput.tsx'), '<PortableAgentSwitch sessionKey={providedDraftKey} />'), 1);
  assert.equal(count(files.get('app/redesign-chrome.css'), '.pw-agent-switch {'), 1);
});

test('the binary resolves from the pinned install or an explicit path, never from PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-bin-'));
  try {
    assert.equal(resolveClineBinary(dir, {}), undefined);
    assert.equal(resolveClineBinary(dir, { PI_WEB_CLINE_BIN: path.join(dir, 'missing') }), undefined);
    assert.equal(resolveClineBinary(dir, { PI_WEB_CLINE_BIN: process.execPath }), process.execPath);
    const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
    const bin = path.join(dir, 'cli/node_modules/@cline', `cli-${platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'cline.exe' : 'cline');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
    assert.equal(resolveClineBinary(dir, {}), bin);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn relays text, hands over tool calls and returns their results', async t => {
  const turn = await startFake(t);
  assert.equal(turn.system, 'You are Cline (fake).');
  assert.deepEqual(turn.tools.map(tool => tool.name), ['read_files', 'run_commands', 'ask_question', 'team_status']);

  turn.text('先看文件。');
  // Calls started in one tick are one assistant message for Cline.
  const [first, second] = await Promise.all([
    turn.callTool('call_1', 'read_files', { value: '汉字' }),
    turn.callTool('call_2', 'run_commands', { value: 'b' }),
  ]);
  assert.equal(first, 'read_files:{"value":"汉字"}');
  assert.equal(second, 'run_commands:{"value":"b"}');

  // The request that brought the results is already waiting for what comes next.
  await turn.whenOpen(1);
  assert.equal(await turn.callTool('call_3', 'read_files', { value: 'c' }), 'read_files:{"value":"c"}');

  turn.text('完成。');
  turn.finish();
  assert.equal(turn.alive, false);
  await assert.rejects(turn.callTool('call_4', 'read_files', {}), /Cline/);
});

test('aborting a call stops the process, and nothing waits on a stopped one', async t => {
  const turn = await startFake(t);
  const abort = new AbortController();
  const aborted = turn.callTool('call_1', 'read_files', {}, abort.signal);
  const sibling = turn.callTool('call_2', 'read_files', {});
  abort.abort();
  await assert.rejects(aborted, /aborted/);
  await assert.rejects(sibling, /Cline 已停止/);
  assert.equal(turn.alive, false);
  await assert.rejects(turn.whenOpen(1000), /Cline 已停止/);
  await assert.rejects(turn.callTool('call_3', 'read_files', {}), /Cline 已停止/);
});

test('waiting for a request ends with the run that is waiting', async t => {
  const turn = await startFake(t);
  const call = turn.callTool('call_1', 'read_files', {});
  await new Promise(resolve => setImmediate(resolve));
  // The fake is now "executing" call_1, so no request is open until its result arrives.
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(turn.whenOpen(60_000, abort.signal), /aborted/);
  assert.equal(await call, 'read_files:{}');
  turn.dispose();
});

test('a binary that never asks fails the start with its own output', async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-agent-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  await assert.rejects(
    ClineTurn.start({ bin: process.execPath, binArgs: ['-e', 'console.error("no provider configured"); process.exit(3)', '--'], cwd: os.tmpdir(), homeDir }),
    /Cline 进程已退出（3）：no provider configured/,
  );
});
