import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { integrate, upstream } from '../tools/patch-piweb-source.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = [process.env.PIWEB_SOURCE, path.join(repo, 'upstream'), path.join(repo, '../scratch/pi-web-upstream-main')].find(dir => dir && fs.existsSync(path.join(dir, 'components/ChatInput.tsx')));
if (!source) throw new Error('Official source checkout required: set PIWEB_SOURCE (CI uses upstream/)');
const stateFile = path.join(source, '.pi-portable-overlay.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const read = name => fs.readFileSync(state?.files[name]?.backup || path.join(source, name), 'utf8');
const integrated = integrate(read);
const runtime = integrated.get('lib/pi-portable-runtime.js').replace(/^export /gm, '');
const helpers = vm.runInNewContext(`${runtime};({ collectConversationNodeRecords, filterSessionsForWorktree, getClipboardPastePlan, readPreference, rememberPreference })`, { console, window: {}, localStorage: { getItem: () => null, setItem() {} } });

// These contracts intentionally check the downstream requirements, not obsolete
// upstream defaults that our explicit full/muted policy replaces.
test('pins the official main SHA and declares source-integrated runtime identity', () => {
  assert.match(upstream.ref, /^[a-f0-9]{40}$/);
  const pkg = JSON.parse(integrated.get('package.json'));
  assert.equal(pkg.version, upstream.version);
  assert.deepEqual(pkg.piPortable, { upstreamRef: upstream.ref, sourceOverlay: 1 });
});

test('source integration is deterministic and keeps client directives first', () => {
  const repeated = integrate(read);
  assert.deepEqual(repeated, integrated);
  for (const name of ['components/ChatInput.tsx', 'components/ChatWindow.tsx', 'components/SessionSidebar.tsx', 'hooks/useAgentSession.ts', 'components/PortableNodes.tsx', 'components/PortableControls.tsx']) {
    assert.ok(integrated.get(name).startsWith('"use client";'), name);
  }
});

test('unknown upstream anchors abort the entire plan before any file writes', () => {
  assert.throws(() => integrate(name => name === 'components/ChatInput.tsx' ? read(name).replace('const handlePaste = useCallback(', 'const renamedPaste = useCallback(') : read(name)), /paste handler missing/);
});

test('native draft preservation, lazy pagination and virtualization are not replaced', () => {
  assert.equal(integrated.has('lib/draft-store.ts'), false);
  assert.equal(integrated.has('lib/session-reader.ts'), false);
  assert.equal(integrated.has('lib/highlight.ts'), false);
  assert.match(integrated.get('components/SessionSidebar.tsx'), /getSessionListIndices\(/);
  assert.match(integrated.get('components/ChatWindow.tsx'), /tail: 200, signal: controller.signal/);
  assert.match(integrated.get('components/ChatInput.tsx'), /getDraft\(draftKey\)/);
});

test('Q/A nodes exclude intermediate tool/error turns without transporting messages', () => {
  const messages = [
    { role: 'user', content: 'Question' },
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'working' }] },
    { role: 'toolResult', content: 'large output' },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '**Final answer**' }] },
    { role: 'assistant', stopReason: 'error', content: 'error' },
  ];
  const records = helpers.collectConversationNodeRecords(messages, ['q', 'tool', 'result', 'a', 'error']);
  assert.equal(records.length, 2);
  assert.equal(records[0].entryId, 'q'); assert.equal(records[1].entryId, 'a');
  const route = integrated.get('app/api/sessions/[id]/context/route.ts');
  assert.match(route, /sm.getBranch\(leafId\)/);
  assert.match(route, /records.map\(\(\{ role, text, fullText, entryId \}\) => \(\{ role, text, fullText, entryId \}\)\)/);
  const nodes = integrated.get('components/PortableNodes.tsx');
  assert.match(nodes, /nodes.slice\(start, start \+ 24\)/);
  assert.match(nodes, /\[sessionId, leafId\]/);
  assert.doesNotMatch(nodes, /setInterval|\/api\/agent/);
});

test('worktree categories keep unrelated historical checkouts in main and native terminals alive', () => {
  const sessions = [{ id: 'main', cwd: 'C:/repo' }, { id: 'old', cwd: 'C:/repo/.claude/worktrees/temp' }, { id: 'feature', cwd: 'C:/repo-worktrees/feature' }];
  const trees = { isGit: true, currentWorktreePath: 'C:/repo', worktrees: [{ isMain: true, path: 'C:/repo' }, { path: 'C:/repo-worktrees/feature' }] };
  assert.equal(helpers.filterSessionsForWorktree(sessions, trees, 'C:/repo').map(s => s.id).join(','), 'main,old');
  const shell = integrated.get('components/AppShell.tsx');
  assert.match(shell, /selectedSession\?\.cwd === cwd/);
  assert.match(shell, /leave\n      \/\/ independently-owned terminal tabs/);
});

