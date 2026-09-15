"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { SessionInfo } from '@/lib/types';
import { ProjectDialog, projectRequest, type NamedProject, type ProjectRegistry } from './PortableProjects';

type Kind = 'rename' | 'move' | 'archive' | 'restore' | 'remove' | 'delete';
type Point = { x: number; y: number };
const labels: Record<Kind, string> = { rename: '重命名', move: '移动到项目', archive: '归档', restore: '恢复', remove: '从列表移除', delete: '物理删除' };
const paths: Record<Kind, ReactNode> = {
  rename: <><path d="m16 3 5 5L8 21H3v-5Z"/><path d="m14 5 5 5"/></>,
  move: <><path d="M11 5H3v15h18v-7M3 5V3h6l2 2"/><path d="M12 9h9m-4-4 4 4-4 4"/></>,
  archive: <><path d="M3 8h18v13H3zM2 3h20v5H2zM10 12h4"/></>,
  restore: <><path d="M3 10a9 9 0 1 1 0 5M3 4v6h6"/></>,
  remove: <><path d="M10 5H3v15h18v-7M3 5V3h6l2 2M14 6h8"/></>,
  delete: <><path d="M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7m4-7v7"/></>,
};
export function ActionIcon({ kind }: { kind: Kind }) { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>; }
const button: CSSProperties = { background: 'var(--bg-hover)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 12px', cursor: 'pointer' };
const input: CSSProperties = { ...button, width: '100%', boxSizing: 'border-box', cursor: 'text', marginTop: 8 };

