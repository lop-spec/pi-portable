// 2026-11 界面合并（lop 11-08「把 GitHub 上最好看的 harness 的优点合并进 piweb，哪里要改就改、要大改就大改」）。
// 取自：cc-haha 的多任务标签栏、过程摘要与奶油暖色，Kun 的「继续任务」欢迎页，
// 并修掉线上的中文加粗失效与设置页对齐。全部放在整套叠加的最后一步：用锚点改最终文本、新文件走 assets/piweb-overlay/merge/；
// 任一锚点不唯一就整体拒绝（零写入），与其他叠加步骤一致。设计与取舍见 docs/piweb-ui-merge-20261108.md。
import { integrateSessionRuntime } from './patch-piweb-session-runtime.mjs';
export function integrateMerge({ get, set, change, prepend, template }) {
  // 1. 中文加粗：成对的 **…** 紧贴中文标点/汉字时 CommonMark 不认，补救同一文本节点内的成对星号。
  set('lib/portable-cjk-emphasis.mjs', template('merge/lib/portable-cjk-emphasis.mjs'));
  const markdown = 'lib/markdown.ts';
  prepend(markdown, 'import { portableCjkEmphasis } from "./portable-cjk-emphasis.mjs";\n');
  change(markdown, 'const chatRemarkPlugins: PluginList = [[remarkGfm, remarkGfmOptions], remarkMath];', 'const chatRemarkPlugins: PluginList = [[remarkGfm, remarkGfmOptions], remarkMath, portableCjkEmphasis];');
  change(markdown, 'const chatRemarkPluginsWithFrontmatter: PluginList = [[remarkFrontmatter, ["yaml"]], [remarkGfm, remarkGfmOptions], remarkMath];', 'const chatRemarkPluginsWithFrontmatter: PluginList = [[remarkFrontmatter, ["yaml"]], [remarkGfm, remarkGfmOptions], remarkMath, portableCjkEmphasis];');

  // 2. 样式：新增一个最后加载的样式文件，承载本步骤的所有新增与覆盖（只用既有 token）。
  set('app/merge.css', template('merge/app/merge.css') + '\n' + template('merge/app/sidebar-navigation.css'));
  change('app/layout.tsx', 'import "./craft-transcript.css";', 'import "./craft-transcript.css";\nimport "./merge.css";');

  // 3. 会话快照（标签栏、欢迎页共用）、继续任务推荐逻辑与两个视图组件；不再包含独立看板。
  set('lib/portable-session-resume.mjs', template('merge/lib/portable-session-resume.mjs'));
  set('lib/portable-session-store.ts', template('merge/lib/portable-session-store.ts'));
  set('components/SessionTabs.tsx', template('merge/components/SessionTabs.tsx'));
  set('components/WelcomeResume.tsx', template('merge/components/WelcomeResume.tsx'));

  // 4. AppShell：发布会话快照、响应「打开会话 / 新建会话」事件，顶栏下挂标签栏。
  const shell = 'components/AppShell.tsx';
  prepend(shell, 'import { SessionTabs } from "./SessionTabs";\nimport { NEW_SESSION_EVENT, OPEN_SESSION_EVENT, publishPortableSessions, useWindowEvent } from "@/lib/portable-session-store";\n');
  change(shell, '  const showPlaceholder = initialSessionRestored && !showChat;', `  const showPlaceholder = initialSessionRestored && !showChat;
  const portableDraftOpen = selectedSession === null && effectiveNewSessionCwd !== null;
  useEffect(() => {
    publishPortableSessions({ sessions: sessionsWithSelection, running: runningSessionIds, selectedId: selectedSession?.id ?? null, draftOpen: portableDraftOpen });
  }, [portableDraftOpen, runningSessionIds, selectedSession?.id, sessionsWithSelection]);
  useWindowEvent<CustomEvent<{ id: string }>>(OPEN_SESSION_EVENT, useCallback((event) => { void handleOpenSession(event.detail.id); }, [handleOpenSession]));
  useWindowEvent(NEW_SESSION_EVENT, useCallback(() => { void handleNewSession(\`tab-\${Date.now()}\`, activeCwd ?? ""); }, [activeCwd, handleNewSession]));`);
  change(shell, '        {isMobile && renderProjectTrustWarning(true)}', '        {isMobile && renderProjectTrustWarning(true)}\n        {!isMobile && <SessionTabs />}');
  // 顶部主标题显示用户最初的原始问题，而非自动生成或手动设置的会话名。
  change(shell, 'selectedSession.name?.trim() || selectedSession.firstMessage.split(/\\r?\\n/).find((line) => line.trim())?.trim()', 'selectedSession.firstMessage.replace(/\\s+/gu, " ").trim() || selectedSession.name?.trim()');

  // 5. 过程折叠行：不展开就能看出这一轮读了/改了/跑了什么，以及用时（取自 cc-haha）。
  set('lib/portable-timeline-summary.mjs', template('merge/lib/portable-timeline-summary.mjs'));
  const timeline = 'components/PortableProcessTimeline.tsx';
  prepend(timeline, 'import { timelineBreakdown } from "@/lib/portable-timeline-summary.mjs";\n');
  change(timeline, "  const active=activities.find(a=>a.id===selected);", "  const breakdown=summary?'':timelineBreakdown(activities,props.startedAt,end?.at);\n  const active=activities.find(a=>a.id===selected);");
  change(timeline, "<strong>{activities.length} 个步骤{summary?'':'已完成'}</strong>{summary&&<><span> · </span>{summary}</>}", "<strong>{activities.length} 个步骤{summary||breakdown?'':'已完成'}</strong>{summary?<><span> · </span>{summary}</>:breakdown?<><span> · </span>{breakdown}</>:null}");

  // 6. 主题「纸白」（取自 cc-haha 的奶油暖色）：加进主题列表、图标、三种语言词条，设置页每个主题带色块预览。
  change('lib/theme.ts', '  { id: "dark", label: "settings.themeDark" },', '  { id: "dark", label: "settings.themeDark" },\n  { id: "paper", label: "settings.themePaper" },');
  change('components/ThemeIcon.tsx', '  if (preference === "mist") {', `  if (preference === "paper") {
    return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>;
  }
  if (preference === "mist") {`);
  change('lib/i18n/messages/zh-CN.ts', '    "settings.themeDark": "深色",', '    "settings.themeDark": "深色",\n    "settings.themePaper": "纸白",');
  change('lib/i18n/messages/en.ts', '    "settings.themeDark": "Dark",', '    "settings.themeDark": "Dark",\n    "settings.themePaper": "Paper",');
  change('lib/i18n/messages/zh-TW.ts', '    "settings.themeDark": "深色",', '    "settings.themeDark": "深色",\n    "settings.themePaper": "紙白",');
  change('components/SettingsPanel.tsx', '                key={option.id}\n                className="settings-theme-option"', '                key={option.id}\n                className="settings-theme-option"\n                data-theme-choice={option.id}');

  // 7. 会话运行态图标和第二行时间由 Craft 模板提供；合并层只保留新回复高亮。
  const craft = 'components/CraftSessions.tsx';
  change(craft, "<span className=\"pw-craft-preview\">{props.unread.has(session.id) ? '有新回复 · ' : ''}{session.firstMessage.replace(/\\s+/g, ' ').trim() || '新对话'}</span>", "<span className=\"pw-craft-preview\">{props.unread.has(session.id) && <span className=\"pw-craft-new\">有新回复 · </span>}{session.firstMessage.replace(/\\s+/g, ' ').trim() || '新对话'}</span>");

  // 8. 状态菜单直接切换归档视图；现代侧栏不再构造重复的归档按钮。
  const tree = 'components/ProjectTree.tsx';
  change(tree, "const [filter, setFilter] = useState('all');", "const [filter, setFilter] = useState('todo');");
  change('components/SettingsPanel.tsx', '每天凌晨5点按月归档：归档上月及更早未更新的会话，跳过运行中会话；可在侧栏“归档”中恢复。', '每天凌晨 5 点（本机时间），归档超过 7 天未更新的会话；跳过运行中会话，可在侧栏“归档”中恢复。');
  change(tree, `    const control = document.querySelector<HTMLButtonElement>('button[data-pi-session-archive-control]');
    if (!control) { setNotice('归档组件未就绪，请刷新后重试'); return; }
    control.click();`, `    const event = new CustomEvent('pi-web:set-archive-view', { detail: { view: wantArchived ? 'archived' : 'active' }, cancelable: true });
    if (document.dispatchEvent(event)) setNotice('归档组件未就绪，请刷新后重试');`);
  change(tree, '<span data-pi-archive-slot="" />', '<span data-pi-archive-slot="" data-pi-status-navigation="" />');

  // 9. 全文搜索：按文件指纹缓存纯文本，侧栏空闲时预热；查询不再重复扫原始 JSONL。
  set('lib/session-search.ts', template('merge/lib/session-search.ts'));
  const searchRoute = 'app/api/sessions/search/route.ts';
  prepend(searchRoute, 'import { readFile } from "node:fs/promises";\nimport path from "node:path";\nimport { getAgentDir } from "@earendil-works/pi-coding-agent";\nimport { visibleSessionItems } from "@/lib/recent-tasks.mjs";\n');
  change(searchRoute, 'import { searchSessionContents } from "@/lib/session-search";', 'import { searchSessionContents, warmSessionSearch } from "@/lib/session-search";');
  change(searchRoute, 'export async function GET(request: Request) {', `async function readTestIds() {
  try {
    const data = JSON.parse(await readFile(path.join(getAgentDir(), "recent-test-sessions.json"), "utf8"));
    if (data.version !== 1 || !Array.isArray(data.ids) || data.ids.some((id: unknown) => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(id))) throw new Error("Invalid test session registry");
    return new Set<string>(data.ids);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw error;
  }
}

export async function GET(request: Request) {`);
  change(searchRoute, '    const sessions = query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];', `    const warming = new URL(request.url).searchParams.get("warm") === "1";
    const allSessions = (query || warming) && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    const sessions = visibleSessionItems(allSessions, allSessions.length ? await readTestIds() : new Set<string>());
    if (warming) { await warmSessionSearch(sessions); return NextResponse.json({ ready: true }, { headers }); }`);
  const searchComponent = 'components/SessionSearch.tsx';
  change(searchComponent, 'export function SessionSearch(', 'let searchWarmStarted = false;\n\nexport function SessionSearch(');
  change(searchComponent, '  const search = query.trim();', `  useEffect(() => {
    if (searchWarmStarted) return;
    const timer = setTimeout(() => {
      if (searchWarmStarted) return;
      searchWarmStarted = true;
      void fetch('/api/sessions/search?warm=1').catch(() => { searchWarmStarted = false; });
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
  const search = query.trim();`);
  change(searchComponent, '    }, 300);', '    }, 150);');
  change(searchComponent, '换个关键词试试；归档的会话需切到归档视图再搜。', '可搜标题和正文；空格分开多个关键词。');
  change(searchComponent, '只扫描了最近的部分会话，结果可能不完整。', '结果较多或部分文件未读完，可增加关键词缩小范围。');

  // 10. ChatWindow：空白新会话页，输入框下方列出「继续任务」。
  const chat = 'components/ChatWindow.tsx';
  change(chat, '<span style={{ fontSize: 11, color: "var(--text-muted)" }}>', '<span style={{ fontSize: 12, color: "var(--text-muted)" }}>', 2);
  prepend(chat, 'import { publishPortableSessions } from "@/lib/portable-session-store";\nimport { WelcomeResume } from "./WelcomeResume";\n');
  change(chat, '        <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />', '        <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />\n        {isEmptyNew && <WelcomeResume />}');
  // 消息数据就绪或用户继续提问时，把真实最新问题推给唯一标签；无需额外读取会话文件。
  change(chat, '  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;', `  const latestUserQuestion = inputHistory[inputHistory.length - 1];
  useEffect(() => {
    if (!session?.id || !latestUserQuestion) return;
    publishPortableSessions({ latestUserQuestion: {
      sessionId: session.id,
      text: latestUserQuestion.replace(/\\s+/gu, " ").trim(),
    } });
  }, [session?.id, latestUserQuestion]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;`);
  integrateSessionRuntime({ get, set, change, prepend, template });
}
