import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { dayGroupOf, groupSessionsByDay, formatSessionTime, formatSessionDateTime } = await jiti.import("./session-time.ts");
const { deriveSessionTitle } = await jiti.import("./session-title.ts");
const { projectLabel, projectInitial, shortProjectPath } = await jiti.import("./project-label.ts");
const { shareSessionList, sameIdSet, shareJson } = await jiti.import("./shared-state.ts");
const { buildLayout, indexAt, scrollTopToReveal } = await jiti.import("./virtual.ts");

const now = new Date(2026, 9, 6, 15, 30); // 2026-10-06 15:30 本地时间
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

test("sessions group into today / yesterday / last 7 days / older by local date", () => {
  assert.equal(dayGroupOf(at(2026, 10, 6, 0, 1), now), "today");
  assert.equal(dayGroupOf(at(2026, 10, 7, 9), now), "today");
  assert.equal(dayGroupOf(at(2026, 10, 5, 23, 59), now), "yesterday");
  assert.equal(dayGroupOf(at(2026, 9, 30, 8), now), "week");
  assert.equal(dayGroupOf(at(2026, 9, 29, 23), now), "older");
  assert.equal(dayGroupOf("not a date", now), "older");
  const groups = groupSessionsByDay(
    [at(2026, 10, 6), at(2026, 10, 1), at(2026, 10, 6, 9), at(2025, 1, 1)],
    (value) => value,
    now,
  );
  assert.deepEqual(groups.map((group) => [group.label, group.items.length]), [["今天", 2], ["近 7 天", 1], ["更早", 1]]);
});

test("row time shows HH:mm for today and yesterday, M月D日 within the year, YYYY/M/D across years", () => {
  assert.equal(formatSessionTime(at(2026, 10, 6, 9, 5), now), "09:05");
  assert.equal(formatSessionTime(at(2026, 10, 5, 17, 53), now), "17:53");
  assert.equal(formatSessionTime(at(2026, 9, 28), now), "9月28日");
  assert.equal(formatSessionTime(at(2025, 12, 31), now), "2025/12/31");
  assert.equal(formatSessionDateTime(at(2026, 10, 2, 18, 0), now), "10月2日 18:00");
});

test("untitled sessions get a readable title instead of a raw error, path or URL prefix", () => {
  assert.equal(deriveSessionTitle("  已命名  ", "whatever", "id"), "已命名");
  assert.equal(
    deriveSessionTitle(undefined, "Error: MIMO_BROWSER_UNAVAILABLE: The browser is gone\n为什么网页模型报这个", "id"),
    "为什么网页模型报这个",
  );
  assert.equal(
    deriveSessionTitle(undefined, "@docs/中间件-云上与Docker一致性对比清单.md 看下这个，先将 redis 9412 对齐", "id"),
    "中间件-云上与Docker一致性对比清单 看下这个，先将 redis 9412 对齐",
  );
  assert.equal(deriveSessionTitle(undefined, "https://yyh-001.github.io/llm-value-ranking 看看这个榜单", "id"), "yyh-001.github.io/llm-value-ranking 看看这个榜单");
  assert.equal(deriveSessionTitle(undefined, "C:\\Users\\lop\\Documents\\claude\\memory-archive 里有什么", "id"), "memory-archive 里有什么");
  assert.equal(deriveSessionTitle(undefined, "Error: something broke", "id"), "something broke");
  assert.equal(deriveSessionTitle(undefined, "   ", "0123456789abcdef"), "0123456789ab");
});

test("project labels prefer the registry name, then the last path segment; short paths fold the home dir", () => {
  assert.equal(projectLabel({ name: "综合工作台", root: "C:\\x\\y" }), "综合工作台");
  assert.equal(projectLabel({ root: "C:\\Users\\pi-web\\内容创作\\智能回测\\" }), "智能回测");
  assert.equal(projectInitial("android"), "A");
  assert.equal(projectInitial("综合工作台"), "综");
  assert.equal(shortProjectPath("C:\\Users\\pi-web\\开发工具\\综合工作台", "C:\\Users\\lop"), "pi-web / 开发工具 / 综合工作台");
  assert.equal(shortProjectPath("C:\\Users\\lop\\Documents\\x", "C:\\Users\\lop"), "~ / Documents / x");
  assert.equal(
    shortProjectPath("c:\\users\\lop\\AppData\\Local\\pi-web\\data\\workspaces", "C:\\Users\\lop"),
    "~ / AppData / … / data / workspaces",
  );
  assert.equal(shortProjectPath("/home/me/code/app", "/home/me"), "~ / code / app");
});

