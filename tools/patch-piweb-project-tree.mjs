// Applied last to source, not compiled assets. All creation and moves share the CLI core.
export function integrateProjectTree({ get, set, change, prepend, template }) {
  set('components/ProjectTree.tsx', template('ProjectTree.tsx'));
  set('lib/project-routing.mjs', template('project-routing.mjs'));
  set('lib/project-capacity.mjs', template('project-capacity.mjs'));
  set('app/api/project-routing/route.ts', template('project-routing-route.ts'));
  prepend('lib/rpc-manager.ts', 'import { monthlySessionDir } from "@/lib/project-routing.mjs";\n');
  change('lib/rpc-manager.ts', 'SessionManager.create(cwd, undefined)', 'SessionManager.create(cwd, monthlySessionDir(getAgentDir(), cwd))');
  set('app/redesign-sidebar.css', get('app/redesign-sidebar.css') + '\n' + template('project-tree.css'));
  change('components/SettingsPanel.tsx', '每天凌晨 5 点（本机时间），归档超过 7 天未更新的会话；跳过运行中会话，可在侧栏“归档”中恢复。', '每天凌晨5点按月归档：归档上月及更早未更新的会话，跳过运行中会话；可在侧栏“归档”中恢复。');
  const sidebar = 'components/SessionSidebar.tsx';
  prepend(sidebar, 'import { ProjectTree } from "./ProjectTree";\n');
  change(sidebar, 'root?.querySelector(".pw-sess-head")', 'root?.querySelector(".pw-tree-head")');
  const source = get(sidebar), a = source.indexOf('      <ProjectSwitcher\n'), b = source.indexOf('\n      {drawerCwd && (', a);
  if (a < 0 || b < a) throw new Error('Project tree sidebar anchor missing');
  change(sidebar, source.slice(a, b), `      <ProjectTree
        sessions={allSessions} projects={recentProjects} hiddenProjects={hiddenProjects} registry={projectRegistry}
        selectedSessionId={selectedSessionId} runningSessionIds={runningSessionIds} unreadSessionIds={unreadSessionIds}
        loading={loading} error={error} searchOpen={sessionSearchOpen} searchQuery={sessionSearchQuery}
        subagentGlyph={SUBAGENT_GLYPH} labelForSession={labelForSession}
        onSearchQueryChange={setSessionSearchQuery} onSearchClose={closeSearch} onSelect={handleSelectSessionFromList}
        onNewSession={handleNewSession} onRetry={retrySessions} onRenamed={reloadSessions} onMoved={handleMoved} onDeleted={handleDeleted}
        onRegistryChange={applyProjectChange} onCreated={handleProjectCreated}
      />
`);
  // New composers never inherit the currently selected folder, including keyboard shortcuts.
  change(sidebar, '    if (!selectedCwd) return;\n    // Generate a temporary UUID client-side', '    // Generate a temporary UUID client-side');
  change(sidebar, '    onNewSession?.(tempId, selectedCwd);', '    onNewSession?.(tempId, selectedCwd ?? "");');
  change(sidebar, '            disabled={!selectedCwd}', '            disabled={false}');
  change(sidebar, '      const projects = visibleProjectList(getRecentProjects(allSessions), projectRegistry);\n      if (projects.length > 0) setSelectedCwd(projects[0].root);', `      void fetch('/api/project-routing', { cache: 'no-store' }).then(r => r.json()).then(layout => {
        if (typeof layout.inbox === 'string') setSelectedCwd(previous => previous ?? layout.inbox);
      }).catch(error => console.error('[pi-project] inbox unavailable', error));`);
  change(sidebar, '  const projectSelection = useCallback', `  useEffect(() => {
    const current = allSessions.find(s => s.id === selectedSessionId);
    if (current && selectedCwdProp && current.cwd !== selectedCwdProp && !current.transient && !runningSessionIds.has(current.id)) {
      setSelectedCwd(current.cwd); onSelectSession(current, true);
    }
  }, [allSessions, selectedSessionId, selectedCwdProp, runningSessionIds, onSelectSession]);

  const projectSelection = useCallback`);
  change(sidebar, 'title={selectedCwd ? `${t("sidebar.newSessionTitle", { path: selectedCwd })}（Ctrl Alt N）` : t("sidebar.selectProject")}', 'title="新建未归属对话（Ctrl Alt N）"');
  const shell = 'components/AppShell.tsx';
  change(shell, '  const handleNewSession = useCallback((sessionId: string, cwd: string) => {', `  const handleNewSession = useCallback(async (sessionId: string, _cwd: string) => {
    const response = await fetch('/api/project-routing', { cache: 'no-store' });
    if (!response.ok) { console.error('[pi-project] inbox unavailable'); return; }
    const { inbox: cwd } = await response.json() as { inbox: string };`);
  // Initial welcome also uses the inbox; explicit URL cwd remains an explicit user choice.
  set('app/api/default-cwd/route.ts', `import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ensureInbox } from '@/lib/project-routing.mjs';
import { allowFileRoot } from '@/lib/file-access';
export async function POST() { const cwd = ensureInbox(getAgentDir()); allowFileRoot(cwd); return Response.json({ cwd }); }
export const GET = POST;
`);
  // Old menus target the same operation as the CLI, rather than the former header-only move.
  set('app/api/sessions/[id]/move/route.ts', `import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ProjectStore, projectKey, projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { POST as routeProject } from '@/app/api/project-routing/route';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!projectMutationAllowed(req)) return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  const { id } = await params, body = await req.json();
  const registry = new ProjectStore(path.join(getAgentDir(), 'web-projects.json')).read();
  const project = registry.projects.find((p: { key: string }) => p.key === projectKey(body.cwd));
  if (!project) return Response.json({ error: '请选择已整理的项目' }, { status: 400 });
  return routeProject(new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ action: 'move', id, project: project.name ?? path.basename(project.root) }) }));
}
`);
  // Assignment metadata separates project identity from automation execution cwd.
  const reader = 'lib/session-reader.ts';
  prepend(reader, 'import { sessionAssignments, pathAliases, indexedSessionPath } from "./project-routing.mjs";\n');
  change(reader, '  return sessions.map((session) => {\n    const project = session.cwd', '  const assigned = sessionAssignments(getAgentDir());\n  return sessions.map((session) => {\n    const project = session.cwd');
  change(reader, 'const projectRoot = project?.projectRoot ?? session.cwd;', 'const projectRoot = assigned[session.id]?.root ?? project?.projectRoot ?? session.cwd;');
  // Fork headers refer to original paths; resolve aliases for relationship identity, not content edits.
  change(reader, '  const originSessionId = scanned.parentSessionPath\n    ? pathToId.get(sessionPathKey(scanned.parentSessionPath))', '  const alias = scanned.parentSessionPath ? pathAliases(getAgentDir())[scanned.parentSessionPath] : null;\n  let parentPath = alias ?? scanned.parentSessionPath;\n  if (alias) { try { parentPath = indexedSessionPath(getAgentDir(), alias); } catch {} }\n  const originSessionId = scanned.parentSessionPath\n    ? pathToId.get(sessionPathKey(parentPath))');
  const projectRoute = 'app/api/projects/route.ts';
  prepend(projectRoute, 'import { POST as routeProject } from "@/app/api/project-routing/route";\nimport path from "node:path";\nimport { renameManagedProject } from "@/lib/project-routing.mjs";\nimport { isRpcSessionStarting } from "@/lib/rpc-manager";\n');
  change(projectRoute, '    registry.read(); // fail before filesystem changes if state is corrupt', `    registry.read(); // fail before filesystem changes if state is corrupt
    if (registry.read().managed && (body.action === 'create' || body.action === 'add')) return routeProject(new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ action: 'create', project: path.basename(cwd) }) }));`);
  change(projectRoute, 'if (hasBusyRpcSessionInProject(cwd) || hasBusyRpcSessionInProject(target))', 'if (hasBusyRpcSessionInProject(cwd) || hasBusyRpcSessionInProject(target) || ids.some(id => isRpcSessionStarting(id) || getRpcSession(id)?.isBusyForProjectMove()))');
  change(projectRoute, "if (body.action === 'rename') result = await renamePhysicalProject({ root: cwd, name: body.name, registry, sessions: affected, sessionRoot: join(getAgentDir(), 'sessions'), knownRoots, protectedRoots: [getAgentDir()] });", "if (body.action === 'rename') result = registry.read().managed ? await renameManagedProject({ agentDir: getAgentDir(), root: cwd, name: body.name, sessions: all }) : await renamePhysicalProject({ root: cwd, name: body.name, registry, sessions: affected, sessionRoot: join(getAgentDir(), 'sessions'), knownRoots, protectedRoots: [getAgentDir()] });");
  // Include preserved-cwd automations in busy checks and wrapper shutdown on a physical rename.
  change(projectRoute, 'const affected = all.filter(s => pathWithin(cwd, s.cwd));', 'const affected = all.filter(s => pathWithin(cwd, s.cwd) || s.projectRoot && projectIdentityKey(s.projectRoot) === projectIdentityKey(cwd));');
  change(projectRoute, '...registry.remove(cwd), deletedPath: cwd', '...registry.forget(cwd), deletedPath: cwd');
  const context = 'components/PortableContextActions.tsx';
  const menu = get(context), hideStart = menu.indexOf('      {hidden ? ('), hideEnd = menu.indexOf('      <div className="pw-menu-sep"', hideStart);
  if (hideStart < 0 || hideEnd < hideStart) throw new Error('Hide-project menu anchor missing');
  change(context, menu.slice(hideStart, hideEnd), '');
  change(context, '对话记录保留，可另行移动或删除。', '项目内仍有对话时禁止删除，请先移动或删除对话。');
  change(context, '保留全部历史、ID 和关联子代理，下次继续时在目标目录工作；不移动项目文件。', '会话 JSONL 物理移入目标项目，保留历史、图片、ID 和关联子代理；下次在目标目录继续。');
  const projects = 'components/PortableProjects.tsx';
  change(projects, 'export interface ProjectRegistry { projects:', 'export interface ProjectRegistry { inbox?: string; baseRoot?: string; managed?: boolean; projects:');
  change(projects, '    .filter(p => !registry.hidden.includes(p.key)).map', '    .filter(p => !registry.hidden.includes(p.key) && (!registry.managed || registry.projects.some(registered => registered.key === p.key))).map');
}
