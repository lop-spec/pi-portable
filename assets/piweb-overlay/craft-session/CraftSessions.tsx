"use client";
// Session workflow interaction adapted from Craft Agents (Apache-2.0, a883d64).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '@/lib/types';
import { STATUSES, statusOf, isFlagged, groupedSessions } from '@/lib/craft-session/model.mjs';
import { PopMenu, anchorFromElement, type MenuAnchor } from './sidebar/PopMenu';
import { deriveSessionTitle } from './sidebar/session-title';
import { formatSessionTime } from './sidebar/session-time';

export type StatusId = 'backlog' | 'todo' | 'needs-review' | 'done' | 'cancelled';
type RecordValue = { status: StatusId; flagged: boolean };
type Records = Record<string, RecordValue>;
type StatusPatch = { status?: StatusId; flagged?: boolean };

export function useSessionWorkflow() {
  const [records, setRecords] = useState<Records>({});
  const [error, setError] = useState('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const load = useCallback(async () => {
    try {
      await queue.current;
      const current = ++revision.current;
      const response = await fetch('/api/session-status', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.sessions || typeof data.sessions !== 'object') throw new Error(data.error || '会话状态读取失败');
      if (revision.current === current) { setRecords(data.sessions); setError(''); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '会话状态读取失败'); }
  }, []);
  useEffect(() => {
    void load();
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('pi-web-session-workflow');
      channel.current.onmessage = () => { void load(); };
    }
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { channel.current?.close(); channel.current = null; document.removeEventListener('visibilitychange', visible); };
  }, [load]);
  const save = useCallback((id: string, patch: StatusPatch) => {
    ++revision.current;
    const task = queue.current.then(async () => {
      const response = await fetch('/api/session-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, patch }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '会话状态保存失败');
      setRecords(data.sessions); setError(''); channel.current?.postMessage('changed');
    });
    queue.current = task.catch(cause => { setError(cause instanceof Error ? cause.message : '会话状态保存失败'); });
    return task;
  }, []);
  return { records, error, save, reload: load };
}