test("structural sharing keeps unchanged rows, arrays, sets and registries by reference", () => {
  const a = { id: "a", path: "p", cwd: "c", created: "1", modified: "2", messageCount: 1, firstMessage: "x", relation: { kind: "fork" } };
  const b = { ...a, id: "b" };
  const previous = [a, b];
  assert.equal(shareSessionList(previous, [{ ...a, relation: { kind: "fork" } }, { ...b }]), previous);
  const changed = shareSessionList(previous, [{ ...a, messageCount: 2 }, { ...b }]);
  assert.notEqual(changed, previous);
  assert.equal(changed[1], b);
  assert.ok(sameIdSet(new Set(["x", "y"]), new Set(["y", "x"])));
  assert.ok(!sameIdSet(new Set(["x"]), new Set(["y"])));
  const registry = { projects: [{ key: "k", root: "r" }], hidden: [] };
  assert.equal(shareJson(registry, JSON.parse(JSON.stringify(registry))), registry);
});

test("variable-height layout finds the row under a scroll offset and reveals off-screen rows", () => {
  const layout = buildLayout([26, 30, 30, 32, 30, 30]);
  assert.equal(layout.total, 178);
  assert.equal(indexAt(layout, 0), 0);
  assert.equal(indexAt(layout, 55), 1);
  assert.equal(indexAt(layout, 56), 2);
  assert.equal(indexAt(layout, 86), 3);
  assert.equal(scrollTopToReveal(layout, 1, 0, 100), null);
  assert.equal(scrollTopToReveal(layout, 5, 0, 60), 118);
  assert.equal(scrollTopToReveal(layout, 5, 0, 60, true), 118);
  assert.equal(scrollTopToReveal(layout, 0, 100, 60), 0);
});

// ───────── fixside 回归（qa2 左栏验收的 7 条 medium） ─────────
const { resolveAutoExpand } = await jiti.import("./family-expand.ts");
const { focusInitialControl, AUTOFOCUS_SELECTOR, FIELD_SELECTOR } = await jiti.import("./dialog-focus.ts");
const { projectRemovalAction, pathWithinRoot, projectPathConfirmed, confirmPathFor, readRememberedRoots, rememberProjectRoot, forgetProjectRoot } = await jiti.import("./project-removal.ts");
const { shouldCloseOnScroll, tabAction, SCROLL_CLOSE_THRESHOLD } = await jiti.import("./menu-behavior.ts");
const { localDayKey, msUntilNextLocalMidnight } = await jiti.import("./session-time.ts");

test("regression: auto-expanding the selected subagent's family happens once per selection, so a manual collapse sticks", () => {
  const families = [
    { root: { id: "fam" }, subagents: [{ id: "sub-1" }, { id: "sub-2" }] },
    { root: { id: "solo" }, subagents: [] },
  ];
  // 选中子代理：展开它所在的家族并记账
  let step = resolveAutoExpand(families, "sub-2", null);
  assert.deepEqual(step, { rootId: "fam", handledId: "sub-2" });
  // 用户手动折叠后 effect 因 families 刷新/别的状态重跑：不再展开（旧实现在这里把折叠撤销了）
  step = resolveAutoExpand([...families], "sub-2", step.handledId);
  assert.deepEqual(step, { rootId: null, handledId: "sub-2" });
  // 选了别的会话：清账；再选回子代理：再次自动展开
  step = resolveAutoExpand(families, "solo", step.handledId);
  assert.deepEqual(step, { rootId: null, handledId: null });
  step = resolveAutoExpand(families, "sub-1", step.handledId);
  assert.deepEqual(step, { rootId: "fam", handledId: "sub-1" });
  // 目录还没加载出这个子代理（首屏恢复）：不记账，等关系到位后再展开
  assert.deepEqual(resolveAutoExpand([], "sub-1", null), { rootId: null, handledId: null });
  assert.deepEqual(resolveAutoExpand(families, null, "sub-1"), { rootId: null, handledId: null });
});

