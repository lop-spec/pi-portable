"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo } from '@/lib/types';
import { listSessionFamilies } from '@/lib/session-family';
import { workspaceKeyOf } from '@/lib/workspace-memory';
import { RECENT_TASK_VISIBLE, recentTaskCandidates, recentTasks, sortProjectGroups } from '@/lib/recent-tasks.mjs';
import { SessionSearch } from './SessionSearch';
import { SessionContextActions, ProjectActionMenu, ProjectActionDialog, NoticeDialog, type ProjectActionKind } from './PortableContextActions';
import { projectRequest, type ProjectRegistry, type NamedProject } from './PortableProjects';
import { SessionRow } from './sidebar/SessionRow';
import { Icon } from './sidebar/icons';
import { anchorFromElement, type MenuAnchor } from './sidebar/PopMenu';
import { formatSessionDateTime, formatSessionTime } from './sidebar/session-time';
import { dispatchSessionRowContextMenu } from '@/lib/session-row-context-menu';
import { CraftSessionView, StatusButton, useSessionWorkflow } from './CraftSessions';

interface Props {
  sessions: SessionInfo[]; projects: NamedProject[]; hiddenProjects: NamedProject[]; registry: ProjectRegistry;
  selectedSessionId: string | null; runningSessionIds: ReadonlySet<string>; unreadSessionIds: ReadonlySet<string>;
  loading: boolean; error: string | null; searchOpen: boolean; searchQuery: string; subagentGlyph: ReactNode;
  labelForSession: (session: SessionInfo) => string;
  onSearchQueryChange: (query: string) => void; onSearchClose: () => void;
  onSelect: (session: SessionInfo, entryId?: string, blockIndex?: number) => void; onNewSession: () => void;
  onRenamed: () => void; onMoved: (info: SessionInfo) => void; onDeleted: (id: string) => void; onRetry: () => void;
  onRegistryChange: (registry: ProjectRegistry, removedKey: string | null, deleted?: boolean) => void;
  onCreated: (cwd: string, registry: ProjectRegistry) => void;
}
const foldKey = 'pi-web:project-tree-folds';
function readFolds(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(foldKey) ?? '[]')); } catch { return new Set(); } }
export function ProjectTree(props: Props) {
  const { sessions, projects, hiddenProjects, registry, selectedSessionId, runningSessionIds, unreadSessionIds } = props;
  const [mode, setMode] = useState<'status' | 'project'>('status');
  const [filter, setFilter] = useState('all');
  const workflow = useSessionWorkflow();
  const [folds, setFolds] = useState(readFolds), [more, setMore] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: NamedProject; anchor: MenuAnchor; element: HTMLElement } | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ project: NamedProject; kind: ProjectActionKind } | null>(null);
  const [creating, setCreating] = useState(false), [newName, setNewName] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [clock, setClock] = useState(() => Date.now()), [replyTimes, setReplyTimes] = useState<Record<string, string | null>>({}), [recentError, setRecentError] = useState(false);
  const [recentArchive, setRecentArchive] = useState<{ sessions: SessionInfo[]; replies: Record<string, string | null>; testIds: string[] | null }>({ sessions: [], replies: {}, testIds: null }), [archiveError, setArchiveError] = useState(false), [archiveView, setArchiveView] = useState(false);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/session-reply-times', { cache: 'no-store', signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('recent archive unavailable'); return response.json(); })
      .then(data => { if (!Array.isArray(data.testSessionIds)) throw new Error('test session registry unavailable'); setRecentArchive({ sessions: data.sessions ?? [], replies: data.replies ?? {}, testIds: data.testSessionIds }); setArchiveError(Boolean(data.incomplete)); })
      .catch(error => { if (error.name !== 'AbortError') setArchiveError(true); });
    return () => controller.abort();
  }, [clock]);
  const byId = useMemo(() => new Map([...recentArchive.sessions, ...sessions].map(s => [s.id, s])), [sessions, recentArchive]);
  const allFamilies = useMemo(() => listSessionFamilies([...byId.values()]), [byId]);
  const allReplies = useMemo(() => ({ ...recentArchive.replies, ...replyTimes }), [recentArchive, replyTimes]);
  const testIds = useMemo(() => new Set(recentArchive.testIds ?? []), [recentArchive.testIds]);
  const recentCandidates = recentArchive.testIds === null ? [] : recentTaskCandidates(allFamilies, runningSessionIds, clock, testIds);
  const candidateKey = recentCandidates.map(f => `${f.root.id}:${f.root.modified}`).sort().join('|');
  useEffect(() => {
    const ids = candidateKey ? candidateKey.split('|').map(item => item.split(':', 1)[0]) : [];
    if (!ids.length) { setReplyTimes({}); setRecentError(false); return; }
    const controller = new AbortController();
    const batches = Array.from({ length: Math.ceil(ids.length / 200) }, (_, index) => ids.slice(index * 200, index * 200 + 200));
    void Promise.all(batches.map(batch => fetch('/api/session-reply-times', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch }), signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('reply times unavailable'); return response.json(); })))
      .then(data => { setReplyTimes(Object.assign({}, ...data.map(item => item.replies ?? {}))); setRecentError(data.some(item => item.incomplete)); })
      .catch(error => { if (error.name !== 'AbortError') setRecentError(true); });
    return () => controller.abort();
  }, [candidateKey, clock]);
  const groups = useMemo(() => {
    const recent = recentArchive.testIds === null ? [] : recentTasks(allFamilies, runningSessionIds, allReplies, clock, testIds);
    const archivedIds = new Set(recentArchive.sessions.map(s => s.id));
    const result = projects.map(project => ({ project, families: listSessionFamilies(sessions.filter(s => (archiveView || !archivedIds.has(s.id)) && workspaceKeyOf(s) === project.key)) }));
    return [{ project: { key: '__inbox', root: '', name: '最近任务' }, families: recent }, ...sortProjectGroups(result, allReplies)];
  }, [sessions, projects, allFamilies, runningSessionIds, allReplies, recentArchive, archiveView, clock, testIds]);
  const selectedGroup = groups.find(g => g.families.some(f => f.root.id === selectedSessionId || f.subagents.some(s => s.id === selectedSessionId)))?.project.key;
  useEffect(() => {
    if (!selectedGroup) return;
    setFolds(prev => { if (!prev.has(selectedGroup)) return prev; const next = new Set(prev); next.delete(selectedGroup); return next; });
    if (selectedGroup !== '__inbox') setMore(prev => new Set(prev).add(selectedGroup));
  }, [selectedGroup, selectedSessionId]);
  useEffect(() => { if (props.searchOpen) search.current?.focus(); }, [props.searchOpen]);
  useEffect(() => {
    if (!selectedSessionId) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector(`[data-pi-session-id="${CSS.escape(selectedSessionId)}"]`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selectedSessionId, selectedGroup]);
  useEffect(() => {
    const update = () => {
      const html = document.documentElement;
      setArchiveView(html.dataset.piSessionArchiveView === 'archived');
      if (html.dataset.piSessionArchiveView === 'archived' && !props.loading && !props.error) html.dataset.piSessionArchiveProjectCount = String(new Set(groups.flatMap(group => group.families.map(f => f.root.id))).size);
      else delete html.dataset.piSessionArchiveProjectCount;
      document.dispatchEvent(new Event('pi-web:archive-project-count'));
    };
    update(); const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-pi-session-archive-view'] });
    return () => observer.disconnect();
  }, [groups, props.loading, props.error]);
  const toggle = (key: string) => setFolds(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); try { localStorage.setItem(foldKey, JSON.stringify([...next])); } catch {} return next; });
  const openMenu = (id: string, point: { x: number; y: number } | null) => {
    const session = byId.get(id); if (!session) return;
    const row = root.current?.querySelector(`[data-pi-session-id="${CSS.escape(id)}"]`), rect = row?.getBoundingClientRect();
    dispatchSessionRowContextMenu({ id, path: session.path, cwd: session.cwd, name: session.name,
      clientX: point?.x ?? (rect?.left ?? 0) + 20, clientY: point?.y ?? rect?.bottom ?? 0, refresh: props.onRenamed });
  };
  const rename = async (id: string, value: string | null) => {
    setRenaming(null); if (value === null) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value.trim() }) });
      if (!res.ok) throw new Error('会话改名失败');
      props.onRenamed();
    } catch (error) { setNotice(String(error)); }
  };
  const create = async () => {
    if (busy || !newName.trim()) return;
    setBusy(true);
    try { const data = await projectRequest('/api/project-routing', { action: 'create', project: newName }); props.onCreated(data.cwd, data); setCreating(false); setNewName(''); }
    catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  const changeArchiveView = (wantArchived: boolean) => {
    const current = document.documentElement.dataset.piSessionArchiveView === 'archived';
    if (current === wantArchived) return;
    const control = document.querySelector<HTMLButtonElement>('button[data-pi-session-archive-control]');
    if (!control) { setNotice('归档组件未就绪，请刷新后重试'); return; }
    control.click();
  };
  const changeArchive = async (id: string, archived: boolean) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/${archived ? 'restore' : 'archive'}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || '归档操作失败');
      document.dispatchEvent(new Event('pi-web:refresh-sessions'));
      setClock(Date.now());
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const row = (session: SessionInfo, sub: boolean, family: ReturnType<typeof listSessionFamilies>[number], recent = false) => <div className="pw-project-session" key={session.id} data-session-id={session.id}>{!sub && <StatusButton id={session.id} records={workflow.records} onSave={workflow.save} archived={archiveView || recentArchive.sessions.some(s => s.id === session.id)} onArchive={(id, archived) => void changeArchive(id, archived)} disabled={session.transient} />}<SessionRow
    session={session} depth={sub ? 1 : 0} timeLabel={formatSessionTime(recent ? allReplies[session.id] ?? session.modified : session.modified, new Date())} tooltipTime={formatSessionDateTime(recent ? allReplies[session.id] ?? session.modified : session.modified, new Date())}
    isSelected={session.id === selectedSessionId} isRunning={[session, ...(!sub ? family.subagents : [])].some(s => runningSessionIds.has(s.id))}
    isUnread={[session, ...(!sub ? family.subagents : [])].some(s => unreadSessionIds.has(s.id))} subagentCount={sub ? 0 : family.subagents.length}
    expanded={children.has(session.id)} renaming={renaming === session.id} tabbable menuOpen={menuId === session.id} subagentGlyph={props.subagentGlyph}
    onSelect={id => { const s = byId.get(id); if (s) props.onSelect(s); }} onToggleFamily={id => setChildren(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; })}
    onOpenMenu={openMenu} onRenameCommit={(id, value) => void rename(id, value)} /></div>;
  return <div className={`pw-tree${mode === 'status' ? ' pw-tree-status' : ''}`} ref={root}>
    <div className="pw-tree-head"><div className="pw-craft-modes" role="group" aria-label="会话视图"><button type="button" aria-pressed={mode === 'status'} onClick={() => setMode('status')}>状态</button><button type="button" aria-pressed={mode === 'project'} onClick={() => setMode('project')}>项目 <small>{registry.projects.length}/8</small></button></div><span data-pi-archive-slot="" /><button type="button" className="pw-icon-btn pw-icon-btn--sm" title={registry.projects.length >= 8 ? '已满8个，按新名称自动合并并重命名' : '新建项目'} aria-label="新建项目" onClick={() => { setMode('project'); setCreating(v => !v); }}><Icon name="plus" /></button></div>
    {workflow.error && <div role="alert" className="pw-craft-error">{workflow.error} <button type="button" onClick={() => void workflow.reload()}>重试</button></div>}
    {creating && <form className="pw-tree-create" onSubmit={e => { e.preventDefault(); void create(); }}><input className="pw-input" autoFocus aria-label="项目名称" placeholder={registry.projects.length >= 8 ? '合并后的准确名称' : '准确的项目名称'} maxLength={40} value={newName} onChange={e => setNewName(e.target.value)} /><button className="pw-btn pw-btn--sm" disabled={busy || !newName.trim()}>创建</button></form>}
    {props.searchOpen && <div className="pw-tree-search"><input ref={search} id="session-search-input" className="pw-input" type="search" placeholder="搜索所有会话…" aria-label="搜索所有会话" value={props.searchQuery} onChange={e => props.onSearchQueryChange(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') props.onSearchClose(); }} /><button className="pw-icon-btn" aria-label="关闭搜索" onClick={props.onSearchClose}><Icon name="close" /></button></div>}
    <SessionSearch open={props.searchOpen} query={props.searchQuery} selectedSessionId={selectedSessionId} onSelectSession={props.onSelect} labelForSession={props.labelForSession} />
    {mode === 'status' && !(props.searchOpen && Boolean(props.searchQuery.trim())) && <CraftSessionView sessions={sessions} records={workflow.records} selectedSessionId={selectedSessionId} running={runningSessionIds} unread={unreadSessionIds} archived={archiveView} filter={filter} onFilter={setFilter} onArchiveView={changeArchiveView} onSelect={props.onSelect} onSave={workflow.save} onArchive={(id, archived) => void changeArchive(id, archived)} onMenu={openMenu} />}
    <nav className="pw-tree-scroll scrollbar-subtle" aria-label="项目与对话" hidden={mode !== 'project' || (props.searchOpen && Boolean(props.searchQuery.trim()))} onKeyDown={e => {
      if (e.key === 'F2') {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-pi-session-id]')?.dataset.piSessionId;
        if (id) { e.preventDefault(); setRenaming(id); } return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('.pw-tree-toggle,.pw-sess-main') ?? [])];
      const index = buttons.indexOf(e.target as HTMLButtonElement); if (index < 0) return; e.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }}>
      {props.error && <div role="alert" className="pw-sess-state"><p>{props.error}</p><button className="pw-btn" onClick={props.onRetry}>重试</button></div>}
      {props.loading && sessions.length === 0 && <div className="pw-sess-state" role="status">正在加载项目…</div>}
      {groups.map(({ project, families }) => {
        const closed = folds.has(project.key), count = families.length;
        const ordered = project.key === '__inbox' ? families : [...families].sort((a, b) => Date.parse(b.latestModified) - Date.parse(a.latestModified));
        const members = families.flatMap(f => [f.root, ...f.subagents]);
        const running = members.some(s => runningSessionIds.has(s.id)), unread = members.some(s => unreadSessionIds.has(s.id));
        return <section className="pw-tree-project" key={project.key} data-project-key={project.key}>
          <div className="pw-tree-project-head"><button type="button" className="pw-tree-toggle" aria-expanded={!closed} aria-controls={`tree-${project.key}`} title={project.root || '按最近回复排序的10个对话'} onClick={() => toggle(project.key)}>
            <Icon name={closed ? 'right' : 'down'} size={12} /><Icon name="folder" size={15} /><span className="pw-truncate">{project.name ?? project.root.split(/[/\\]/).at(-1)}</span>
            {running ? <span className="pw-spinner pw-spinner--sm" role="status" aria-label="运行中" /> : unread ? <span className="pw-dot" title="有新回复" /> : null}<span className="pw-num">{count}</span>
          </button>{project.key !== '__inbox' && <button type="button" className="pw-icon-btn pw-icon-btn--sm pw-tree-more" aria-label={`${project.name ?? '项目'}操作`} title="项目操作" onClick={e => setProjectMenu({ project, anchor: anchorFromElement(e.currentTarget, { align: 'end' }), element: e.currentTarget })}><Icon name="more" /></button>}</div>
          {!closed && <div id={`tree-${project.key}`} className="pw-tree-children">
            {project.key === '__inbox' && (recentError || archiveError) && <p className="pw-tree-empty" role="alert">最近回复时间加载不完整</p>}
            {count === 0 && <p className="pw-tree-empty">{project.key === '__inbox' ? '最近暂无任务' : '暂无对话'}</p>}
            {(more.has(project.key) ? ordered : ordered.slice(0, RECENT_TASK_VISIBLE)).map(family => <div key={family.root.id}>{row(family.root, false, family, project.key === '__inbox')}{children.has(family.root.id) && family.subagents.map(s => row(s, true, family, project.key === '__inbox'))}</div>)}
            {count > RECENT_TASK_VISIBLE && <button className="pw-tree-show-more" type="button" aria-expanded={more.has(project.key)} onClick={() => setMore(prev => { const next = new Set(prev); next.has(project.key) ? next.delete(project.key) : next.add(project.key); return next; })}>{more.has(project.key) ? '收起对话' : `显示全部 ${count} 个`}</button>}
          </div>}
        </section>;
      })}
    </nav>
    <SessionContextActions resolveSession={id => byId.get(id)} isRunning={id => runningSessionIds.has(id)} projects={projects} onRename={id => setRenaming(id)} onMenuChange={setMenuId} onMoved={props.onMoved} onDeleted={props.onDeleted} />
    {projectMenu && <ProjectActionMenu project={projectMenu.project} hidden={false} anchor={projectMenu.anchor} returnFocus={projectMenu.element} onClose={() => setProjectMenu(null)}
      onAction={kind => { setProjectDialog({ project: projectMenu.project, kind }); setProjectMenu(null); }} onHide={() => {}} onRestore={() => {}} />}
    {projectDialog && <ProjectActionDialog kind={projectDialog.kind} project={projectDialog.project} onClose={() => setProjectDialog(null)} onChanged={(next, removed) => props.onRegistryChange(next, removed ? projectDialog.project.key : null, projectDialog.kind === 'delete')} />}
    {notice && <NoticeDialog title="操作失败" message={notice} onClose={() => setNotice(null)} />}
  </div>;
}
