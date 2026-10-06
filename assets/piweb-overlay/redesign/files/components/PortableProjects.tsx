"use client";
import { useState } from 'react';
import type { SessionInfo } from '@/lib/types';
import type { RecentProject } from '@/lib/project-groups';
import { PwDialog } from './sidebar/PwDialog';
import { readRememberedRoots } from './sidebar/project-removal';

export type NamedProject = RecentProject & { name?: string };
export interface ProjectRegistry { projects: NamedProject[]; hidden: string[]; categories?: { name: string; root: string }[]; cwd?: string; previousRoot?: string; sessionIds?: string[] }
export function groupProjectList(projects: NamedProject[], registry: ProjectRegistry) {
  const groups = (registry.categories || []).map(c => ({ ...c, projects: [] as NamedProject[] }));
  const other = { name: groups.length ? '未分类' : '', root: '', projects: [] as NamedProject[] };
  const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (const p of projects) (groups.find(c => key(p.root).startsWith(key(c.root) + '/')) || other).projects.push(p);
  if (other.projects.length) groups.push(other);
  return groups.filter(group => group.projects.length > 0);
}
export function remapProjectSession(session: SessionInfo, registry: ProjectRegistry): SessionInfo {
  if (!registry.cwd || !registry.previousRoot || !registry.sessionIds?.includes(session.id)) return session;
  return { ...session, cwd: registry.cwd + session.cwd.slice(registry.previousRoot.length), projectRoot: registry.cwd, projectKey: /^[a-z]:[/\\]/i.test(registry.cwd) ? registry.cwd.replace(/\//g, '\\').toLowerCase() : registry.cwd };
}
/** 可见项目：registry 与最近活动合并去重、去掉隐藏项；按最近活动倒序（没有对话的登记项目排在后面，保持登记顺序）。 */
export function visibleProjectList(recent: RecentProject[], registry: ProjectRegistry): NamedProject[] {
  const names = new Map(registry.projects.map(p => [p.key, p.name]));
  const merged = [...new Map([...registry.projects, ...recent].map(p => [p.key, p])).values()]
    .filter(p => !registry.hidden.includes(p.key)).map(p => ({ ...p, name: names.get(p.key) }));
  const rank = new Map(recent.map((p, index) => [p.key, index]));
  return merged
    .map((project, index) => ({ project, index }))
    .sort((a, b) => (rank.get(a.project.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.project.key) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ project }) => project);
}
/**
 * 被隐藏的项目：key 在 hidden 里。服务端 remove 之后 registry 只剩小写 key，所以显示/恢复/删除用的 root 依次取：
 * 最近活动（会话里的原始大小写路径）> registry 里的 root > 隐藏时记下的原始 root > 最后才是小写 key（没有任何来源时）。
 */
export function hiddenProjectList(recent: RecentProject[], registry: ProjectRegistry, remembered: ReadonlyMap<string, string> = readRememberedRoots()): NamedProject[] {
  const roots = new Map([...registry.projects, ...recent].map(p => [p.key, p.root]));
  const names = new Map(registry.projects.map(p => [p.key, p.name]));
  return registry.hidden.map(key => ({ key, root: roots.get(key) ?? remembered.get(key) ?? key, name: names.get(key) }));
}
export async function projectRequest(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** 新建项目：输入完整路径，不存在就创建（含父目录），已有目录直接添加。 */
export function CreateProjectDialog({ initialCwd, onClose, onCreated, returnFocus }: {
  initialCwd: string;
  onClose: () => void;
  onCreated: (cwd: string, registry: ProjectRegistry) => void;
  returnFocus?: HTMLElement | null;
}) {
  const [cwd, setCwd] = useState(initialCwd), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async () => {
    if (busy || !cwd.trim()) return;
    setBusy(true); setError('');
    try { const data = await projectRequest('/api/projects', { action: 'create', cwd }); onCreated(data.cwd, data); onClose(); }
    catch (e) { console.error('[pi-web projects] create failed', e); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <PwDialog title="新建项目" busy={busy} onClose={onClose} onSubmit={() => void submit()} returnFocus={returnFocus}
      footer={<>
        <button type="button" className="pw-btn pw-btn--ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="pw-btn pw-btn--primary" disabled={busy || !cwd.trim()}>{busy ? '创建中…' : '创建'}</button>
      </>}>
      <label className="pw-label" htmlFor="pw-create-project-path">项目完整路径</label>
      <input id="pw-create-project-path" className="pw-input pw-mono" data-autofocus="" required spellCheck={false} autoComplete="off"
        value={cwd} onChange={e => setCwd(e.target.value)} placeholder="例如 D:\Projects\新项目" disabled={busy} aria-invalid={Boolean(error)} />
      <p className="pw-field-hint">不存在的文件夹会自动创建（包括父目录）；已有目录直接添加，不修改其中的文件。</p>
      {error && <p className="pw-field-error" role="alert">{error}</p>}
    </PwDialog>
  );
}