test("regression: dialogs focus [data-autofocus] after showModal, then the first form field, instead of the close button", () => {
  const calls = [];
  const el = (name) => ({ name, focus: (options) => calls.push([name, options]) });
  const rootWith = (map) => ({ querySelector: (selector) => map[selector] ?? null });
  // 有 data-autofocus（输入框 / 删除类对话框的「取消」）优先
  assert.equal(focusInitialControl(rootWith({ [AUTOFOCUS_SELECTOR]: el("cancel"), [FIELD_SELECTOR]: el("field") })).name, "cancel");
  // 没有就退到第一个可用表单控件
  assert.equal(focusInitialControl(rootWith({ [FIELD_SELECTOR]: el("field") })).name, "field");
  // 都没有：不聚焦任何东西，保留浏览器默认
  assert.equal(focusInitialControl(rootWith({})), null);
  assert.deepEqual(calls, [["cancel", { preventScroll: true }], ["field", { preventScroll: true }]]);
  assert.equal(AUTOFOCUS_SELECTOR, "[data-autofocus]");
});

test("regression: permanently deleting the current project always switches away; hiding keeps it only while a session is open", () => {
  const base = { removedKey: "k", currentKey: "k" };
  assert.equal(projectRemovalAction({ ...base, deleted: true, hasOpenSession: true }), "switch");
  assert.equal(projectRemovalAction({ ...base, deleted: true, hasOpenSession: false }), "switch");
  assert.equal(projectRemovalAction({ ...base, deleted: false, hasOpenSession: true }), "keep");
  assert.equal(projectRemovalAction({ ...base, deleted: false, hasOpenSession: false }), "switch");
  assert.equal(projectRemovalAction({ removedKey: "other", currentKey: "k", deleted: true, hasOpenSession: false }), "keep");
  assert.equal(projectRemovalAction({ removedKey: null, currentKey: "k", deleted: false, hasOpenSession: false }), "keep");
  // 文件抽屉不再绑定已删除目录里的路径（Windows 路径不区分大小写和分隔符）
  assert.ok(pathWithinRoot("C:\\Work\\app\\src", "c:/work/app/"));
  assert.ok(pathWithinRoot("C:\\Work\\app", "C:\\Work\\app"));
  assert.ok(!pathWithinRoot("C:\\Work\\app-worktrees\\x", "C:\\Work\\app"));
  assert.ok(!pathWithinRoot("/srv/App/x", "/srv/app"));
  assert.ok(pathWithinRoot("/srv/app/x", "/srv/app/"));
});

test("regression: a menu only closes on scroll when the scrolled container holds its anchor and the anchor really moved", () => {
  const anchor = { isConnected: true };
  const inside = { contains: (node) => node === anchor };
  const unrelated = { contains: () => false };
  const at = (left, top) => ({ left, top });
  // 聊天流式自动滚动 / 别处列表自动定位：与锚点无关，不关
  assert.equal(shouldCloseOnScroll({ scroller: unrelated, anchor, start: at(10, 40), current: at(10, 40) }), false);
  assert.equal(shouldCloseOnScroll({ scroller: unrelated, anchor, start: at(10, 40), current: at(10, 400) }), false);
  // 锚点所在容器滚动：位移不超过阈值不关，超过才关
  assert.equal(shouldCloseOnScroll({ scroller: inside, anchor, start: at(10, 40), current: at(10, 40 + SCROLL_CLOSE_THRESHOLD) }), false);
  assert.equal(shouldCloseOnScroll({ scroller: inside, anchor, start: at(10, 40), current: at(10, 40 + SCROLL_CLOSE_THRESHOLD + 1) }), true);
  // 页面级滚动（scroller 为 null）同样看锚点位移
  assert.equal(shouldCloseOnScroll({ scroller: null, anchor, start: at(10, 40), current: at(10, 40) }), false);
  assert.equal(shouldCloseOnScroll({ scroller: null, anchor, start: at(10, 40), current: at(10, 120) }), true);
  // 锚点被虚拟列表卸载 / 删除：关
  const gone = { isConnected: false };
  assert.equal(shouldCloseOnScroll({ scroller: { contains: (node) => node === gone }, anchor: gone, start: at(0, 0), current: null }), true);
  // 解析不到锚点：只有页面级滚动才关，元素内滚动不关
  assert.equal(shouldCloseOnScroll({ scroller: unrelated, anchor: null, start: null, current: null }), false);
  assert.equal(shouldCloseOnScroll({ scroller: null, anchor: null, start: null, current: null }), true);
});