export function StatusGlyph({ status }: { status: string }) {
  return <svg className={`pw-craft-glyph status-${status}`} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    {status === 'done' || status === 'cancelled' ? <><circle cx="12" cy="12" r="10" fill="currentColor"/>{status === 'done' ? <path d="M8 12l3 3 5-5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/> : <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"/>}</> : <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={status === 'backlog' ? '6 5' : undefined}/>{status === 'needs-review' && <circle cx="12" cy="12" r="3" fill="currentColor"/>}</>}
  </svg>;
}
export function FlagGlyph() { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4m0 0c5-3 9 3 14 0v10c-5 3-9-3-14 0"/></svg>; }
function ArchiveGlyph() { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h18v13H3zM2 3h20v5H2zM9 12h6"/></svg>; }

export function StatusButton({ id, records, onSave, archived, onArchive, disabled }: { id: string; records: Records; onSave: (id: string, patch: StatusPatch) => Promise<void>; archived: boolean; onArchive: (id: string, archived: boolean) => void; disabled?: boolean }) {
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; element: HTMLElement } | null>(null);
  const [filter, setFilter] = useState('');
  const status = statusOf(records, id), label = STATUSES.find(item => item.id === status)?.label ?? '待办';
  const shown = STATUSES.filter(item => item.label.includes(filter.trim()) || item.id.includes(filter.trim().toLowerCase()));
  return <>
    <button type="button" className="pw-craft-status-button" aria-label={`设置状态：${label}`} aria-haspopup="menu" aria-expanded={Boolean(menu)} title={`设置状态：${label}`} disabled={disabled} onClick={event => { event.stopPropagation(); setFilter(''); setMenu({ anchor: anchorFromElement(event.currentTarget), element: event.currentTarget }); }} onContextMenu={event => event.stopPropagation()}><StatusGlyph status={status}/></button>
    {menu && <PopMenu anchor={menu.anchor} returnFocus={menu.element} ariaLabel="设置会话状态" width={208} onClose={() => setMenu(null)} className="pw-craft-status-menu">
      <input data-autofocus aria-label="筛选状态" placeholder="筛选状态…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && shown[0]) { event.preventDefault(); setMenu(null); void onSave(id, { status: (filter.trim() ? shown[0].id : status) as StatusId }).catch(() => {}); } }} />
      <div className="pw-craft-menu-items">
        {shown.map(item => <button type="button" role="menuitemradio" aria-checked={item.id === status} key={item.id} className={`pw-craft-menu-item${item.id === status ? ' is-current' : ''}`} onClick={() => { setMenu(null); void onSave(id, { status: item.id as StatusId }).catch(() => {}); }}><StatusGlyph status={item.id}/><span>{item.label}</span></button>)}
        {!shown.length && <div className="pw-craft-empty">没有匹配的状态</div>}
        {!filter.trim() && <><div className="pw-craft-menu-separator"/><button type="button" role="menuitem" className="pw-craft-menu-item" onClick={() => { setMenu(null); onArchive(id, archived); }}><ArchiveGlyph/><span>{archived ? '恢复' : '归档'}</span></button></>}
      </div>
    </PopMenu>}
  </>;
}

export function WorkflowFilters({ sessions, records, filter, archived, onSelect, onPointerEnter, onPointerLeave }: {
  sessions: SessionInfo[]; records: Records; filter: string; archived: boolean;
  onSelect: (filter: string) => void; onPointerEnter: () => void; onPointerLeave: () => void;
}) {
  const roots = useMemo(() => sessions.filter(s => s.relation?.kind !== 'subagent'), [sessions]);
  return <div className="pw-craft-filters" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    <button type="button" role="menuitemradio" className={filter === 'all' && !archived ? 'is-active' : ''} aria-checked={filter === 'all' && !archived} onClick={() => onSelect('all')}><span className="pw-craft-all">☰</span><span>全部</span>{!archived && <small>{roots.length}</small>}</button>
    {STATUSES.map(item => <button type="button" role="menuitemradio" key={item.id} className={filter === item.id && !archived ? 'is-active' : ''} aria-checked={filter === item.id && !archived} onClick={() => onSelect(item.id)}><StatusGlyph status={item.id}/><span>{item.label}</span>{!archived && <small>{roots.filter(s => statusOf(records, s.id) === item.id).length || ''}</small>}</button>)}
    <div className="pw-craft-separator"/>
    <button type="button" role="menuitemradio" className={filter === 'flagged' && !archived ? 'is-active' : ''} aria-checked={filter === 'flagged' && !archived} onClick={() => onSelect('flagged')}><FlagGlyph/><span>已标记</span>{!archived && <small>{roots.filter(s => isFlagged(records, s.id)).length || ''}</small>}</button>
    <button type="button" role="menuitemradio" className={archived ? 'is-active' : ''} aria-checked={archived} onClick={() => onSelect('archived')}><ArchiveGlyph/><span>已归档</span></button>
  </div>;
}

type ViewProps = {
  sessions: SessionInfo[]; records: Records; selectedSessionId: string | null; running: ReadonlySet<string>; unread: ReadonlySet<string>;
  archived: boolean; filter: string;
  onSelect: (session: SessionInfo) => void; onSave: (id: string, patch: StatusPatch) => Promise<void>;
  onArchive: (id: string, archived: boolean) => void; onMenu: (id: string, point: { x: number; y: number }) => void;
};
export function CraftSessionView(props: ViewProps) {
  const { sessions, records, filter, archived } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const roots = useMemo(() => sessions.filter(s => s.relation?.kind !== 'subagent'), [sessions]);
  const groups = useMemo(() => groupedSessions(roots, records, archived ? 'archived' : filter), [roots, records, filter, archived]);
  const filterLabel = archived ? '已归档' : filter === 'flagged' ? '已标记' : STATUSES.find(item => item.id === filter)?.label;
  return <div className="pw-craft-view">
    <div className="pw-craft-list scrollbar-subtle" role="region" aria-label="对话列表" onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.pw-craft-open')];
      const index = buttons.indexOf(event.target as HTMLButtonElement); if (index < 0) return;
      event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }}>
      {filterLabel && <div className="pw-craft-current-filter" aria-live="polite">{filterLabel}</div>}
      {!groups.length && <p className="pw-craft-empty">暂无对话</p>}
      {groups.map(group => <section key={group.label}>
        <button type="button" className="pw-craft-date" aria-expanded={!collapsed.has(group.label)} onClick={() => setCollapsed(previous => { const next = new Set(previous); next.has(group.label) ? next.delete(group.label) : next.add(group.label); return next; })}>{group.label} <span>{collapsed.has(group.label) ? '›' : '⌄'}</span></button>
        {!collapsed.has(group.label) && group.items.map(session => <div className={`pw-craft-row${session.id === props.selectedSessionId ? ' is-selected' : ''}`} key={session.id} data-session-id={session.id} data-pi-session-id={session.id} data-pi-session-row="" onContextMenu={event => { event.preventDefault(); props.onMenu(session.id, { x: event.clientX, y: event.clientY }); }}>
          <StatusButton id={session.id} records={records} onSave={props.onSave} archived={archived} onArchive={props.onArchive} disabled={session.transient}/>
          <button type="button" className="pw-craft-open" aria-current={session.id === props.selectedSessionId ? 'page' : undefined} onClick={() => props.onSelect(session)} title={session.name || session.firstMessage}>
            <span className="pw-craft-row-top"><span className="pw-craft-title">{deriveSessionTitle(session.name, session.firstMessage, session.id)}</span><span className="pw-craft-time">{props.running.has(session.id) ? '运行中' : formatSessionTime(session.modified, new Date())}</span></span>
            <span className="pw-craft-preview">{props.unread.has(session.id) ? '有新回复 · ' : ''}{session.firstMessage.replace(/\s+/g, ' ').trim() || '新对话'}</span>
          </button>
          <button type="button" className={`pw-craft-flag${isFlagged(records, session.id) ? ' is-flagged' : ''}`} aria-label={isFlagged(records, session.id) ? '取消标记' : '标记会话'} title={isFlagged(records, session.id) ? '取消标记' : '标记会话'} disabled={session.transient} onClick={() => { void props.onSave(session.id, { flagged: !isFlagged(records, session.id) }).catch(() => {}); }}><FlagGlyph/></button>
          <button type="button" className="pw-craft-more" aria-label="会话操作" title="会话操作" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); props.onMenu(session.id, { x: rect.right - 180, y: rect.bottom }); }}>⋯</button>
          <span data-pi-row-slot=""/>
        </div>)}
      </section>)}
    </div>
  </div>;
}
