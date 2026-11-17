// Fork actions (message-level fork, pin, fork markers): the naming and anchor rules, the source integration
// landing on every anchor, and the integrated server command driven against real Pi sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { forkAnchor, forkBase, forkMarkerTitle, forkTitle, togglePinned } from '../assets/piweb-overlay/fork-actions/portable-fork-core.mjs';

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
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));

test('a fork is titled "<title> (fork)", then "(fork 2)", "(fork 3)"', () => {
  assert.equal(forkTitle('告警统计'), '告警统计 (fork)');
  assert.equal(forkTitle('告警统计 (fork)'), '告警统计 (fork 2)');
  assert.equal(forkTitle('告警统计 (fork 2)'), '告警统计 (fork 3)');
  assert.equal(forkTitle('告警统计 (fork 9)'), '告警统计 (fork 10)');
  assert.equal(forkTitle('  '), '', 'an untitled parent gives no name (the fork keeps showing its first message)');
  assert.equal(forkTitle(undefined), '');
});

test('a long first message is cut to one short line before "(fork)" so the suffix stays visible', () => {
  const long = `C:\\Users\\lop\\Documents\\生产环境\\scripts\\mongo_2026-11-13 这个脚本在yy-ecs 的沙箱mongo 跑完验证\n第二行`;
  const title = forkTitle(long);
  assert.ok(title.endsWith('… (fork)'), title);
  assert.equal(Array.from(forkBase(long)).length, 40);
  assert.equal(forkBase('a\n\n  b'), 'a');
  assert.equal(forkBase('x'.repeat(40)), 'x'.repeat(40), 'exactly the limit is kept whole');
});

test('the fork point is the last message both sessions share, found through non-message entries', () => {
  const entry = (id, type, parentId = null) => ({ id, type, parentId });
  const parent = [entry('m1', 'message'), entry('c1', 'model_change', 'm1'), entry('m2', 'message', 'c1'), entry('m3', 'message', 'm2'), entry('side', 'message', 'm1')];
  assert.equal(forkAnchor(parent, [{ id: 'm1' }, { id: 'c1' }, { id: 'm2' }, { id: 'info' }]), 'm2', 'entries the fork added end the shared run');
  assert.equal(forkAnchor(parent, [{ id: 'm1' }, { id: 'c1' }, { id: 'new' }]), 'm1', 'a shared settings entry resolves to the message before it');
  assert.equal(forkAnchor(parent, [{ id: 'new' }]), null, 'a fork made before the first message sits at the top');
  assert.equal(forkAnchor(parent, []), null);
  assert.equal(forkAnchor(parent, [{ id: 'm1' }, { id: 'ghost' }, { id: 'm2' }]), 'm1', 'the first foreign id ends the run');
});