test("regression: Tab closes a menu from a menu item but moves focus normally inside an embedded form", () => {
  // 菜单项（或菜单本身）上的 Tab：关闭
  assert.equal(tabAction({ onMenuItem: true, index: 2, count: 6, shift: false }), "close");
  assert.equal(tabAction({ onMenuItem: false, index: -1, count: 6, shift: false }), "close");
  // 新建 worktree 表单：分支名(3) → 取消(4) → 创建(5)；中间的 Tab / Shift+Tab 放行，不丢已输入的分支名
  assert.equal(tabAction({ onMenuItem: false, index: 3, count: 6, shift: false }), "native");
  assert.equal(tabAction({ onMenuItem: false, index: 4, count: 6, shift: false }), "native");
  assert.equal(tabAction({ onMenuItem: false, index: 3, count: 6, shift: true }), "native");
  // 从菜单最后一个控件往后、第一个控件往前出去时才关闭
  assert.equal(tabAction({ onMenuItem: false, index: 5, count: 6, shift: false }), "close");
  assert.equal(tabAction({ onMenuItem: false, index: 0, count: 6, shift: true }), "close");
});

test("regression: the today/yesterday grouping is re-evaluated at the next local midnight", () => {
  const evening = new Date(2026, 6, 15, 21, 30, 0);
  assert.equal(localDayKey(evening), "2026-7-15");
  assert.equal(localDayKey(new Date(2026, 6, 16, 0, 0, 1)), "2026-7-16");
  const ms = msUntilNextLocalMidnight(evening);
  assert.equal(ms, 2.5 * 3600e3 + 250);
  assert.equal(localDayKey(new Date(evening.getTime() + ms)), "2026-7-16");
  // 午夜前一刻：定时器不会早于午夜；极端接近午夜也至少 1 秒，不空转
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 6, 15, 23, 59, 59, 999)), 1000);
  // 午夜之后同一份数据重新分组：昨天的会话从「今天」移到「昨天」
  const modified = at(2026, 7, 15, 21, 23);
  assert.equal(dayGroupOf(modified, evening), "today");
  assert.equal(dayGroupOf(modified, new Date(evening.getTime() + ms)), "yesterday");
  assert.equal(formatSessionTime(modified, new Date(evening.getTime() + ms)), "21:23");
});

