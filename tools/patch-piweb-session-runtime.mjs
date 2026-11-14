// Final source-only stage: preserve every earlier stage's pinned output.
export function integrateSessionRuntime({get, set, change, prepend, template}) {
  set('components/CraftSessions.tsx', template('session-runtime/CraftSessions.tsx'));
  set('lib/craft-session/model.mjs', template('session-runtime/model.mjs'));
  change('app/redesign-sidebar.css', template('craft-session/craft-session.css').trim(), template('session-runtime/craft-session.css').trim());
  change('components/CraftSessions.tsx', "{props.unread.has(session.id) ? '有新回复 · ' : ''}", "{props.unread.has(session.id) && <span className=\"pw-craft-new\">有新回复 · </span>}");

  change('lib/types.ts', 'export interface SessionInfo {', `export interface SessionInfo {
  /** Last persisted execution result; never a manual workflow classification. */
  runtimeOutcome?: 'idle' | 'awaiting' | 'asking' | 'completed' | 'stopped' | 'failed';`);
  change('lib/session-reader.ts', 'import { listSessionsIncremental, type ScannedSessionInfo }', 'import { listSessionsIncremental, getScannedRuntimeOutcome, type ScannedSessionInfo }');
  change('lib/session-reader.ts', '    transient: false,', '    transient: false,\n    runtimeOutcome: getScannedRuntimeOutcome(scanned.path),');

  // This is the same request map used to replay the actual option/input dialog.
  // Never infer an unanswered question from the last persisted tool call.
  change('lib/rpc-manager.ts', '  hasSuppressedCompletionNotifications(): boolean {', `  hasPendingUserQuestion(): boolean {
    return this.isAlive() && [...this.pendingUiRequests.values()].some(request =>
      ['select', 'confirm', 'input', 'editor', 'custom'].includes(String(request.method)) && request.closed !== true);
  }

  hasSuppressedCompletionNotifications(): boolean {`);
  change('lib/rpc-manager.ts', 'export function getRunningRpcSessionIds(): string[] {', `export function getAskingRpcSessionIds(): string[] {
  return [...getRegistry()].filter(([, session]) => session.hasPendingUserQuestion())
    .map(([id, session]) => session.sessionId || id);
}

export function getRunningRpcSessionIds(): string[] {`);
  change('lib/rpc-manager-extension-ui.test.mjs', '    agent: { state: {}, abort() {} },', '    agent: { state: { tools: [] }, abort() {} },\n    clearQueue() {},');
  change('lib/rpc-manager-extension-ui.test.mjs', '    assert.equal(wrapper.isRunning(), true);', '    assert.equal(wrapper.isRunning(), true);\n    assert.equal(wrapper.hasPendingUserQuestion(), true);');
  change('lib/rpc-manager-extension-ui.test.mjs', '    assert.equal(wrapper.isRunning(), false);', '    assert.equal(wrapper.isRunning(), false);\n    assert.equal(wrapper.hasPendingUserQuestion(), false);');
  change('lib/rpc-manager-extension-ui.test.mjs', '    assert.equal(continued, true);', '    assert.equal(continued, true);\n    assert.equal(wrapper.hasPendingUserQuestion(), false);');
  change('app/api/agent/running/route.ts', '  getRunningRpcSessionIds,', '  getRunningRpcSessionIds,\n  getAskingRpcSessionIds,');
  change('app/api/agent/running/route.ts', '      runningSessionIds: getRunningRpcSessionIds(),', '      runningSessionIds: getRunningRpcSessionIds(),\n      askingSessionIds: getAskingRpcSessionIds(),');
  const sidebar='components/SessionSidebar.tsx';
  change(sidebar, '  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());', '  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());\n  const [askingSessionIds, setAskingSessionIds] = useState<Set<string>>(() => new Set());');
  change(sidebar, '          runningSessionIds?: string[];', '          runningSessionIds?: string[];\n          askingSessionIds?: string[];');
  change(sidebar, '        runningPollAuthoritativeRef.current = true;', '        runningPollAuthoritativeRef.current = true;\n        setAskingSessionIds(previous => {\n          const next = data.askingSessionIds ?? [];\n          return previous.size === next.length && next.every(id => previous.has(id)) ? previous : new Set(next);\n        });');
  change(sidebar, 'selectedSessionId={selectedSessionId} runningSessionIds={runningSessionIds} unreadSessionIds={unreadSessionIds}', 'selectedSessionId={selectedSessionId} runningSessionIds={runningSessionIds} askingSessionIds={askingSessionIds} unreadSessionIds={unreadSessionIds}');
  const tree='components/ProjectTree.tsx';
  change(tree, 'WorkflowFilters, useSessionWorkflow }', 'WorkflowFilters, useSessionWorkflow, runtimeForSession }');
  change(tree, 'selectedSessionId: string | null; runningSessionIds: ReadonlySet<string>; unreadSessionIds:', 'selectedSessionId: string | null; runningSessionIds: ReadonlySet<string>; askingSessionIds: ReadonlySet<string>; unreadSessionIds:');
  change(tree, 'disabled={session.transient} />}<SessionRow', 'disabled={session.transient} runtimeState={runtimeForSession(session, runningSessionIds, props.askingSessionIds)} />}<SessionRow');
  change(tree, '    session={session} depth={sub ? 1 : 0}', '    runtimeState={runtimeForSession(session, runningSessionIds, props.askingSessionIds)}\n    session={session} depth={sub ? 1 : 0}');
  change(tree, 'running={runningSessionIds} unread={unreadSessionIds}', 'running={runningSessionIds} asking={props.askingSessionIds} unread={unreadSessionIds}');

  // Project rows share the same runtime circle; time lives on the secondary
  // line instead of reserving a permanently blank title-end column.
  const row='components/sidebar/SessionRow.tsx';
  prepend(row, 'import { RuntimeGlyph } from "../CraftSessions";\n');
  change(row, '  isRunning: boolean;', '  isRunning: boolean;\n  runtimeState?: string;');
  change(row, '  isRunning,\n  isUnread,', '  isRunning,\n  runtimeState,\n  isUnread,');
  change(row, '      {isSub && <span className="pw-sess-sub-ico"', '      {runtimeState && isSub && <span className="pw-project-runtime" data-runtime-state={runtimeState} title={`子会话：${runtimeState}`} aria-label={`子会话：${runtimeState}`}><RuntimeGlyph state={runtimeState}/></span>}\n      {isSub && !runtimeState && <span className="pw-sess-sub-ico"');
  change(row, '          <span className="pw-sess-title">{title}</span>', `          <span className="pw-sess-title">{title}</span>
          {runtimeState && <span className="pw-project-secondary"><span className="pw-project-preview">{displayFirstMessage.replace(/\\s+/g, ' ').trim() || '新对话'}</span><span className="pw-sess-time">{timeLabel}</span></span>}`);
  change(row, '      {!renaming && (\n        <span className="pw-sess-end">', '      {!renaming && !runtimeState && (\n        <span className="pw-sess-end">');
  set('app/redesign-sidebar.css', get('app/redesign-sidebar.css') + `
.pw-project-session .pw-sess-row{height:auto;min-height:48px;padding-right:0}
.pw-project-session .pw-sess-main{display:flex;flex-direction:column;align-items:stretch;gap:2px;min-width:0;padding-right:0}
.pw-project-session .pw-sess-title{display:block;flex:none;min-width:0}
.pw-project-secondary{display:flex;gap:6px;align-items:center;min-width:0;font-size:12px;color:var(--text-muted)}
.pw-project-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pw-project-secondary .pw-sess-time{flex:none;display:inline;white-space:nowrap}
.pw-project-session:hover .pw-sess-title,.pw-project-session:focus-within .pw-sess-title{padding-right:28px}
.pw-project-runtime{display:grid;place-items:center;width:20px;flex:none}
@media(pointer:coarse),(max-width:640px){.pw-project-session .pw-sess-title{padding-right:28px}}
`);
}