function IconMenu({ point, close, actions }: { point: Point; close: () => void; actions: { kind: Kind; disabled?: boolean; hint?: string; run: () => void }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!, rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(point.x, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(point.y, innerHeight - rect.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close); document.removeEventListener('scroll', close, true); };
  }, [point, close]);
  return createPortal(<div ref={ref} role="menu" aria-label="操作" data-pi-context-menu="true"
    onClick={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    onKeyDown={e => {
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
      if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (['ArrowLeft','ArrowUp'].includes(e.key) ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }} style={{ position: 'fixed', left: point.x, top: point.y, zIndex: 10000, display: 'flex', gap: 3, padding: 5, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 6px 24px #0002' }}>
    <style>{`.pi-context-icon{width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--text-muted);cursor:pointer}.pi-context-icon:hover,.pi-context-icon:focus-visible{background:var(--bg-hover);color:var(--accent);outline:2px solid transparent}.pi-context-icon:focus-visible{outline-color:var(--accent)}.pi-context-icon:disabled{opacity:.3;cursor:not-allowed}.pi-context-icon[data-danger]{color:#dc4444}.pi-context-icon[data-danger]:hover{background:#ef444414}`}</style>
    {actions.map(a => <button key={a.kind} type="button" role="menuitem" className="pi-context-icon" data-danger={a.kind === 'delete' ? '' : undefined} title={a.hint || labels[a.kind]} aria-label={labels[a.kind]} disabled={a.disabled} onClick={() => { close(); a.run(); }}><ActionIcon kind={a.kind}/></button>)}
  </div>, document.body);
}
function ErrorLine({ error }: { error: string }) { return error ? <p role="alert" style={{ color: '#ef4444', fontSize: 12, overflowWrap: 'anywhere' }}>{error}</p> : null; }

export function ProjectContextActions({ project, children, onChanged }: { project: NamedProject | null; children?: ReactNode; onChanged: (registry: ProjectRegistry, removed: boolean) => void }) {
  const [point, setPoint] = useState<Point | null>(null), [action, setAction] = useState<Kind | null>(null), [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const open = (kind: Kind) => { setAction(kind); setError(''); setValue(kind === 'rename' ? project?.name || project?.root.split(/[/\\]/).pop() || '' : ''); };
  return <div data-pi-project-root={project?.root} style={{ display: 'contents' }} onContextMenu={e => {
    if (!project || (e.target as HTMLElement).closest('dialog')) return;
    e.preventDefault(); e.stopPropagation(); setPoint({ x: e.clientX, y: e.clientY });
  }}>
    {children}
    {point && project && <IconMenu point={point} close={() => setPoint(null)} actions={(['rename','remove','delete'] as Kind[]).map(kind => ({ kind, run: () => open(kind) }))}/>}
    {action && project && <ProjectDialog title={`${labels[action]}项目`} busy={busy} close={() => setAction(null)}>
      <form onSubmit={async e => {
        e.preventDefault(); if (busy) return; setBusy(true); setError('');
        try { const data = await projectRequest('/api/projects', { action, cwd: project.root, name: value, confirmPath: action === 'delete' ? value : undefined }); setAction(null); onChanged(data, action !== 'rename'); }
        catch (e) { console.error('[pi-web project-menu]', e); setError(String(e)); } finally { setBusy(false); }
      }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{project.root}</p>
        {action === 'rename' && <><label>项目名称<input autoFocus required maxLength={100} style={input} value={value} onChange={e => setValue(e.target.value)} disabled={busy}/></label><p style={{ fontSize: 12 }}>只修改显示名称，不改磁盘路径或对话工作目录。</p></>}
        {action === 'remove' && <p>只从列表移除，保留项目文件和全部对话，可重新添加。</p>}
        {action === 'delete' && <><p style={{ color: '#dc4444' }}>永久删除该目录及其中的全部文件，不进入回收站。对话记录保留，可另行移动或删除。</p><label>输入完整路径确认<input autoFocus required autoComplete="off" spellCheck={false} style={input} value={value} onChange={e => setValue(e.target.value)} disabled={busy}/></label></>}
        <ErrorLine error={error}/><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}><button type="button" style={button} disabled={busy} onClick={() => setAction(null)}>取消</button><button style={{ ...button, color: action === 'delete' ? '#dc4444' : undefined }} disabled={busy || (action === 'delete' ? value !== project.root : action === 'rename' && !value.trim())}>{busy ? '处理中…' : labels[action]}</button></div>
      </form>
    </ProjectDialog>}
  </div>;
}

export function SessionContextActions({ session, projects, isRunning, onChanged, onMoved, onDeleted }: { session: SessionInfo; projects: NamedProject[]; isRunning: boolean; onChanged?: () => void; onMoved: (info: SessionInfo) => void; onDeleted?: (id: string) => void }) {
  const [point, setPoint] = useState<Point | null>(null), [action, setAction] = useState<Kind | null>(null), [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [archived, setArchived] = useState(false);
  const targets = projects.filter(p => p.key !== (session.projectKey ?? session.cwd));
  useEffect(() => {
    const context = (e: WindowEventMap['pi-web:session-row-contextmenu']) => {
      if (e.detail.id !== session.id) return;
      e.preventDefault(); setPoint({ x: e.detail.clientX, y: e.detail.clientY }); setArchived(document.documentElement.dataset.piSessionArchiveView === 'archived');
    };
    window.addEventListener('pi-web:session-row-contextmenu', context);
    return () => window.removeEventListener('pi-web:session-row-contextmenu', context);
  }, [session.id]);
  const open = (kind: Kind) => { setAction(kind); setError(''); setValue(kind === 'rename' ? session.name || '' : kind === 'move' ? targets[0]?.root || '' : ''); };
  return <>
    {point && <IconMenu point={point} close={() => setPoint(null)} actions={[
      { kind: 'move', disabled: isRunning || session.relation?.kind === 'subagent', hint: isRunning ? '运行中，请先停止' : labels.move, run: () => open('move') },
      { kind: 'rename', run: () => open('rename') },
      { kind: archived ? 'restore' : 'archive', disabled: isRunning, run: () => {
        const row = document.querySelector(`[data-pi-session-id="${CSS.escape(session.id)}"]`);
        const event = new CustomEvent('pi-web:archive-session', { cancelable: true, detail: { id: session.id, row } });
        if (window.dispatchEvent(event)) { console.error('[pi-web context-menu] immediate archive handler unavailable'); setError('归档组件未就绪，请刷新页面后重试'); setAction('archive'); }
      } },
      { kind: 'delete', disabled: isRunning || session.relation?.kind === 'subagent', hint: isRunning ? '运行中，请先停止' : labels.delete, run: () => open('delete') },
    ]}/>}
    {action && <ProjectDialog title={`${labels[action]}对话`} busy={busy} close={() => setAction(null)}>
      <form onSubmit={async e => {
        e.preventDefault(); if (busy || action === 'archive') return; setBusy(true); setError('');
        try {
          const base = `/api/sessions/${encodeURIComponent(session.id)}`;
          if (action === 'rename') { const r = await fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value }) }); const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`); onChanged?.(); }
          if (action === 'move') { const d = await projectRequest(base + '/move', { cwd: value }); onMoved(d.info); }
          if (action === 'delete') { await projectRequest(base + '/physical-delete', { confirmId: session.id }); onDeleted?.(session.id); }
          setAction(null);
        } catch (e) { console.error('[pi-web session-menu]', e); setError(String(e)); } finally { setBusy(false); }
      }}>
        {action === 'rename' && <label>对话名称<input autoFocus style={input} maxLength={200} value={value} onChange={e => setValue(e.target.value)} disabled={busy}/></label>}
        {action === 'move' && <><label>目标项目<select autoFocus required style={input} value={value} onChange={e => setValue(e.target.value)} disabled={busy}><option value="">请选择项目</option>{targets.map(p => <option key={p.key} value={p.root}>{p.name || p.root}</option>)}</select></label><p style={{ fontSize: 12 }}>保留全部历史、ID 和关联子会话，下次继续时使用目标目录。不移动项目文件。</p></>}
        {action === 'delete' && <><p style={{ overflowWrap: 'anywhere' }}>{session.name || session.firstMessage.slice(0, 80)}</p><p style={{ color: '#dc4444' }}>永久删除此对话和关联子会话的 JSONL 文件，不是归档，不能撤销。项目文件和独立分支不受影响。</p><p style={{ fontSize: 11, overflowWrap: 'anywhere', color: 'var(--text-muted)' }}>{session.path}</p><label>输入「删除」确认<input autoFocus autoComplete="off" style={input} value={value} onChange={e => setValue(e.target.value)} disabled={busy}/></label></>}
        <ErrorLine error={error}/><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}><button type="button" style={button} disabled={busy} onClick={() => setAction(null)}>取消</button>{action !== 'archive' && <button style={{ ...button, color: action === 'delete' ? '#dc4444' : undefined }} disabled={busy || (action === 'delete' ? value !== '删除' : action === 'move' && !value)}>{busy ? '处理中…' : labels[action]}</button>}</div>
      </form>
    </ProjectDialog>}
  </>;
}
