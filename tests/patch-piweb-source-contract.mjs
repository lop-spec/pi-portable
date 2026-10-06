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

test('native CLI explicitly keeps its Next.js child hidden on Windows', () => {
  const cli = integrated.get('bin/pi-web.js');
  assert.match(cli, /const child = spawn\(process.execPath, getNextNodeArgs\(nextBin, nextArgs\), \{\s+windowsHide: true,/);
  assert.match(cli, /wireChildProcessLifecycle\(child\)/);
  assert.match(cli, /if \(openBrowser && !browserOpened/);
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
  // The reader keeps the process timeline's inline-thinking threshold (only long reasoning is deferred), whatever else the rewrite adds to it.
  const reader = integrated.get('lib/session-reader.ts');
  assert.match(reader, /block\.type === "thinking" && block\.thinking\.trim\(\)\.length > 2000/);
  assert.doesNotMatch(reader, /block\.type === "thinking" && block\.thinking\.trim\(\) !== ""/);
  assert.equal(integrated.has('lib/highlight.ts'), false);
  // The session list is still virtualized (windowed rendering), now in the sidebar's own list component.
  const list = integrated.get('components/sidebar/SessionList.tsx');
  assert.match(list, /from "\.\/virtual"/);
  assert.match(list, /visibleIndices\(/);
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

test('Q/A navigation paginates while streaming, serializes loads, reports failures and cancels', async () => {
  const effect = fs.readFileSync(path.join(repo, 'assets/piweb-overlay/conversation-navigation.effect.txt'), 'utf8').replace('new Set<string>()', 'new Set()');
  assert.doesNotMatch(effect, /sessionBusy/);
  assert.match(integrated.get('components/ChatWindow.tsx'), /conversation navigation target not rendered/);
  assert.match(integrated.get('components/PortableNodes.tsx'), /正在加载并定位消息/);
  async function run({ pages = [], loaded = false, cancel = false, locked = false } = {}) {
    let task, cleanup;
    const result = { calls: [], errors: [], handled: 0, selected: null, visible: 0 };
    const lock = { current: locked };
    const scope = {
      AbortController, Set, Error, String, Math,
      console: { error: (...args) => result.errors.push(args) },
      setTimeout: fn => { lock.current = false; queueMicrotask(fn); },
      searchTarget: { sessionId: 'fixture', entryId: 'target' }, loading: false, sessionBusy: true,
      activeLeafId: null, loadingOlderRef: lock,
      searchHistoryRef: { current: { entryIds: loaded ? ['target'] : ['tail'], historyCursor: 'p0', hasEarlierMessages: true } },
      prevScrollDistanceRef: { current: 10 },
      loadContext: async (...args) => { result.calls.push(args); return pages.shift(); },
      setVisibleCount: fn => { result.visible = fn(20); },
      setPendingSearchScroll: target => { result.selected = target.entryId; },
      setNodeNavigationError: error => { result.error = error; },
      onSearchTargetHandled: () => { result.handled++; },
      useEffect: fn => { cleanup = fn(); },
      capture: promise => { task = promise; },
    };
    vm.runInNewContext(effect.replace('void locate();', 'capture(locate());'), scope);
    if (cancel) cleanup();
    await task;
    assert.equal(lock.current, false);
    return result;
  }
  const page = (ids, cursor, more = true) => ({ entryIds: ids, oldestEntryId: cursor, hasMore: more });
  const deep = await run({ locked: true, pages: [page(['old1'], 'p1'), page(['old2'], 'p2'), page(['target'], 'p3')] });
  assert.equal(deep.selected, 'target'); assert.equal(deep.calls.length, 3); assert.equal(deep.errors.length, 0);
  const loaded = await run({ loaded: true }); assert.equal(loaded.selected, 'target'); assert.equal(loaded.calls.length, 0);
  const failed = await run(); assert.equal(failed.handled, 1); assert.equal(failed.errors.length, 1); assert.ok(failed.error);
  const missing = await run({ pages: [page([], null, false)] }); assert.equal(missing.handled, 1); assert.ok(missing.error);
  const stalled = await run({ pages: [page([], 'p0')] }); assert.equal(stalled.calls.length, 1); assert.equal(stalled.errors.length, 1);
  const aborted = await run({ cancel: true, pages: [page(['target'], null, false)] }); assert.equal(aborted.selected, null); assert.equal(aborted.handled, 0); assert.equal(aborted.errors.length, 0);
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
  // The injected archive script finds one stable slot in the list header and an ID on every row; the row component
  // only reserves an empty slot and never renders an archive control itself.
  assert.match(integrated.get('components/sidebar/SessionList.tsx'), /<span data-pi-archive-slot="" \/>/);
  const row = integrated.get('components/sidebar/SessionRow.tsx');
  assert.match(row, /data-pi-session-id=\{session\.id\}/);
  assert.match(row, /data-pi-session-row=""/);
  assert.match(row, /<span data-pi-row-slot="" \/>/);
  assert.doesNotMatch(row, /__reactFiber|__reactProps/);
  assert.match(integrated.get('components/SessionSidebar.tsx'), /pi-web:refresh-sessions/);
});

test('portable CSS is emitted directly, not an ignored import after Tailwind expansion', () => {
  // The rewrite ships its styles as real stylesheets imported by the root layout (not by an @import inside the Tailwind entry file).
  const layout = integrated.get('app/layout.tsx');
  const sheets = [...layout.matchAll(/^import "\.\/(redesign-[\w-]+\.css)";/gm)].map(match => match[1]);
  assert.ok(sheets.length >= 3, 'layout imports the redesign stylesheets directly');
  const css = sheets.map(name => integrated.get('app/' + name)).join('\n');
  assert.match(css, /\.model-selector\.is-toolbar/);
  assert.match(css, /\.pw-followup-menu/);
  assert.match(css, /\.pw-proc-head/);
  assert.doesNotMatch(integrated.get('app/globals.css'), /@import ["']\.\/(?:portable|redesign-[\w-]+)\.css/);
});

test('clipboard uploads cannot escape their draft or submit before all files settle', () => {
  const input = integrated.get('components/ChatInput.tsx');
  assert.match(input, /new Map<string, number>\(\)/);
  assert.match(input, /!pasteMountedRef.current \|\| target !== pasteTargetRef.current/);
  assert.match(input, /files saved in original project, not inserted into another draft/);
  assert.match(input, /if \(loadingHistory \|\| \(pendingPastes\.current\.get\(pasteTargetRef\.current\) \?\? 0\) > 0\) return;/);
  assert.match(input, /if \(\(pendingPastes\.current\.get\(pasteTargetRef\.current\) \?\? 0\) > 0\) return;/);
  assert.match(input, /busy: pending > 0/);
});

test('session list transports previews only; hot history reuses a bounded browser view and cold load keeps the composer', () => {
  const list = integrated.get('app/api/sessions/route.ts');
  assert.match(list, /firstMessage: s\.firstMessage\.slice\(0, 320\)/);
  const hook = integrated.get('hooks/useAgentSession.ts');
  // 0.9.3 ships a revision-validated bounded snapshot, replacing our old LRU overlay.
  const snapshot = fs.readFileSync(path.join(source, 'lib/session-view-cache.ts'), 'utf8');
  assert.match(snapshot, /const MAX_SESSIONS = 8/);
  assert.match(snapshot, /const MAX_TOTAL_BYTES = 32 \* 1024 \* 1024/);
  assert.match(snapshot, /const TTL_MS = 10 \* 60_000/);
  assert.match(hook, /const cached = (?:readSessionViewSnapshot|getSessionViewSnapshot)\(\w+(?:\.id)?\)/);
  assert.match(hook, /cached\?\.revision === d\.snapshotRevision/);
  assert.match(hook, /deleteSessionViewSnapshot\(\w+\)/);
  assert.match(integrated.get('components/ChatWindow.tsx'), /loadingHistory=\{loading\}/);
  assert.doesNotMatch(integrated.get('components/ChatWindow.tsx'), /t\("chat\.loadingSession"\)/);
  assert.match(integrated.get('components/ChatInput.tsx'), /const sendDisabled = loadingHistory \|\| pasteStatus\.busy/);
  assert.match(integrated.get('components/ChatInput.tsx'), /disabled=\{sendDisabled\}/);
  const sidebar = integrated.get('components/SessionSidebar.tsx');
  assert.match(sidebar, /info\.id !== initialSessionId/);
  assert.match(sidebar, /onSessionDeleted\?\.\(id\)/);
  assert.doesNotMatch(sidebar, /t\("sidebar\.loading"\)/);
  assert.match(integrated.get('components/AppShell.tsx'), /localStorage\.setItem\('pi-web:last-selected-info'/);
});

test('new draft model choices persist before sending; follow-up busy state retains its menu and returns focus', () => {
  const hook = integrated.get('hooks/useAgentSession.ts');
  const model = hook.slice(hook.indexOf('const handleModelChange'), hook.indexOf('const handleCompact'));
  assert.match(model, /await ensureNewSession\(\)/);
  assert.ok(model.indexOf('setNewSessionModel(selectedModel)') < model.indexOf('await sendAgentCommand(sid, { type: "set_model"'));
  assert.match(model, /默认模型保存失败/);
  const controls = integrated.get('components/PortableControls.tsx');
  assert.match(controls, /!busy && event.relatedTarget/);
  assert.match(controls, /requestAnimationFrame\(\(\) => trigger.current\?\.focus\(\)\)/);
  assert.match(integrated.get('components/PortableNodes.tsx'), /tabIndex=\{0\}/);
  assert.doesNotMatch(integrated.get('components/PortableNodes.tsx'), /onMouseEnter/);
});

test('turn process renders as a timeline: narration visible, thinking folded, tool calls hidden', () => {
  const chat = integrated.get('components/ChatWindow.tsx');
  assert.doesNotMatch(chat, /portableToolViews/);
  assert.doesNotMatch(chat, /<ProcessDetailsGroup /);
  assert.match(chat, /import \{ PortableProcessTimeline,[^}]*\} from "\.\/PortableProcessTimeline";/);
  assert.match(chat, /<PortableProcessTimeline\s/);
  // Finished turns, the live tail and a lazy-load window starting mid-turn (a partial turn without its own user message) share the timeline.
  assert.match(chat, /portableProcessTimeline\(\d+, 1, finalAssistantIdx, \{ finalIdx: finalAssistantIdx, finalBlocks: finalProcessBlocks/);
  assert.match(chat, /portableProcessTimeline\(\d+, 1, count - 1, \{ live: true/);
  assert.match(chat, /portableProcessTimeline\(\d+, 0, count - 1, \{ live: turn\.live \}\)/);
  assert.match(chat, /findFinalAssistantIndex\(messages as AgentMessage\[\], (?:-1|0), count\)/);
  // Failed intermediate replies keep the native error view; tool results are not rendered twice.
  assert.match(chat, /const broken = i !== options\.finalIdx && Boolean\(getAssistantErrorMessage\(message\) \|\| isAssistantTruncated\(message\)\)/);
  assert.match(chat, /if \(item\.role === "toolResult"\) continue;/);
  const timeline = integrated.get('components/PortableProcessTimeline.tsx');
  assert.ok(timeline.startsWith('"use client";'));
  assert.match(timeline, /last\?\.type === "tools"\) last\.calls\.push\(call\)/);
  assert.match(timeline, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(timeline, /const expanded = open \|\| Boolean\(target\)/);
  assert.match(timeline, /\{failed\} 条失败/);
  // lop 2026-09-30: tool calls are hidden (a search hit is the one exception), consecutive thinking
  // summaries fold into one row closed by default, and the Chinese narration stays visible.
  assert.match(timeline, /if \(!showTool\(block\)\) return;/);
  assert.match(timeline, /buildTimelineItems\(entries, block => block === searchBlock/);
  assert.match(timeline, /if \(last\?\.type === "thinking"\) \{\s*last\.blocks\.push\(item\)/);
  // Thinking folds closed by default (only a search hit or a click opens it); it reads "正在思考" while streaming.
  assert.ok(timeline.includes('思考 ${blocks.length} 处') && timeline.includes('正在思考'));
  assert.match(timeline, /const ThinkingGroup[\s\S]{0,200}const \[open, setOpen\] = useState\(false\)/);
  assert.match(timeline, /<ThinkingGroup item=\{item\}[^>]*live=\{Boolean\(live\)\}/);
  // The narration is full markdown in the rail, never folded or clipped.
  assert.match(timeline, /className=\{streaming \? "pw-proc-item pw-proc-narr is-streaming" : "pw-proc-item pw-proc-narr"\}/);
  assert.match(timeline, /<div data-message-text[^>]*>\s*<PortableTextBlock /);
  for (const label of ['运行 ${count.bash} 条命令', '读取 ${count.read.size} 个文件', '搜索 ${count.search} 次', '修改 ${count.change.size} 个文件']) assert.ok(timeline.includes(label), label);
  const view = integrated.get('components/MessageView.tsx');
  assert.match(view, /export \{ ToolCallBlock as PortableToolCallBlock, TextBlock as PortableTextBlock, loadThinkingContent as portableLoadThinkingContent, getToolPreview as portableToolPreview \};/);
  // The live bubble's thinking stays collapsed by default (no force-expand while streaming).
  assert.match(view, /const \[expanded, setExpanded\] = useState\(isThinkingExpandedByDefault\);/);
  assert.doesNotMatch(view, /streaming=\{isStreaming\}/);
  assert.match(integrated.get('lib/session-reader.ts'), /block\.type === "thinking" && block\.thinking\.trim\(\)\.length > 2000/);
  // lop 2026-10-06: reasoning is shown only when Chinese makes up at least 30% of its reading units (CJK characters plus whole
  // Latin words); English, or English quoting a few Chinese words, is not shown at all (live or finished).
  const display = integrated.get('lib/message-display.ts');
  const hideSource = display.match(/export const CHINESE_REASONING_MIN_SHARE[\s\S]*?\nexport function isEmptyThinkingBlock[^\n]*\n[^\n]*\n\}/)?.[0];
  assert.ok(hideSource, 'reasoning visibility source');
  const isHidden = vm.runInNewContext(`${hideSource
    .replaceAll('export ', '')
    .replace('(text: string): number', '(text)')
    .replace(/\(block: [^)]*\): block is ThinkingContent/, '(block, _options)')};isEmptyThinkingBlock`, {});
  for (const thinking of ['', '  ', '**Planning the fix**', 'Inspecting files', 'Inspecting the config files and checking 配置 again before the change']) assert.equal(isHidden({ type: 'thinking', thinking }, { isStreaming: true }), true, JSON.stringify(thinking));
  for (const thinking of ['先看一下配置', '**Planning** 然后检查', '分析中', '先改 run-supervisor.mjs 再跑测试']) assert.equal(isHidden({ type: 'thinking', thinking }, { isStreaming: true }), false, thinking);
  assert.equal(isHidden({ type: 'thinking', thinking: 'English preview of a long block', deferred: true }), true);
  assert.equal(isHidden({ type: 'text', text: '' }), false);
  assert.match(integrated.get('app/redesign-conversation.css'), /\.pw-think-fold/);
  assert.match(integrated.get('app/redesign-conversation.css'), /\.pw-proc-narr/);
  // Composer: the model selector (and the gauge/⚡ controls anchored on it) sits first in the
  // right control group, as in 0.9.0; attach and follow-up stay left.
  const input = integrated.get('components/ChatInput.tsx');
  const left = input.indexOf('{/* LEFT:'), right = input.indexOf('{/* RIGHT:');
  const selector = input.indexOf('<ModelSelector');
  assert.ok(left > 0 && right > left && selector > right, 'model selector must be in the right group');
  assert.equal(input.split('<ModelSelector').length - 1, 1);
  assert.ok(input.indexOf('<PortableFollowup') > left && input.indexOf('<PortableFollowup') < right, 'follow-up stays left');
  assert.ok(selector < input.indexOf('{onThinkingLevelChange && ('), 'model selector precedes the thinking level control');
});
