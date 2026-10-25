"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo } from '@/lib/types';
import { listSessionFamilies } from '@/lib/session-family';
import { workspaceKeyOf } from '@/lib/workspace-memory';
import { SessionSearch } from './SessionSearch';
import { SessionContextActions, ProjectActionMenu, ProjectActionDialog, NoticeDialog, setProjectHidden, type ProjectActionKind } from './PortableContextActions';
import { projectRequest, type ProjectRegistry, type NamedProject } from './PortableProjects';
import { SessionRow } from './sidebar/SessionRow';
import { Icon } from './sidebar/icons';
import { anchorFromElement, type MenuAnchor } from './sidebar/PopMenu';
import { formatSessionDateTime, formatSessionTime } from './sidebar/session-time';
import { dispatchSessionRowContextMenu } from '@/lib/session-row-context-menu';

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
  const [folds, setFolds] = useState(readFolds), [more, setMore] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: NamedProject; anchor: MenuAnchor; element: HTMLElement } | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ project: NamedProject; kind: ProjectActionKind } | null>(null);
  const [creating, setCreating] = useState(false), [newName, setNewName] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const groups = useMemo(() => {
    const known = new Set(registry.projects.map(p => p.key));
    const loose = sessions.filter(s => !known.has(workspaceKeyOf(s)) && !registry.hidden.includes(workspaceKeyOf(s)));
    const result = projects.map(project => ({ project, families: listSessionFamilies(sessions.filter(s => workspaceKeyOf(s) === project.key)) }));
    return [{ project: { key: '__inbox', root: '', name: '未归属' }, families: listSessionFamilies(loose) }, ...result];
  }, [sessions, projects, registry]);
  const selectedGroup = groups.find(g => g.families.some(f => f.root.id === selectedSessionId || f.subagents.some(s => s.id === selectedSessionId)))?.project.key;
  useEffect(() => {
    if (!selectedGroup) return;
    setFolds(prev => { if (!prev.has(selectedGroup)) return prev; const next = new Set(prev); next.delete(selectedGroup); return next; });
    setMore(prev => new Set(prev).add(selectedGroup));
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
      if (html.dataset.piSessionArchiveView === 'archived' && !props.loading && !props.error) html.dataset.piSessionArchiveProjectCount = String(groups.reduce((sum, group) => sum + group.families.length, 0));
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
  const row = (session: SessionInfo, sub: boolean, family: ReturnType<typeof listSessionFamilies>[number]) => <SessionRow key={session.id}
    session={session} depth={sub ? 1 : 0} timeLabel={formatSessionTime(session.modified, new Date())} tooltipTime={formatSessionDateTime(session.modified, new Date())}
    isSelected={session.id === selectedSessionId} isRunning={[session, ...(!sub ? family.subagents : [])].some(s => runningSessionIds.has(s.id))}
    isUnread={[session, ...(!sub ? family.subagents : [])].some(s => unreadSessionIds.has(s.id))} subagentCount={sub ? 0 : family.subagents.length}
    expanded={children.has(session.id)} renaming={renaming === session.id} tabbable menuOpen={menuId === session.id} subagentGlyph={props.subagentGlyph}
    onSelect={id => { const s = byId.get(id); if (s) props.onSelect(s); }} onToggleFamily={id => setChildren(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; })}
    onOpenMenu={openMenu} onRenameCommit={(id, value) => void rename(id, value)} />;
  return <div className="pw-tree" ref={root}>
    <div className="pw-tree-head"><span>项目 <small>{registry.projects.length}/8</small></span><span data-pi-archive-slot="" /><button type="button" className="pw-icon-btn pw-icon-btn--sm" title={registry.projects.length >= 8 ? '已满8个，按新名称自动合并并重命名' : '新建项目'} aria-label="新建项目" onClick={() => setCreating(v => !v)}><Icon name="plus" /></button></div>
    {creating && <form className="pw-tree-create" onSubmit={e => { e.preventDefault(); void create(); }}><input className="pw-input" autoFocus aria-label="项目名称" placeholder={registry.projects.length >= 8 ? '合并后的准确名称' : '准确的项目名称'} maxLength={40} value={newName} onChange={e => setNewName(e.target.value)} /><button className="pw-btn pw-btn--sm" disabled={busy || !newName.trim()}>创建</button></form>}
    {props.searchOpen && <div className="pw-tree-search"><input ref={search} id="session-search-input" className="pw-input" type="search" placeholder="搜索所有会话…" aria-label="搜索所有会话" value={props.searchQuery} onChange={e => props.onSearchQueryChange(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') props.onSearchClose(); }} /><button className="pw-icon-btn" aria-label="关闭搜索" onClick={props.onSearchClose}><Icon name="close" /></button></div>}
    <SessionSearch open={props.searchOpen} query={props.searchQuery} selectedSessionId={selectedSessionId} onSelectSession={props.onSelect} labelForSession={props.labelForSession} />
    <nav className="pw-tree-scroll scrollbar-subtle" aria-label="项目与对话" hidden={props.searchOpen && Boolean(props.searchQuery.trim())} onKeyDown={e => {
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
        const members = families.flatMap(f => [f.root, ...f.subagents]);
        const running = members.some(s => runningSessionIds.has(s.id)), unread = members.some(s => unreadSessionIds.has(s.id));
        return <section className="pw-tree-project" key={project.key} data-project-key={project.key}>
          <div className="pw-tree-project-head"><button type="button" className="pw-tree-toggle" aria-expanded={!closed} aria-controls={`tree-${project.key}`} title={project.root || '新对话先在这里，首轮回复结束后自动归属'} onClick={() => toggle(project.key)}>
            <Icon name={closed ? 'right' : 'down'} size={12} /><Icon name="folder" size={15} /><span className="pw-truncate">{project.name ?? project.root.split(/[/\\]/).at(-1)}</span>
            {running ? <span className="pw-spinner pw-spinner--sm" role="status" aria-label="运行中" /> : unread ? <span className="pw-dot" title="有新回复" /> : null}<span className="pw-num">{count}</span>
          </button>{project.key !== '__inbox' && <button type="button" className="pw-icon-btn pw-icon-btn--sm pw-tree-more" aria-label={`${project.name ?? '项目'}操作`} title="项目操作" onClick={e => setProjectMenu({ project, anchor: anchorFromElement(e.currentTarget, { align: 'end' }), element: e.currentTarget })}><Icon name="more" /></button>}</div>
          {!closed && <div id={`tree-${project.key}`} className="pw-tree-children">
            {count === 0 && <p className="pw-tree-empty">{project.key === '__inbox' ? '新对话自动归属项目' : '暂无对话'}</p>}
            {(more.has(project.key) ? families : families.slice(0, 5)).map(family => <div key={family.root.id}>{row(family.root, false, family)}{children.has(family.root.id) && family.subagents.map(s => row(s, true, family))}</div>)}
            {count > 5 && <button className="pw-tree-show-more" type="button" onClick={() => setMore(prev => { const next = new Set(prev); next.has(project.key) ? next.delete(project.key) : next.add(project.key); return next; })}>{more.has(project.key) ? '收起对话' : `显示全部 ${count} 个`}</button>}
          </div>}
        </section>;
      })}
      {hiddenProjects.length > 0 && <><button className="pw-tree-show-more" type="button" aria-expanded={showHidden} onClick={() => setShowHidden(v => !v)}>已隐藏 · {hiddenProjects.length}</button>{showHidden && hiddenProjects.map(project => <div className="pw-tree-hidden" key={project.key}><span className="pw-truncate">{project.name ?? project.root.split(/[/\\]/).at(-1)}</span><button className="pw-btn pw-btn--sm" onClick={() => void setProjectHidden(project, false).then(next => props.onRegistryChange(next, null)).catch(e => setNotice(String(e)))}>恢复</button></div>)}</>}
    </nav>
    <SessionContextActions resolveSession={id => byId.get(id)} isRunning={id => runningSessionIds.has(id)} projects={projects} onRename={id => setRenaming(id)} onMenuChange={setMenuId} onMoved={props.onMoved} onDeleted={props.onDeleted} />
    {projectMenu && <ProjectActionMenu project={projectMenu.project} hidden={false} anchor={projectMenu.anchor} returnFocus={projectMenu.element} onClose={() => setProjectMenu(null)}
      onAction={kind => { setProjectDialog({ project: projectMenu.project, kind }); setProjectMenu(null); }} onHide={() => { const project = projectMenu.project; setProjectMenu(null); void setProjectHidden(project, true).then(next => props.onRegistryChange(next, project.key)).catch(e => setNotice(String(e))); }} onRestore={() => {}} />}
    {projectDialog && <ProjectActionDialog kind={projectDialog.kind} project={projectDialog.project} onClose={() => setProjectDialog(null)} onChanged={(next, removed) => props.onRegistryChange(next, removed ? projectDialog.project.key : null, projectDialog.kind === 'delete')} />}
    {notice && <NoticeDialog title="操作失败" message={notice} onClose={() => setNotice(null)} />}
  </div>;
}
