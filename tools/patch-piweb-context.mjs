// Element context actions use the official session-row event and existing archive path.
export function integrateContextActions({ get, set, change, prepend, template }) {
  set('components/PortableContextActions.tsx', template('PortableContextActions.tsx'));
  set('lib/portable-context-store.mjs', template('portable-context-store.mjs'));
  set('app/api/sessions/[id]/physical-delete/route.ts', template('portable-session-delete-route.ts'));
  const sidebar = 'components/SessionSidebar.tsx', rpc = 'lib/rpc-manager.ts';
  prepend(sidebar, "import { ProjectContextActions, SessionContextActions } from './PortableContextActions';\n");
  change(sidebar, 'CreateProjectButton, RemoveProjectButton, MoveSessionButton,', 'CreateProjectButton,');
  change(sidebar, '                  <div key={project.key} style={{ display: "flex", alignItems: "center" }}>\n                  <button', `                  <ProjectContextActions key={project.key} project={project} onChanged={(registry, removed) => {
                    setProjectRegistry(registry);
                    if (removed && selectedProject?.key === project.key && !selectedSessionId) {
                      setSelectedCwd(visibleProjectList(getRecentProjects(allSessions), registry)[0]?.root ?? null);
                    }
                  }}>
                  <button`);
  const removeStart = '                  <RemoveProjectButton project={project} onRemoved={registry => {';
  const removeEnd = '                  </div>';
  const source = get(sidebar), start = source.indexOf(removeStart), end = source.indexOf(removeEnd, start);
  if (start < 0 || end < start) throw new Error('project remove block missing');
  change(sidebar, source.slice(start, end + removeEnd.length), '                  </ProjectContextActions>');
  change(sidebar, 'text={displayCwd(project.root, homeDir)}', 'text={project.name || displayCwd(project.root, homeDir)}');
  change(sidebar, 'text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}', 'text={projectRegistry.projects.find(p => p.key === selectedProject?.key)?.name || displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}');
  change(sidebar, 'project.root.toLowerCase().includes(projectFilter.trim().toLowerCase())', '(project.root + " " + (project.name || "")).toLowerCase().includes(projectFilter.trim().toLowerCase())');
  change(sidebar, '          <button\n            onClick={() => setDropdownOpen((v) => !v)}', `          <ProjectContextActions project={selectedProject ? { ...selectedProject, name: projectRegistry.projects.find(p => p.key === selectedProject.key)?.name } : null} onChanged={(registry, removed) => { setProjectRegistry(registry); if (removed && !selectedSessionId) setSelectedCwd(visibleProjectList(getRecentProjects(allSessions), registry)[0]?.root ?? null); }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}`);
  change(sidebar, '          </button>\n\n          <AnimatedDropdown\n            open={dropdownOpen}', '          </button>\n          </ProjectContextActions>\n\n          <AnimatedDropdown\n            open={dropdownOpen}');
  change(sidebar, '          {!session.transient && <MoveSessionButton session={session} projects={projects} disabled={Boolean(isRunning || session.relation?.kind === "subagent")} onMoved={onMoved} />}', '          {!session.transient && <SessionContextActions session={session} projects={projects} isRunning={Boolean(isRunning)} onChanged={onRenamed} onMoved={onMoved} onDeleted={onDeleted} />}');
  const renameStart = '              <button\n                onClick={startRename}';
  const renameEnd = '              <button\n                onClick={handleDeleteClick}';
  const s = get(sidebar), a = s.indexOf(renameStart), b = s.indexOf(renameEnd, a);
  if (a < 0 || b < a) throw new Error('hover rename block missing');
  change(sidebar, s.slice(a, b), '');
  // Archive remains the sole hover shortcut, occupying a fixed 32px slot.
  change(sidebar, '{hovered && !session.transient && (', '{!session.transient && (');
  change(sidebar, '<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>\n              <button\n                onClick={handleDeleteClick}', '<div style={{ display: "flex", gap: 4, flexShrink: 0, visibility: hovered ? "visible" : "hidden" }}>\n              <button\n                onClick={handleDeleteClick}');
  change(sidebar, '                onClick={handleDeleteClick}\n                title=', '                onClick={handleDeleteClick}\n                disabled={Boolean(isRunning)}\n                title=');
  // All model start/send paths consult the same process-wide project deletion lock.
  prepend(rpc, "import { assertProjectAvailable, pathWithin } from '@/lib/portable-context-store.mjs';\n");
  change(rpc, '    assertSessionNotMoving(this.sessionId);', '    assertSessionNotMoving(this.sessionId);\n    assertProjectAvailable(this.cwd);');
  change(rpc, '  const sessionCwd = sessionManager.getCwd();', '  const sessionCwd = sessionManager.getCwd();\n  assertProjectAvailable(sessionCwd);');
  change(rpc, '  assertSessionNotMoving(sessionId);\n  const registry = getRegistry();', '  assertSessionNotMoving(sessionId);\n  assertProjectAvailable(cwd);\n  const registry = getRegistry();');
  change(rpc, 'export function hasBusyRpcSessionForCwd(cwd: string): boolean {', `export function hasBusyRpcSessionInProject(cwd: string): boolean {
  return [...getStartingSessionCwds().keys()].some(p => pathWithin(cwd, p))
    || [...getRegistry().values()].some(s => pathWithin(cwd, s.cwd) && s.isBusyForProjectMove());
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {`);
  // Rename uses the live manager when present, so it cannot clobber a running session.
  const route = 'app/api/sessions/[id]/route.ts';
  prepend(route, "import { projectMutationAllowed, assertSessionNotMoving } from '@/lib/portable-project-store.mjs';\n");
  change(route, '    const { name } = await req.json() as { name?: string };', `    if (!projectMutationAllowed(req)) { console.error('[pi-web rename] cross-origin request rejected'); return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 }); }
    assertSessionNotMoving(id);
    const { name } = await req.json() as { name?: string };`);
  change(route, '    const sm = SessionManager.open(filePath);\n    sm.appendSessionInfo(name.trim());', '    assertSessionNotMoving(id);\n    const sm = getRpcSession(id)?.inner.sessionManager ?? SessionManager.open(filePath);\n    sm.appendSessionInfo(name.trim());');
}
