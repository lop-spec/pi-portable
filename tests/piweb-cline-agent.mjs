// Cline agent: the source integration lands on every anchor, the process bridge keeps its
// contract with a Cline-shaped client (tests/fixtures/fake-cline.mjs), and the saved
// prompt that lets a run start without waiting for that process behaves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { ClineTurn, resolveClineBinary } from '../assets/piweb-overlay/cline-agent/cline-bridge.ts';
import { promptCacheKey, promptForDay, readPrompt, writePrompt } from '../assets/piweb-overlay/cline-agent/cline-prompt-cache.ts';
import { getAgentChoice, setAgentChoice } from '../assets/piweb-overlay/cline-agent/agent-choice.ts';

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (predicate()) return true;
  return false;
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const removeDir = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeDir(dir));
  return dir;
};
function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
const pidFileIn = (t, delayMs) => {
  const file = path.join(tempDir(t, 'cline-pid-'), 'pid');
  withEnv(t, { FAKE_CLINE_PIDFILE: file, ...(delayMs ? { FAKE_CLINE_DELAY_MS: String(delayMs) } : {}) });
  return file;
};
const pidIn = file => Number(fs.readFileSync(file, 'utf8'));
const started = file => fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== '';

/** The turn comes back at once, as in a run that has its prompt saved. */
function createFake(t, options = {}) {
  const homeDir = tempDir(t, 'cline-agent-');
  const turn = ClineTurn.create({ bin: process.execPath, binArgs: [fake], cwd: os.tmpdir(), homeDir, ...options });
  t.after(() => turn.dispose());
  return turn;
}
/** The turn comes back once Cline has made its first request, as in a run that has nothing saved. */
async function startFake(t, options) {
  const turn = createFake(t, options);
  await turn.whenOpen(10_000);
  return turn;
}

