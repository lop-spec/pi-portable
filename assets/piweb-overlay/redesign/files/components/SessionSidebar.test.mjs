import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { buildLayout, visibleIndices } = await jiti.import("./sidebar/virtual.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("./SessionSidebar.tsx");
const listSource = await read("./sidebar/SessionList.tsx");
const rowSource = await read("./sidebar/SessionRow.tsx");
const drawerSource = await read("./sidebar/FileDrawer.tsx");
const switcherSource = await read("./sidebar/ProjectSwitcher.tsx");
const actionsSource = await read("./PortableContextActions.tsx");
const sidebarCss = await read("../app/redesign-sidebar.css");
const globalStyles = await read("../app/globals.css");

test("the virtual list keeps the viewport and pinned rows mounted without expanding the whole window", () => {
  const layout = buildLayout(Array.from({ length: 2000 }, () => 30));
  for (const [scrollTop, pinned] of [[0, 1999], [30000, 0]]) {
    const indices = visibleIndices(layout, scrollTop, 335, 8, [pinned]);
    const firstVisible = Math.floor(scrollTop / 30);
    const lastVisible = Math.ceil((scrollTop + 335) / 30) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(pinned));
    assert.ok(indices.length < 40);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.ok(!visibleIndices(layout, 30000, 335).includes(0));
});

test("virtual windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(visibleIndices(buildLayout([26, 30, 30, 32, 30]), 80000, 335, 8, [1999]), [0, 1, 2, 3, 4]);
  assert.deepEqual(visibleIndices(buildLayout([]), 80000, 335, 8, [1999]), []);
  assert.ok(visibleIndices(buildLayout(Array.from({ length: 2000 }, () => 30)), 0, 0).length > 0);
});

test("session rows expose the DOM contract hooks for the injected script", () => {
  assert.match(rowSource, /data-pi-session-id=\{session\.id\}/);
  assert.match(rowSource, /data-pi-session-row=""/);
  assert.match(rowSource, /<span data-pi-row-slot="" \/>/);
  assert.match(rowSource, /aria-current=\{isSelected \? "page" : undefined\}/);
  assert.match(listSource, /<span data-pi-archive-slot="" \/>/);
  assert.doesNotMatch(source, /data-pi-archive-slot="true" style=/);
  assert.doesNotMatch(source, /useScramble|SCRAMBLE_CHARS|animateTransform/);
});

test("rows are keyboard reachable through one roving main button, without deletion shortcuts", () => {
  assert.match(rowSource, /className="pw-sess-main"\s+tabIndex=\{tabbable \? 0 : -1\}/);
  assert.match(listSource, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(listSource, /event\.key === "F2"/);
  assert.match(listSource, /event\.key === "F10" && event\.shiftKey\) \|\| event\.key === "ContextMenu"/);
  assert.doesNotMatch(listSource + rowSource, /"Delete"|"Backspace"/);
});

