// Native source integration for physical projects and session relocation.
export function integrateProjects({ set, change, prepend, template }) {
  set('lib/portable-project-store.mjs', template('portable-project-store.mjs'));
  set('components/PortableProjects.tsx', template('PortableProjects.tsx'));
  set('app/api/projects/route.ts', template('portable-project-route.ts'));
  set('app/api/sessions/[id]/move/route.ts', template('portable-session-move-route.ts'));
  const list = 'app/api/sessions/route.ts', sidebar = 'components/SessionSidebar.tsx', rpc = 'lib/rpc-manager.ts';
  prepend(list, "import { ProjectStore } from '@/lib/portable-project-store.mjs';\nimport { getAgentDir } from '@earendil-works/pi-coding-agent';\nimport { join } from 'node:path';\n");
  change(list, '        sessions,\n        sessionListVersion,', "        sessions,\n        portableProjects: new ProjectStore(join(getAgentDir(), 'web-projects.json')).read(),\n        sessionListVersion,");
  prepend(sidebar, "import { CreateProjectButton, RemoveProjectButton, MoveSessionButton, visibleProjectList, projectRequest, type ProjectRegistry } from './PortableProjects';\n");
  change(sidebar, '  const [projectFilter, setProjectFilter] = useState("");', '  const [projectFilter, setProjectFilter] = useState("");\n  const [projectRegistry, setProjectRegistry] = useState<ProjectRegistry>({ projects: [], hidden: [] });');
  change(sidebar, '        sessions: SessionInfo[];\n        sessionListVersion: number;', '        sessions: SessionInfo[];\n        portableProjects: ProjectRegistry;\n        sessionListVersion: number;');
  change(sidebar, '      setAllSessions(data.sessions);', '      setAllSessions(data.sessions);\n      if (data.portableProjects) setProjectRegistry(data.portableProjects);\n      else console.error("[pi-web projects] server project registry missing; check package version");');
  change(sidebar, 'if (allSessions.length === 0 || skipInitialProjectSelection) return;', 'if (loading || skipInitialProjectSelection) return;');
  change(sidebar, 'const projects = getRecentProjects(allSessions);', 'const projects = visibleProjectList(getRecentProjects(allSessions), projectRegistry);');
  change(sidebar, '}, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);', '}, [allSessions, loading, projectRegistry, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);');
  change(sidebar, 'const recentProjects = getRecentProjects(allSessions);', 'const recentProjects = visibleProjectList(getRecentProjects(allSessions), projectRegistry);');
  change(sidebar, '      saveLastCustomCwd(data.cwd);', "      const registry = await projectRequest('/api/projects', { action: 'add', cwd: data.cwd });\n      setProjectRegistry(registry);\n      saveLastCustomCwd(data.cwd);");
  change(sidebar, '                {visibleProjects.map((project) => (\n                  <button\n                    key={project.key}', '                {visibleProjects.map((project) => (\n                  <div key={project.key} style={{ display: "flex", alignItems: "center" }}>\n                  <button');
  change(sidebar, '                    {showProjectActivity(projectActivity.get(project.key), t)}\n                  </button>', `                    {showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                  <RemoveProjectButton project={project} onRemoved={registry => {
                    setProjectRegistry(registry);
                    if (selectedProject?.key === project.key && !selectedSessionId) {
                      const next = visibleProjectList(getRecentProjects(allSessions), registry)[0];
                      setSelectedCwd(next?.root ?? null);
                    }
                  }} />
                  </div>`);
  change(sidebar, '              {/* Default cwd shortcut */}', `              <CreateProjectButton selectedCwd={selectedCwd} onCreated={(cwd, registry) => {
                setProjectRegistry(registry);
                setSelectedCwd(cwd);
                setDropdownOpen(false);
                saveLastCustomCwd(cwd);
              }} />
              {/* Default cwd shortcut */}`);
  change(sidebar, '                    onRenamed={loadSessions}', `                    onRenamed={loadSessions}
                    projects={recentProjects}
                    onMoved={info => { void loadSessions(false, true); handleSelectSessionFromList(info); }}`);
  change(sidebar, '  onRenamed,\n  onDeleted,', '  onRenamed,\n  projects,\n  onMoved,\n  onDeleted,');
  change(sidebar, '  onRenamed?: () => void;\n  onDeleted?: (id: string) => void;', '  onRenamed?: () => void;\n  projects: { key: string; root: string }[];\n  onMoved: (session: SessionInfo) => void;\n  onDeleted?: (id: string) => void;');
  change(sidebar, '          {/* Action buttons — shown on hover */}', '          {!session.transient && <MoveSessionButton session={session} projects={projects} disabled={Boolean(isRunning || session.relation?.kind === "subagent")} onMoved={onMoved} />}\n          {/* Action buttons — shown on hover */}');
  prepend(rpc, "import { assertSessionNotMoving } from '@/lib/portable-project-store.mjs';\n");
  change(rpc, '  async send(command: Record<string, unknown>): Promise<unknown> {', `  isBusyForProjectMove(): boolean {
    return this.isRunning() || this.activeMutatingCommands > 0 || Boolean(this.sessionReplacement);
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    assertSessionNotMoving(this.sessionId);`);
  change(rpc, '  const registry = getRegistry();\n  const locks = getLocks();', '  assertSessionNotMoving(sessionId);\n  const registry = getRegistry();\n  const locks = getLocks();');
  change(rpc, 'export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {', 'export function isRpcSessionStarting(sessionId: string): boolean { return getLocks().has(sessionId); }\n\nexport function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {');
  // Other in-memory tool-policy mutation paths must respect the same lock.
  change(rpc, '  const toolNames = validateSessionToolSelection(requestedToolNames);\n  const existing = getRpcSession(sessionId);', '  assertSessionNotMoving(sessionId);\n  const toolNames = validateSessionToolSelection(requestedToolNames);\n  const existing = getRpcSession(sessionId);');
}