test('integration wires the agent into the session, the prompt and the composer', { skip: !available }, () => {
  const files = integrate(read);
  for (const name of ['lib/cline-bridge.ts', 'lib/cline-prompt-cache.ts', 'lib/cline-agent.ts', 'lib/portable-agent-choice.ts', 'components/PortableAgentSwitch.tsx', 'app/api/cline-agent/route.ts']) {
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
  assert.equal(count(files.get('components/PortableAgentSwitch.tsx'), 'role="menuitemradio"'), 1);
  assert.match(files.get('components/PortableAgentSwitch.tsx'), /aria-haspopup="menu"/, 'the agent is chosen from a dropdown');
});

test('the agent is Cline until a choice is made, and a Pi choice is kept', () => {
  const store = new Map();
  globalThis.window = { dispatchEvent() {} };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
  try {
    assert.equal(getAgentChoice(), 'cline');
    assert.equal(getAgentChoice('s1'), 'cline');
    setAgentChoice('s1', 'pi');
    assert.equal(getAgentChoice('s1'), 'pi');
    assert.equal(getAgentChoice('s2'), 'pi', 'a session without a choice follows the last one');
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
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

test('a call made while Cline is still loading waits for it and then goes through', async t => {
  withEnv(t, { FAKE_CLINE_DELAY_MS: '400' });
  const turn = createFake(t);
  const at = Date.now();
  // Nothing is awaited between creating the turn and handing it the call.
  assert.equal(await turn.callTool('call_1', 'read_files', { value: 'x' }), 'read_files:{"value":"x"}');
  assert.ok(Date.now() - at >= 300, 'the call waited for the slow start');
  assert.equal(turn.system, 'You are Cline (fake).');
});

test('a run that needed no tool stops a process that is still loading', async t => {
  const pidFile = pidFileIn(t, 20_000);
  const turn = createFake(t);
  assert.ok(await waitFor(() => started(pidFile)), 'the process was started');
  const pid = pidIn(pidFile);
  turn.finish();
  assert.equal(turn.alive, false);
  assert.ok(await waitFor(() => !alive(pid)), 'and was stopped rather than left to finish loading');
  await assert.rejects(turn.whenOpen(1000), /Cline 已停止/);
});

test('a turn stopped before its process was started never starts it', async t => {
  const pidFile = pidFileIn(t);
  const turn = createFake(t);
  turn.dispose();
  await sleep(500);
  assert.equal(fs.existsSync(pidFile), false);
  await assert.rejects(turn.callTool('call_1', 'read_files', {}), /Cline 已停止/);
});

test('a process that makes no request in time is stopped and reported', async t => {
  const pidFile = pidFileIn(t, 20_000);
  const turn = createFake(t, { startTimeoutMs: 1500 });
  await assert.rejects(turn.whenOpen(10_000), /没有发起请求/);
  assert.equal(turn.alive, false);
  assert.ok(await waitFor(() => started(pidFile)), 'it had been started');
  assert.ok(await waitFor(() => !alive(pidIn(pidFile))), 'and does not outlive the report');
});

test('a binary that exits without asking fails the turn with its own output', async t => {
  const turn = createFake(t, { bin: process.execPath, binArgs: ['-e', 'console.error("no provider configured"); process.exit(3)', '--'] });
  await assert.rejects(turn.whenOpen(10_000), /Cline 进程已退出（3）：no provider configured/);
  await assert.rejects(turn.callTool('call_1', 'read_files', {}), /Cline 进程已退出（3）/);
});

const TOOLS = [{ name: 'read_files', description: 'Read files', parameters: { type: 'object', properties: {} } }];
const system = day => `You are Cline.\n<env>\n2. Date: ${day}\n4. Working Directory: C:/work\n</env>`;
const noisy = t => { const original = console.error; console.error = () => {}; t.after(() => { console.error = original; }); };

test('a saved prompt is reused as it is on the day it was saved and moved to today on another', t => {
  const dir = tempDir(t, 'cline-cache-');
  writePrompt(dir, 'k', { system: system('2026/11/16'), tools: TOOLS }, new Date(2026, 10, 16, 8, 0));
  assert.deepEqual(readPrompt(dir, 'k', new Date(2026, 10, 16, 23, 59)), { system: system('2026/11/16'), tools: TOOLS });
  assert.deepEqual(readPrompt(dir, 'k', new Date(2026, 10, 17, 0, 1)), { system: system('2026/11/17'), tools: TOOLS });
  assert.deepEqual(readPrompt(dir, 'k', new Date(2027, 0, 5, 12, 0)).system, system('2027/01/05'));
});

test('a date line that cannot be read keeps the prompt to the day it was saved', t => {
  const dir = tempDir(t, 'cline-cache-');
  const odd = { system: 'You are Cline. Date: Nov 16', tools: TOOLS };
  writePrompt(dir, 'odd', odd, new Date(2026, 10, 16, 9, 0));
  assert.deepEqual(readPrompt(dir, 'odd', new Date(2026, 10, 16, 18, 0)), odd);
  assert.equal(readPrompt(dir, 'odd', new Date(2026, 10, 17, 9, 0)), undefined);
  // A prompt that does not state the date does not depend on it.
  const plain = { system: 'You are Cline.', tools: TOOLS };
  writePrompt(dir, 'plain', plain, new Date(2026, 10, 16, 9, 0));
  assert.deepEqual(readPrompt(dir, 'plain', new Date(2026, 10, 20, 9, 0)), plain);
  assert.equal(promptForDay(system('2026/11/16'), new Date(2026, 10, 17)), system('2026/11/17'));
});

test('entries are per working directory and per Cline build, and unusable files are ignored', t => {
  noisy(t);
  const dir = tempDir(t, 'cline-cache-');
  const bin = path.join(dir, 'cline.exe');
  fs.writeFileSync(bin, 'a');
  const here = promptCacheKey(bin, 'C:/a'), there = promptCacheKey(bin, 'C:/b');
  assert.notEqual(here, there);
  const now = new Date(2026, 10, 17, 9, 0);
  writePrompt(dir, here, { system: system('2026/11/17'), tools: TOOLS }, now);
  assert.equal(readPrompt(dir, there, now), undefined, 'another directory has no entry');
  fs.writeFileSync(bin, 'ab');
  assert.notEqual(promptCacheKey(bin, 'C:/a'), here, 'a rebuilt binary is another key');

  const file = path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.json')));
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const broken of ['{not json', JSON.stringify({ ...entry, tools: [] }), JSON.stringify({ ...entry, tools: [{ name: 'x' }] }), JSON.stringify({ ...entry, system: '' }), JSON.stringify({ ...entry, key: 'other' })]) {
    fs.writeFileSync(file, broken);
    assert.equal(readPrompt(dir, here, now), undefined, broken.slice(0, 40));
  }
  assert.equal(readPrompt(path.join(dir, 'missing'), here, now), undefined);
});

test('writing an unchanged prompt leaves the file alone, and only recent entries are kept', t => {
  const dir = tempDir(t, 'cline-cache-');
  const now = new Date(2026, 10, 17, 9, 0);
  writePrompt(dir, 'same', { system: system('2026/11/17'), tools: TOOLS }, now);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const old = new Date(2026, 10, 1);
  fs.utimesSync(file, old, old);
  writePrompt(dir, 'same', { system: system('2026/11/17'), tools: TOOLS }, now);
  assert.equal(fs.statSync(file).mtimeMs, old.getTime(), 'not rewritten');

  const base = Date.now() - 1_000_000;
  for (let i = 0; i < 30; i++) {
    writePrompt(dir, `k${i}`, { system: system('2026/11/17'), tools: TOOLS }, now);
    // The entry just written is the newest; date it so later writes keep their order.
    const newest = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
    const at = new Date(base + i * 1000);
    fs.utimesSync(path.join(dir, newest.name), at, at);
  }
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.json')).length, 24);
  assert.ok(readPrompt(dir, 'k29', now), 'the latest is kept');
  assert.equal(readPrompt(dir, 'k0', now), undefined, 'the oldest is gone');
});