test('pins toggle per entry and stay bounded; marker titles are one clipped line', () => {
  assert.deepEqual(togglePinned([], 'a'), ['a']);
  assert.deepEqual(togglePinned(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(togglePinned(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
  assert.equal(forkMarkerTitle({ name: ' 命名的会话 ', firstMessage: '首条消息' }), '命名的会话');
  assert.equal(forkMarkerTitle({ firstMessage: '首条\n第二行' }), '首条');
  assert.equal(Array.from(forkMarkerTitle({ firstMessage: 'y'.repeat(500) })).length, 120);
  assert.equal(forkMarkerTitle({}), '');
});

test('integration puts copy, fork and pin under the answer and wires fork like the desktop app', { skip: !available }, () => {
  const files = integrate(read);
  for (const name of ['lib/portable-fork-core.mjs', 'lib/portable-fork.ts', 'lib/portable-pins.ts', 'components/PortableTurnActions.tsx', 'components/PortableForkMarkers.tsx', 'app/api/sessions/[id]/forks/route.ts']) {
    assert.ok(files.has(name), `${name} is generated`);
  }
  const view = files.get('components/MessageView.tsx');
  assert.match(view, /<PortableTurnActions sessionId=\{sessionId\} entryId=\{entryId\} turnEnd=\{Boolean\(showTimestamp\) && !isStreaming\}/, 'actions lead the model/time line');
  assert.ok(view.indexOf('<PortableTurnActions') < view.indexOf('{withSeparators(metaParts)}'), 'the actions come before the meta parts');
  assert.match(view, /<PortableForkHere sessionId=\{sessionId\} entryId=\{entryId\}/);
  assert.match(view, /onFork!\(entryId!, forkPrefill\)/, 'forking from a user message hands its text to the new session');
  assert.doesNotMatch(between(view, 'function AssistantMessageView', 'const BlockView'), /pw-hover-actions/, 'the old right-hand copy button is gone');

  const chat = files.get('components/ChatWindow.tsx');
  assert.match(chat, /onFork=\{isNew \? undefined : handleFork\}/, 'a running session can still fork from a user message');
  assert.match(chat, /\{!hasEarlierMessages && topIndex === 0 && <PortableForkedFrom session=\{session\} onOpenSession=\{onOpenSession\} \/>\}/);

  const hook = files.get('hooks/useAgentSession.ts');
  const handleFork = between(hook, '  const handleFork = useCallback', '  const handleNavigate = useCallback');
  assert.match(handleFork, /before: true/);
  assert.match(handleFork, /prefill/);
  assert.doesNotMatch(handleFork, /type: "fork"/, 'the source-replacing fork command is no longer used');
  assert.match(hook, /registerForkAfter\(sid, \(entryId\) => handleForkAfterRef\.current\(entryId\)\)/, 'registered once per session, always calling the latest action');
  assert.match(hook, /const forkable = session\?\.relation\?\.kind !== "subagent"/, 'a subagent run is not forked');
  assert.match(hook, /case "fork": \{/);
  assert.match(hook, /await sendAgentCommand\(newSessionId, \{ type: "prompt", message: args \}\)/, '/fork <prompt> runs the prompt in the fork');
  assert.match(hook, /onSessionStatsPanelOpen, forkSourceTitle, isNew\]\);/, 'the command handler is rebuilt when the title or the saved state changes');
  assert.ok(hook.indexOf('const forkSourceTitle') > hook.indexOf('  const handleFork ='), 'the stop-handler contract slices the hook before handleFork');

  const input = files.get('components/ChatInput.tsx');
  assert.match(input, /\{ name: "fork", description: "chat\.commandFork", source: "builtin", availableWhileStreaming: true \}/);
  assert.match(input, /await onBuiltinCommand\(`\/fork \$\{text\}`\)/, 'Ctrl+Alt+Enter is /fork with what is typed');
  assert.match(input, /if \(sendShortcut && e\.ctrlKey && e\.altKey && !isComposing && !imageMode && !attachedImages\.length && onBuiltinCommand\)/);
  assert.match(input, /applyHistoryInput, value, attachedImages, onBuiltinCommand, sendInFork\]/, 'the key handler sees the current text and the fork sender');

  const rpc = files.get('lib/rpc-manager.ts');
  const forkBranch = between(rpc, 'case "fork_branch"', 'case "clone"');
  assert.doesNotMatch(forkBranch, /isSessionRunningForReplacement/, 'a running session can be forked: only the saved file is read');
  assert.match(forkBranch, /command\.before === true/);
  assert.match(forkBranch, /forkedManager\.appendSessionInfo\(name\)/);
  assert.match(between(rpc, 'case "fork": {', 'case "fork_branch"'), /isSessionRunningForReplacement/, 'the source-replacing fork keeps its guard');

  const nodes = files.get('components/PortableNodes.tsx');
  assert.match(nodes, /usePortablePins\(sessionId\)/);
  assert.match(nodes, /if \(!allNodes\.length && !error/, 'narrowing to pins never hides the navigation itself');

  const keys = ['chat.commandFork', 'chat.forkFromHere', 'chat.forkFromHereHint', 'chat.forkFromMessageHint', 'chat.forking', 'chat.pinChapter', 'chat.unpinChapter', 'chat.pinnedOnly', 'chat.turnActions', 'chat.forkedFrom', 'chat.forkedFromOther', 'chat.forkedHere', 'chat.forksHere'];
  for (const locale of ['zh-CN', 'en', 'zh-TW']) {
    const messages = files.get(`lib/i18n/messages/${locale}.ts`);
    for (const key of keys) assert.equal(messages.split(`"${key}":`).length - 1, 1, `${locale} has ${key} once`);
  }
  assert.match(files.get('app/redesign-conversation.css'), /\.pw-turn-meta \.pw-turn-actions \{/);
});

// ---- the integrated server command, against real sessions -------------------------------------------------
const integratedRpc = path.join(source, 'lib/rpc-manager.ts');
const rpcIntegrated = available && fs.existsSync(integratedRpc) && fs.readFileSync(integratedRpc, 'utf8').includes('command.before === true');

async function loadRuntime() {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(source, 'package.json'));
  const jitiModule = await import(pathToFileURL(require.resolve('jiti')).href);
  const createJiti = jitiModule.createJiti ?? jitiModule.default?.createJiti ?? jitiModule.default;
  const jiti = createJiti(pathToFileURL(path.join(source, 'lib/fork-actions-test.mjs')).href, { tsconfigPaths: true });
  const { AgentSessionWrapper } = await jiti.import(pathToFileURL(integratedRpc).href);
  const { SessionManager } = await jiti.import('@earendil-works/pi-coding-agent');
  return { AgentSessionWrapper, SessionManager };
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = text => ({ role: 'user', content: text, timestamp: Date.now() });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'test', provider: 'test', model: 'test', usage, stopReason: 'stop', timestamp: Date.now() });

/** A two-turn session on disk, and a wrapper over it in the shape the upstream rpc-manager tests use. */
async function twoTurns(t, { streaming = false, settings = true } = {}) {
  const { AgentSessionWrapper, SessionManager } = await loadRuntime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-actions-'));
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  if (settings) manager.appendModelChange('test', 'test-model');
  const ids = { u1: manager.appendMessage(user('first question')), a1: manager.appendMessage(assistant('first answer')) };
  ids.u2 = manager.appendMessage(user('second question'));
  ids.a2 = manager.appendMessage(assistant('second answer'));
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: streaming,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: { tools: [] } },
    dispose() {},
  });
  t.after(() => {
    wrapper.destroy();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const child = async result => {
    const info = (await SessionManager.list(root, sessionDir)).find(session => session.id === result.newSessionId);
    assert.ok(info, 'the fork is a saved session');
    return { path: info.path, manager: SessionManager.open(info.path, sessionDir) };
  };
  return { wrapper, manager, ids, sourceFile, child, SessionManager };
}
const messageIds = manager => manager.getEntries().filter(entry => entry.type === 'message').map(entry => entry.id);

test('fork after a finished turn keeps that turn, names the fork and leaves the source alone', { skip: !rpcIntegrated }, async t => {
  const { wrapper, manager, ids, sourceFile, child } = await twoTurns(t);
  const result = await wrapper.send({ type: 'fork_branch', entryId: ids.a1, name: '告警统计 (fork)' });
  assert.equal(result.cancelled, false);
  const fork = await child(result);
  assert.deepEqual(messageIds(fork.manager), [ids.u1, ids.a1]);
  assert.equal(fork.manager.getSessionName(), '告警统计 (fork)');
  assert.equal(fork.manager.getHeader().parentSession, sourceFile);
  assert.equal(manager.getLeafId(), ids.a2, 'the source session keeps its own leaf');
  assert.equal(forkAnchor(manager.getEntries(), fork.manager.getEntries()), ids.a1, 'the marker lands under the turn the fork left');
});

test('fork from a user message leaves it behind and copies everything before it', { skip: !rpcIntegrated }, async t => {
  const { wrapper, manager, ids, child } = await twoTurns(t);
  const fork = await child(await wrapper.send({ type: 'fork_branch', entryId: ids.u2, before: true, name: 'X (fork)' }));
  assert.deepEqual(messageIds(fork.manager), [ids.u1, ids.a1], 'the user message itself is not in the fork');
  assert.equal(fork.manager.getSessionName(), 'X (fork)');
  assert.equal(forkAnchor(manager.getEntries(), fork.manager.getEntries()), ids.a1);
});

test('fork before the very first message gives a saved, reopenable session with no messages', { skip: !rpcIntegrated }, async t => {
  const { wrapper, ids, sourceFile, child } = await twoTurns(t, { settings: false });
  const result = await wrapper.send({ type: 'fork_branch', entryId: ids.u1, before: true, name: '开头 (fork)' });
  const fork = await child(result);
  assert.deepEqual(messageIds(fork.manager), []);
  assert.equal(fork.manager.getSessionName(), '开头 (fork)');
  assert.equal(fork.manager.getHeader().parentSession, sourceFile);
});

test('a running session can be forked, and a legacy call without options still forks after the entry', { skip: !rpcIntegrated }, async t => {
  const { wrapper, ids, child } = await twoTurns(t, { streaming: true });
  const fork = await child(await wrapper.send({ type: 'fork_branch', entryId: ids.a1 }));
  assert.deepEqual(messageIds(fork.manager), [ids.u1, ids.a1]);
  assert.equal(fork.manager.getSessionName(), undefined, 'no name asked, none written');
});

test('forks are told apart by the entries they copy even when the source branched', { skip: !rpcIntegrated }, async t => {
  const { wrapper, manager, ids, child } = await twoTurns(t);
  const first = await child(await wrapper.send({ type: 'fork_branch', entryId: ids.a1 }));
  const second = await child(await wrapper.send({ type: 'fork_branch', entryId: ids.u2, before: true }));
  assert.equal(forkAnchor(manager.getEntries(), first.manager.getEntries()), ids.a1);
  assert.equal(forkAnchor(manager.getEntries(), second.manager.getEntries()), ids.a1, 'both forks left from the same turn: one marker, two links');
  const third = await child(await wrapper.send({ type: 'fork_branch', entryId: ids.a2 }));
  assert.equal(forkAnchor(manager.getEntries(), third.manager.getEntries()), ids.a2);
});