test('service-tier hook forwards the same context/options for native and snapshots explicit wire choice', async () => {
  const generated = integrated.get('lib/pi-portable-tier.js').replace('export function', 'function');
  const setTier = vm.runInNewContext(`${generated};setPortableServiceTier`, { console });
  const calls = [];
  const inner = { agent: { streamFunction(model, context, options) { calls.push({ model, context, options }); return 'stream'; } } };
  const context = { messages: ['unchanged'] }, options = { sessionId: 'same-cache-key' }, model = { api: 'openai-codex-responses' };
  setTier(inner, null); inner.agent.streamFunction(model, context, options);
  assert.equal(calls[0].context, context); assert.equal(calls[0].options, options);
  setTier(inner, 'priority'); inner.agent.streamFunction(model, context, options); setTier(inner, 'flex');
  assert.equal((await calls[1].options.onPayload({ input: context.messages })).service_tier, 'priority');
  assert.equal(calls.length, 2);
});

test('model defaults use public persist option, clamp native thinking and retain model-load errors', () => {
  const rpc = integrated.get('lib/rpc-manager.ts'), models = integrated.get('app/api/models/route.ts');
  assert.match(rpc, /setModel\(model, \{ persist: true \}\)/);
  assert.match(rpc, /settingsManager.flush\(\)/);
  assert.match(models, /clampThinkingLevel/);
  assert.match(models, /force, providers: \['openai-codex'\]/);
  const input = integrated.get('components/ChatInput.tsx');
  const levels = input.match(/const THINKING_LEVELS = \[([^\]]*)\]/)[1];
  assert.doesNotMatch(levels, /auto/);
  assert.match(integrated.get('hooks/useAgentSession.ts'), /setModelError\(e instanceof Error/);
});

test('follow-up activation is explicit, checks extension availability and never synthesizes a goal', () => {
  const controls = integrated.get('components/PortableControls.tsx');
  assert.match(controls, /useState\(false\)/);
  assert.match(controls, /自动追问扩展未加载/);
  assert.match(controls, /run\(`\/lop-followup-ui \$\{mode\}`\)/);
  assert.doesNotMatch(controls, /setInterval|\/v1\/responses/);
});

test('archive uses a stable native slot and row IDs, not React fiber introspection on the new version', () => {
  const sidebar = integrated.get('components/SessionSidebar.tsx');
  assert.match(sidebar, /data-pi-archive-slot/);
  assert.match(sidebar, /data-pi-session-id=\{session.id\}/);
  assert.match(sidebar, /pi-web:refresh-sessions/);
});

test('portable CSS is emitted directly, not an ignored import after Tailwind expansion', () => {
  const css = integrated.get('app/globals.css');
  assert.match(css, /\.model-selector\.is-toolbar/);
  assert.match(css, /\.pw-followup-menu/);
  assert.doesNotMatch(css, /@import ["']\.\/portable\.css/);
});

test('clipboard uploads cannot escape their draft or submit before all files settle', () => {
  const input = integrated.get('components/ChatInput.tsx');
  assert.match(input, /new Map<string, number>\(\)/);
  assert.match(input, /!pasteMountedRef.current \|\| target !== pasteTargetRef.current/);
  assert.match(input, /files saved in original project, not inserted into another draft/);
  assert.equal(input.split('if ((pendingPastes.current.get(pasteTargetRef.current) ?? 0) > 0) return;').length - 1, 2);
  assert.match(input, /busy: pending > 0/);
});

test('new draft model choices persist before sending; follow-up busy state retains its menu and returns focus', () => {
  const hook = integrated.get('hooks/useAgentSession.ts');
  const model = hook.slice(hook.indexOf('const handleModelChange'), hook.indexOf('const handleCompact'));
  assert.match(model, /await ensureNewSession\(\)/);
  assert.ok(model.indexOf('rememberPreference') > model.indexOf('await sendAgentCommand'));
  assert.match(model, /默认模型保存失败/);
  const controls = integrated.get('components/PortableControls.tsx');
  assert.match(controls, /!busy && event.relatedTarget/);
  assert.match(controls, /requestAnimationFrame\(\(\) => trigger.current\?\.focus\(\)\)/);
  assert.match(integrated.get('components/PortableNodes.tsx'), /tabIndex=\{0\}/);
  assert.doesNotMatch(integrated.get('components/PortableNodes.tsx'), /onMouseEnter/);
});

test('history process groups keep tool cards visible exactly once', () => {
  const chat = integrated.get('components/ChatWindow.tsx');
  assert.match(chat, /rendered.push\(\.\.\.portableToolViews\)/);
  assert.match(chat, /block.type === 'toolCall' \? \{ type: 'text', text: '' \} : block/);
  assert.match(chat, /ProcessDetailsGroup/);
});
