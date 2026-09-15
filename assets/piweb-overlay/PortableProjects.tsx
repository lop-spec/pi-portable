"use client";
import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { SessionInfo } from '@/lib/types';
import type { RecentProject } from '@/lib/project-groups';

export type NamedProject = RecentProject & { name?: string };
export interface ProjectRegistry { projects: NamedProject[]; hidden: string[] }
export function visibleProjectList(recent: RecentProject[], registry: ProjectRegistry): NamedProject[] {
  const names = new Map(registry.projects.map(p => [p.key, p.name]));
  return [...new Map([...registry.projects, ...recent].map(p => [p.key, p])).values()]
    .filter(p => !registry.hidden.includes(p.key)).map(p => ({ ...p, name: names.get(p.key) }));
}
const button: CSSProperties = { padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' };
const action: CSSProperties = { ...button, padding: '4px 7px', flexShrink: 0 };
const input: CSSProperties = { ...button, width: '100%', boxSizing: 'border-box', cursor: 'text' };
export async function projectRequest(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function ProjectDialog({ title, close, children, busy }: { title: string; close: () => void; children: React.ReactNode; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return createPortal(<dialog ref={ref} onClick={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); if (!busy) close(); }} aria-label={title}
    style={{ width: 'min(480px, calc(100vw - 32px))', boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 12, padding: 20, background: 'var(--bg)', color: 'var(--text)', boxShadow: '0 14px 50px #0003' }}>
    <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>{title}</h3>{children}
  </dialog>, document.body);
}
export function CreateProjectButton({ selectedCwd, onCreated }: { selectedCwd: string | null; onCreated: (cwd: string, registry: ProjectRegistry) => void }) {
  const [open, setOpen] = useState(false), [cwd, setCwd] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <>
    <button type="button" style={{ ...button, width: '100%', textAlign: 'left', border: 0 }} onClick={() => { setCwd(selectedCwd ? selectedCwd.replace(/[/\\]+$/, '') + (selectedCwd.includes('\\') ? '\\' : '/') : ''); setError(''); setOpen(true); }}>＋ 创建文件夹 / 新项目</button>
    {open && <ProjectDialog title="创建项目" close={() => setOpen(false)} busy={busy}>
      <form onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { const data = await projectRequest('/api/projects', { action: 'create', cwd }); onCreated(data.cwd, data); setOpen(false); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>
        <label>项目完整路径<input autoFocus required style={{ ...input, marginTop: 8 }} value={cwd} onChange={e => setCwd(e.target.value)} placeholder="D:\Projects\新项目" disabled={busy} /></label>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>不存在的文件夹会自动创建（包括父目录）；已有目录直接添加，不修改其中的文件。</p>
        {error && <p role="alert" style={{ color: '#ef4444' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" style={button} disabled={busy} onClick={() => setOpen(false)}>取消</button><button style={button} disabled={busy || !cwd.trim()}>{busy ? '创建中…' : '创建项目'}</button></div>
      </form>
    </ProjectDialog>}
  </>;
}
export function RemoveProjectButton({ project, onRemoved }: { project: RecentProject; onRemoved: (registry: ProjectRegistry) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <>
    <button type="button" style={action} aria-label={`移除项目 ${project.root}`} title="从列表移除项目" onClick={e => { e.stopPropagation(); setError(''); setOpen(true); }}>×</button>
    {open && <ProjectDialog title="移除项目" close={() => setOpen(false)} busy={busy}>
      <p style={{ overflowWrap: 'anywhere' }}>{project.root}</p><p>只从项目列表移除，不删除物理文件夹或对话。可通过「自定义路径」重新添加。</p>
      {error && <p role="alert" style={{ color: '#ef4444' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button style={button} disabled={busy} onClick={() => setOpen(false)}>取消</button><button style={button} disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const data = await projectRequest('/api/projects', { action: 'remove', cwd: project.root }); setOpen(false); onRemoved(data); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>{busy ? '移除中…' : '移除项目'}</button></div>
    </ProjectDialog>}
  </>;
}
export function MoveSessionButton({ session, projects, disabled, onMoved }: { session: SessionInfo; projects: RecentProject[]; disabled: boolean; onMoved: (session: SessionInfo) => void }) {
  const [open, setOpen] = useState(false), [cwd, setCwd] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const targets = projects.filter(p => p.key !== (session.projectKey ?? session.cwd));
  return <>
    <button type="button" style={action} disabled={disabled} title={disabled ? '运行中或子会话不能单独移动' : '移动到项目'} aria-label="移动到项目" onClick={e => { e.stopPropagation(); setCwd(targets[0]?.root ?? ''); setError(''); setOpen(true); }}>↗</button>
    {open && <ProjectDialog title="移动对话到项目" close={() => setOpen(false)} busy={busy}>
      <form onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { const data = await projectRequest(`/api/sessions/${encodeURIComponent(session.id)}/move`, { cwd }); setOpen(false); onMoved(data.info); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>
        <label>目标项目<select autoFocus required style={{ ...input, marginTop: 8 }} value={cwd} onChange={e => setCwd(e.target.value)} disabled={busy}><option value="">请选择项目</option>{targets.map(p => <option key={p.key} value={p.root}>{p.root}</option>)}</select></label>
        {!targets.length && <p>暂无其他项目，请先在项目栏创建或添加目录。</p>}
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>保留全部历史和对话 ID；下次继续会在目标目录工作。关联子会话一起移动，不搬动项目文件。</p>
        {error && <p role="alert" style={{ color: '#ef4444' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" style={button} disabled={busy} onClick={() => setOpen(false)}>取消</button><button style={button} disabled={busy || !cwd}>{busy ? '移动中…' : '移动对话'}</button></div>
      </form>
    </ProjectDialog>}
  </>;
}