// ───────── fixw2：删除确认路径比较 + 隐藏/恢复保留原始大小写 root ─────────
test("regression: the delete confirmation is a whole-path match that ignores Windows case and slash direction", () => {
  const root = "C:\\Users\\lop\\AppData\\Local\\pi-web-redesign\\qa-projects\\qa-f11-54650-renamed";
  // QA F11：注册表只剩小写 key，对话框显示全小写；用户按真实大小写输入时按钮一直禁用
  assert.equal(projectPathConfirmed(root, root.toLowerCase()), true);
  assert.equal(projectPathConfirmed(root.toLowerCase(), root), true);
  assert.equal(projectPathConfirmed(root.replace(/\\/g, "/"), root), true);
  assert.equal(projectPathConfirmed(root + "\\", root), true);
  assert.equal(projectPathConfirmed("  " + root + "  ", root), true);
  // 仍是整串确认：目录名、父目录、前缀、空串都不行
  assert.equal(projectPathConfirmed("qa-f11-54650-renamed", root), false);
  assert.equal(projectPathConfirmed("C:\\Users\\lop", root), false);
  assert.equal(projectPathConfirmed(root.slice(0, -1), root), false);
  assert.equal(projectPathConfirmed(root + "x", root), false);
  assert.equal(projectPathConfirmed("", root), false);
  assert.equal(projectPathConfirmed(root, ""), false);
  // UNC 路径同样不区分大小写；POSIX 路径区分
  assert.equal(projectPathConfirmed("\\\\NAS\\Share\\Proj", "//nas/share/proj"), true);
  assert.equal(projectPathConfirmed("/srv/App", "/srv/app"), false);
  assert.equal(projectPathConfirmed("/srv/app/", "/srv/app"), true);
});

test("regression: the path sent with a confirmed delete is the project's own root in native form, which the server compares exactly", () => {
  assert.equal(confirmPathFor("C:/Users/lop/Proj/"), "C:\\Users\\lop\\Proj");
  assert.equal(confirmPathFor("C:\\Users\\lop\\Proj"), "C:\\Users\\lop\\Proj");
  assert.equal(confirmPathFor("c:\\"), "c:\\");
  assert.equal(confirmPathFor("//nas/share/proj"), "\\\\nas\\share\\proj");
  assert.equal(confirmPathFor("/srv/app/"), "/srv/app");
});

test("regression: hiding a project remembers its original-case root so the hidden list and a later restore do not fall back to the lowercase registry key", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
  assert.equal(readRememberedRoots(storage).size, 0);
  rememberProjectRoot("c:\\users\\lop\\myproj", "C:\\Users\\lop\\MyProj", storage);
  rememberProjectRoot("c:\\users\\lop\\other", "C:\\Users\\lop\\Other", storage);
  assert.equal(readRememberedRoots(storage).get("c:\\users\\lop\\myproj"), "C:\\Users\\lop\\MyProj");
  forgetProjectRoot("c:\\users\\lop\\myproj", storage);
  assert.equal(readRememberedRoots(storage).has("c:\\users\\lop\\myproj"), false);
  assert.equal(readRememberedRoots(storage).get("c:\\users\\lop\\other"), "C:\\Users\\lop\\Other");
  // 存储损坏或不可用：当作没有，不抛
  store.set("pi-web:hidden-project-roots", "{not json");
  assert.equal(readRememberedRoots(storage).size, 0);
  assert.equal(readRememberedRoots(null).size, 0);
  assert.doesNotThrow(() => rememberProjectRoot("k", "R", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }));
});

// ───────── fixw2：归档视图头部计数是「当前项目」的，不是全局数 ─────────
const { archivedProjectCount, archiveEmptyMessage } = await jiti.import("./archive-count.ts");

test("regression: the archived view counts the selected project's archived conversations, not the global proxy count", () => {
  const family = (id, archived) => ({ root: { id, ...(archived ? { archived: true, archiveGroupId: id } : {}) }, subagents: [], latestModified: "2026-10-06T00:00:00Z" });
  // QA F13：全局 858 个归档，当前项目 0 个 → 列表是空的，头部也必须是 0
  assert.equal(archivedProjectCount([]), 0);
  assert.equal(archivedProjectCount([family("a", true), family("b", true), family("c", true)]), 3);
  // 视图刚切换、新列表还没到：屏幕上还是活动会话（没有 archived 标记）→ 未知，不把活动数当归档数
  assert.equal(archivedProjectCount([family("x"), family("y")]), null);
});

test("regression: an empty archive for this project says so and points at the other projects' total", () => {
  // 空态只在本项目 0 个时出现，所以全局数就是「其他项目」的数
  assert.equal(archiveEmptyMessage(858), "本项目没有归档，其他项目共 858 个");
  assert.equal(archiveEmptyMessage(0), "没有已归档的会话");
  assert.equal(archiveEmptyMessage(Number.NaN), "没有已归档的会话");
});