test("the file drawer is collapsed by default, remembers open state and height, and keeps six session rows", () => {
  assert.match(drawerSource, /const STORAGE_KEY = "pi-web:file-drawer"/);
  assert.match(drawerSource, /if \(!raw\) return \{ open: false, height: null \}/);
  assert.match(drawerSource, /const MIN_HEIGHT = 160/);
  assert.match(drawerSource, /role="separator"/);
  assert.match(drawerSource, /data-resize-handle="sidebar-sections"/);
  assert.match(source, /const MIN_VISIBLE_SESSION_ROWS = 6/);
  assert.match(globalStyles, /\.sidebar-section-resize-handle:focus-visible::after/);
  assert.match(sidebarCss, /\.pw-fd \.pw-fd-resize\.sidebar-section-resize-handle:focus-visible::after/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("background refreshes only publish state that actually changed", () => {
  assert.match(source, /return sameIdSet\(previous, next\) \? previous : next;/);
  assert.match(source, /setAllSessions\(\(previous\) => shareSessionList\(previous, data\.sessions\)\)/);
  assert.match(source, /setProjectRegistry\(\(previous\) => shareJson\(previous, data\.portableProjects\)\)/);
});

test("the first-paint summary is not discarded by the first running poll", () => {
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current && sessionLoadsInFlightRef\.current === 0/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  assert.match(switcherSource, /aria-label=\{`\$\{stats\.running\} 个会话运行中`\}/);
  assert.match(switcherSource, /aria-label=\{`\$\{stats\.unread\} 个会话有新回复`\}/);
});

test("does not persist an unchanged fallback title", () => {
  assert.match(rowSource, /onCommit\(name === null \|\| name === initial \? null : name\)/);
  assert.match(listSource, /const name = value\.trim\(\);[\s\S]*?if \(name === \(session\.name \?\? ""\)\) return;/);
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(listSource, /const handleOpenMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(rowSource, /onContextMenu=\{renaming \? undefined : openMenu\}/);
  assert.match(actionsSource, /window\.addEventListener\(SESSION_ROW_CONTEXT_MENU_EVENT, listener\)/);
});

test("lifecycle refreshes bypass the cache while cross-window polling and first-paint hydration reuse it", () => {
  assert.match(source, /function sessionListUrl\(summary: boolean, force: boolean\)/);
  assert.match(source, /if \(summary\) return "\/api\/sessions\?summary=1"/);
  assert.match(source, /if \(force\) return "\/api\/sessions\?force=1"/);
  assert.match(source, /cache: "no-store"/);
  // First paint uses the cheap summary listing, then hydrates from the server cache after a delay.
  assert.match(source, /loadSessions\(true, false, true\)/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?void loadSessions\(false, false\)/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(rowSource, /const interactive = !session\.transient;/);
  assert.match(rowSource, /\{!renaming && interactive && \(/);
  assert.match(listSource, /if \(!session \|\| session\.transient\) return;/);
  assert.match(actionsSource, /if \(!session \|\| session\.transient\) return;/);
});

test("subagents stay grouped under their main session and aggregate state while collapsed", () => {
  assert.match(source, /const sessionFamilies = useMemo\(\(\) => listSessionFamilies\(categorySessions\)/);
  assert.match(listSource, /familyIds\.some\(\(member\) => member\.id === selectedSessionId\)/);
  assert.match(listSource, /familyIds\.some\(\(member\) => runningSessionIds\.has\(member\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("sidebar sources use tokens and classes instead of hard-coded colours", () => {
  const sources = [source, listSource, rowSource, drawerSource, switcherSource, actionsSource, sidebarCss];
  for (const text of sources) assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

// ───────── fixside 回归：组件接线（行为本身在 sidebar/sidebar-helpers.test.mjs） ─────────
const worktreeSource = await read("./sidebar/WorktreeSwitcher.tsx");
const popMenuSource = await read("./sidebar/PopMenu.tsx");
const dialogSource = await read("./sidebar/PwDialog.tsx");
const pickerSource = await read("./DirectoryPicker.tsx");
const projectsSource = await read("./PortableProjects.tsx");

test("regression: the family auto-expand effect does not depend on the expanded set, so collapsing the selected subagent's family sticks", () => {
  const effect = listSource.match(/useEffect\(\(\) => \{\s*const \{ rootId, handledId \} = resolveAutoExpand\([\s\S]*?\}, \[([^\]]*)\]\);/);
  assert.ok(effect, "auto-expand effect uses resolveAutoExpand");
  assert.doesNotMatch(effect[1], /expanded/);
  assert.match(listSource, /autoExpandedForRef\.current = handledId/);
});

test("regression: every dialog sets its initial focus after showModal instead of relying on React autoFocus", () => {
  assert.match(dialogSource, /dialog\.showModal\(\);\s*focusInitialControl\(dialog\);/);
  assert.match(pickerSource, /dialog\.showModal\(\);[\s\S]*?focusInitialControl\(dialog\);/);
  assert.match(pickerSource, /id="directory-path"[\s\S]*?data-autofocus=""/);
  assert.match(projectsSource, /id="pw-create-project-path"[^>]*data-autofocus=""/);
  assert.match(actionsSource, /id="pw-project-rename"[^>]*data-autofocus=""/);
  assert.match(actionsSource, /id="pw-project-delete"[^>]*data-autofocus=""/);
  // 删除会话对话框：初始焦点落在「取消」而不是破坏性按钮
  assert.match(actionsSource, /onClick=\{onClose\} data-autofocus="">取消<\/button>/);
  for (const text of [dialogSource, pickerSource, projectsSource, actionsSource]) assert.doesNotMatch(text, /\sautoFocus(?=[\s/>])/);
});

test("regression: removing a worktree always goes through the confirm row; the trash sits in its own column and never replaces the count", () => {
  // 垃圾桶只登记待确认，真正的移除只出现在确认行的「移除」/「强制移除」里
  assert.match(worktreeSource, /className="pw-icon-btn pw-icon-btn--sm pw-icon-btn--danger pw-wt-remove"[\s\S]*?onClick=\{\(event\) => \{ event\.stopPropagation\(\); setPendingRemove\(worktree\.path\); \}\}/);
  assert.match(worktreeSource, /onRemove\(worktree\.path, false\)\)\.finally\(\(\) => setPendingRemove\(null\)\)/);
  assert.match(worktreeSource, /onRemove\(worktree\.path, true\)/);
  assert.equal((worktreeSource.match(/onRemove\(worktree\.path, false\)/g) ?? []).length, 1);
  assert.match(worktreeSource, /const close = \(\) => \{[^}]*setPendingRemove\(null\)/);
  assert.match(source, /onRemove=\{handleRemoveWorktree\}/);
  // CSS：移除按钮不再绝对定位叠在行右缘，hover 也不隐藏计数
  assert.match(sidebarCss, /\.pw-wt-item \{ display: flex; align-items: center; gap: 8px;/);
  assert.doesNotMatch(sidebarCss, /\.pw-wt-remove,\s*\.pw-proj-restore \{\s*position: absolute/);
  assert.doesNotMatch(sidebarCss, /pw-wt-item[^{]*\.pw-menu-meta[^{]*\{[^}]*visibility: hidden/);
});

test("regression: permanently deleting the current project switches away and unbinds the file drawer", () => {
  assert.match(switcherSource, /onRegistryChange\(registry, removed \? dialog\.project\.key : null, dialog\.kind === 'delete'\)/);
  assert.match(source, /applyProjectChange = useStableCallback\(\(registry: ProjectRegistry, removedKey: string \| null, deleted = false\)/);
  assert.match(source, /projectRemovalAction\(\{ removedKey, currentKey: selectedProject\?\.key \?\? null, deleted, hasOpenSession: Boolean\(selectedSessionId\) \}\) === "switch"/);
  assert.match(source, /if \(deleted && selectedProject\) setDeletedRoots/);
  assert.match(source, /const drawerCwd = selectedCwd\s*\?\? \(selectedCwdProp && !deletedRoots\.some\(\(root\) => pathWithinRoot\(selectedCwdProp, root\)\)/);
});

test("regression: PopMenu ignores scrolls that cannot move its anchor and leaves Tab alone inside embedded forms", () => {
  assert.match(popMenuSource, /shouldCloseOnScroll\(\{/);
  assert.doesNotMatch(popMenuSource, /if \(inside\(event\.target\)\) return;\s*closeRef\.current\("scroll"\);/);
  assert.match(popMenuSource, /anchor\.kind === "rect" \? anchor\.element \?\? null : document\.elementFromPoint\(anchor\.x, anchor\.y\)/);
  assert.match(popMenuSource, /if \(action === "close"\) \{\s*event\.preventDefault\(\);\s*restore\(\);\s*closeRef\.current\("tab"\);\s*\}/);
  assert.doesNotMatch(popMenuSource, /if \(event\.key === "Tab"\) \{\s*event\.preventDefault\(\);/);
  // Esc 仍然无条件关闭并还焦点
  assert.match(popMenuSource, /event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*restore\(\);\s*closeRef\.current\("escape"\)/);
});

test("regression: the session list schedules one timer for the next local midnight and cleans it up", () => {
  assert.match(listSource, /function useLocalToday\(\): Date/);
  assert.match(listSource, /setTimeout\(\(\) => \{ refresh\(\); arm\(\); \}, msUntilNextLocalMidnight\(new Date\(\)\)\)/);
  assert.match(listSource, /clearTimeout\(timer\)/);
  assert.match(listSource, /document\.addEventListener\("visibilitychange", onVisible\)/);
  assert.match(listSource, /groupSessionsByDay\(families, \(family\) => family\.latestModified, today\)/);
  assert.match(listSource, /\}, \[expanded, families, today\]\);/);
  assert.match(listSource, /const now = today;/);
});

test("regression: the archived list head and empty state use the selected project's count and the injected script's global total", () => {
  // 注入脚本写全局总数；本组件写当前项目的归档数（脚本据此渲染「N 个对话」）。两者用 html 上的 data 属性对接。
  assert.match(listSource, /import \{ archiveEmptyMessage, archivedProjectCount \} from "\.\/archive-count";/);
  assert.match(listSource, /attributeFilter: \["data-pi-session-archive-view", "data-pi-session-archive-total"\]/);
  assert.match(listSource, /const \{ archived: archivedView, total: archiveTotal \} = useArchiveView\(\);/);
  assert.match(listSource, /const archivedCount = useMemo\(\(\) => \(archivedView \? archivedProjectCount\(families\) : null\), \[archivedView, families\]\);/);
  assert.match(listSource, /root\.dataset\.piSessionArchiveProjectCount = String\(archivedCount\);/);
  assert.match(listSource, /delete root\.dataset\.piSessionArchiveProjectCount;/);
  assert.match(listSource, /<p>\{archivedView \? archiveEmptyMessage\(archiveTotal\) : "这个项目还没有会话"\}<\/p>/);
  assert.doesNotMatch(listSource, /"没有已归档的会话"/);
});
