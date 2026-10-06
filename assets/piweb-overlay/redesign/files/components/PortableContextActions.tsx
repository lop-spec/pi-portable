"use client";
// 项目与会话的操作：竖排文字菜单（右键、⋯ 按钮、Shift+F10 / 菜单键共用）+ .pw-dialog 对话框。
// 会话菜单仍经 lib/session-row-context-menu 的窗口事件打开（行内 dispatch，列表级宿主认领），
// 这样行组件不必各自挂一份菜单与对话框。
import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@/lib/types';
import { SESSION_ROW_CONTEXT_MENU_EVENT } from '@/lib/session-row-context-menu';
import { projectRequest, type NamedProject, type ProjectRegistry } from './PortableProjects';
import { PopMenu, type MenuAnchor } from './sidebar/PopMenu';
import { PwDialog } from './sidebar/PwDialog';
import { Icon } from './sidebar/icons';
import { projectLabel } from './sidebar/project-label';
import { confirmPathFor, forgetProjectRoot, projectPathConfirmed, rememberProjectRoot } from './sidebar/project-removal';
import { deriveSessionTitle } from './sidebar/session-title';
import { formatSessionDate } from './sidebar/session-time';

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

// ───────────────────────── 项目 ─────────────────────────

export type ProjectActionKind = 'rename' | 'delete';

/** 项目操作菜单：重命名文件夹… / 从列表隐藏（或恢复）/ ── / 删除文件夹… */
export function ProjectActionMenu({ project, hidden, anchor, returnFocus, onClose, onAction, onHide, onRestore }: {
  project: NamedProject;
  hidden: boolean;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onAction: (kind: ProjectActionKind) => void;
  onHide: () => void;
  onRestore: () => void;
}) {
  return (
    <PopMenu anchor={anchor} ariaLabel={`项目操作：${projectLabel(project)}`} returnFocus={returnFocus} onClose={onClose} width={196}>
      <div className="pw-menu-header"><span className="pw-truncate">{projectLabel(project)}</span></div>
      <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { onClose(); onAction('rename'); }}>
        <Icon name="pencil" /><span className="pw-menu-label">重命名文件夹…</span>
      </button>
      {hidden ? (
        <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { onClose(); onRestore(); }}>
          <Icon name="eye" /><span className="pw-menu-label">恢复到列表</span>
        </button>
      ) : (
        <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { onClose(); onHide(); }}>
          <Icon name="eyeOff" /><span className="pw-menu-label">从列表隐藏</span>
        </button>
      )}
      <div className="pw-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="pw-menu-item pw-menu-item--danger" onClick={() => { onClose(); onAction('delete'); }}>
        <Icon name="trash" /><span className="pw-menu-label">删除文件夹…</span>
      </button>
    </PopMenu>
  );
}

/** 重命名文件夹 / 永久删除文件夹 两个高风险操作的确认框。 */
export function ProjectActionDialog({ kind, project, returnFocus, onClose, onChanged }: {
  kind: ProjectActionKind;
  project: NamedProject;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onChanged: (registry: ProjectRegistry, removed: boolean) => void;
}) {
  const [value, setValue] = useState(kind === 'rename' ? project.root.split(/[/\\]/).filter(Boolean).pop() || '' : '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const disabled = busy || (kind === 'delete' ? !projectPathConfirmed(value, project.root) : !value.trim());
  const submit = async () => {
    if (disabled) return;
    setBusy(true); setError('');
    try {
      // 确认框已按「整串路径、Windows 不区分大小写和斜杠方向」比对过；服务端对 confirmPath 做精确比较，所以发项目自己的 root（原生写法）。
      const target = kind === 'delete' ? confirmPathFor(project.root) : project.root;
      const data = await projectRequest('/api/projects', { action: kind, cwd: target, name: value, confirmPath: kind === 'delete' ? target : undefined });
      forgetProjectRoot(project.key);
      onClose();
      onChanged(data, kind !== 'rename');
    } catch (e) { console.error('[pi-web project-menu]', e); setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const nextPath = project.root.replace(/[^/\\]+[/\\]*$/, () => value);
  return (
    <PwDialog title={kind === 'rename' ? '重命名项目文件夹' : '永久删除项目文件夹'} busy={busy} onClose={onClose} onSubmit={() => void submit()} returnFocus={returnFocus}
      footer={<>
        <button type="button" className="pw-btn pw-btn--ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className={kind === 'delete' ? 'pw-btn pw-btn--danger-solid' : 'pw-btn pw-btn--primary'} disabled={disabled}>
          {busy ? '处理中…' : kind === 'delete' ? '永久删除' : '重命名'}
        </button>
      </>}>
      <p className="pw-dialog-desc">当前路径</p>
      <p className="pw-sb-dialog-path pw-mono">{project.root}</p>
      {kind === 'rename' ? <>
        <label className="pw-label" htmlFor="pw-project-rename">新的文件夹名</label>
        <input id="pw-project-rename" className="pw-input" data-autofocus="" required maxLength={100} value={value} onChange={e => setValue(e.target.value)} disabled={busy} aria-invalid={Boolean(error)} />
        <p className="pw-field-hint">直接重命名磁盘上的文件夹，并更新该项目全部对话的工作目录；历史和文件内容保留。项目内有运行中的对话时需先停止。</p>
        {value.trim() && <p className="pw-field-hint">新路径：<span className="pw-mono">{nextPath}</span></p>}
      </> : <>
        <p className="pw-sb-dialog-warn" role="note">永久删除该目录及其中的全部文件，不进入回收站，不能撤销。对话记录保留，可另行移动或删除。</p>
        <label className="pw-label" htmlFor="pw-project-delete">输入完整路径确认</label>
        <input id="pw-project-delete" className="pw-input pw-mono" data-autofocus="" required autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} disabled={busy} aria-invalid={Boolean(error)} />
      </>}
      {error && <p className="pw-field-error" role="alert">{error}</p>}
    </PwDialog>
  );
}

/** 从列表隐藏 / 恢复：可逆操作，直接执行，失败才弹框说明。 */
export async function setProjectHidden(project: NamedProject, hidden: boolean): Promise<ProjectRegistry> {
  const registry = await projectRequest('/api/projects', { action: hidden ? 'remove' : 'add', cwd: project.root });
  // 服务端隐藏后只留小写 key；先把原始大小写 root 记下来，隐藏列表、恢复和删除确认才不会退回全小写路径。
  if (hidden) rememberProjectRoot(project.key, project.root);
  else forgetProjectRoot(project.key);
  return registry;
}

export function NoticeDialog({ title, message, onClose, returnFocus }: { title: string; message: string; onClose: () => void; returnFocus?: HTMLElement | null }) {
  return (
    <PwDialog title={title} size="sm" onClose={onClose} onSubmit={onClose} returnFocus={returnFocus}
      footer={<button type="submit" className="pw-btn pw-btn--primary" data-autofocus="">知道了</button>}>
      <p className="pw-field-error" role="alert" style={{ marginTop: 0 }}>{message}</p>
    </PwDialog>
  );
}

// ───────────────────────── 会话 ─────────────────────────

type SessionDialogKind = 'move' | 'delete' | 'archive-error';

interface MenuState { session: SessionInfo; anchor: MenuAnchor; returnFocus: HTMLElement | null }

/**
 * 会话操作宿主：认领 pi-web:session-row-contextmenu 事件，弹出竖排文字菜单
 * 「N 条消息 · 日期 / 改名 F2 / 移动到项目… / 归档（归档视图下为恢复）/ ── / 删除…」。
 * 运行中的会话禁用移动和删除；子代理随主会话移动/删除。归档沿用注入脚本的 pi-web:archive-session 事件。
 */
export function SessionContextActions({ resolveSession, isRunning, projects, onRename, onMenuChange, onMoved, onDeleted }: {
  resolveSession: (id: string) => SessionInfo | undefined;
  isRunning: (id: string) => boolean;
  projects: NamedProject[];
  onRename: (id: string) => void;
  onMenuChange?: (id: string | null) => void;
  onMoved: (info: SessionInfo) => void;
  onDeleted?: (id: string) => void;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<{ kind: SessionDialogKind; session: SessionInfo; returnFocus: HTMLElement | null; message?: string } | null>(null);
  const [archived, setArchived] = useState(false);
  const resolveRef = useRef(resolveSession);
  resolveRef.current = resolveSession;
  const menuChangeRef = useRef(onMenuChange);
  menuChangeRef.current = onMenuChange;
  useEffect(() => { menuChangeRef.current?.(menu?.session.id ?? null); }, [menu]);

  useEffect(() => {
    const listener = (event: WindowEventMap['pi-web:session-row-contextmenu']) => {
      const session = resolveRef.current(event.detail.id);
      if (!session || session.transient) return;
      event.preventDefault();
      const row = document.querySelector<HTMLElement>(`[data-pi-session-id="${CSS.escape(session.id)}"]`);
      const main = row?.querySelector<HTMLElement>('.pw-sess-main') ?? null;
      setArchived(document.documentElement.dataset.piSessionArchiveView === 'archived');
      setMenu({ session, anchor: { kind: 'point', x: event.detail.clientX, y: event.detail.clientY }, returnFocus: main });
    };
    window.addEventListener(SESSION_ROW_CONTEXT_MENU_EVENT, listener);
    return () => window.removeEventListener(SESSION_ROW_CONTEXT_MENU_EVENT, listener);
  }, []);

  const close = () => setMenu(null);
  const archive = (session: SessionInfo, returnFocus: HTMLElement | null) => {
    const row = document.querySelector(`[data-pi-session-id="${CSS.escape(session.id)}"]`);
    const event = new CustomEvent('pi-web:archive-session', { cancelable: true, detail: { id: session.id, row } });
    if (window.dispatchEvent(event)) {
      console.error('[pi-web context-menu] immediate archive handler unavailable');
      setDialog({ kind: 'archive-error', session, returnFocus, message: '归档组件未就绪，请刷新页面后重试。' });
    }
  };

  const now = new Date();
  const current = menu?.session;
  const running = current ? isRunning(current.id) : false;
  const subagent = current?.relation?.kind === 'subagent';
  return <>
    {menu && current && (
      <PopMenu anchor={menu.anchor} ariaLabel="会话操作" returnFocus={menu.returnFocus} onClose={close} width={200}>
        <div className="pw-menu-header">
          <span>{current.detailsPending ? '…' : `${current.messageCount} 条消息`}</span>
          <span>{formatSessionDate(current.modified, now)}</span>
        </div>
        <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { close(); onRename(current.id); }}>
          <Icon name="pencil" /><span className="pw-menu-label">改名</span><span className="pw-menu-kbd">F2</span>
        </button>
        <button type="button" role="menuitem" className="pw-menu-item" aria-disabled={running || subagent}
          title={running ? '运行中，请先停止' : subagent ? '子代理随主会话一起移动' : undefined}
          onClick={() => { if (running || subagent) return; close(); setDialog({ kind: 'move', session: current, returnFocus: menu.returnFocus }); }}>
          <Icon name="move" /><span className="pw-menu-label">移动到项目…</span>
        </button>
        <button type="button" role="menuitem" className="pw-menu-item" aria-disabled={running}
          title={running ? '运行中，请先停止' : undefined}
          onClick={() => { if (running) return; close(); archive(current, menu.returnFocus); }}>
          <Icon name={archived ? 'restore' : 'archive'} /><span className="pw-menu-label">{archived ? '恢复' : '归档'}</span>
        </button>
        <div className="pw-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="pw-menu-item pw-menu-item--danger" aria-disabled={running || subagent}
          title={running ? '运行中，请先停止' : subagent ? '子代理随主会话一起删除' : undefined}
          onClick={() => { if (running || subagent) return; close(); setDialog({ kind: 'delete', session: current, returnFocus: menu.returnFocus }); }}>
          <Icon name="trash" /><span className="pw-menu-label">删除…</span>
        </button>
      </PopMenu>
    )}
    {dialog?.kind === 'move' && <MoveSessionDialog session={dialog.session} projects={projects} returnFocus={dialog.returnFocus} onClose={() => setDialog(null)} onMoved={onMoved} />}
    {dialog?.kind === 'delete' && <DeleteSessionDialog session={dialog.session} returnFocus={dialog.returnFocus} onClose={() => setDialog(null)} onDeleted={onDeleted} />}
    {dialog?.kind === 'archive-error' && <NoticeDialog title="无法归档" message={dialog.message ?? ''} returnFocus={dialog.returnFocus} onClose={() => setDialog(null)} />}
  </>;
}

function MoveSessionDialog({ session, projects, returnFocus, onClose, onMoved }: { session: SessionInfo; projects: NamedProject[]; returnFocus: HTMLElement | null; onClose: () => void; onMoved: (info: SessionInfo) => void }) {
  const targets = projects.filter(p => p.key !== (session.projectKey ?? session.cwd));
  const [value, setValue] = useState(targets[0]?.root ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async () => {
    if (busy || !value) return;
    setBusy(true); setError('');
    try { const data = await projectRequest(`/api/sessions/${encodeURIComponent(session.id)}/move`, { cwd: value }); onClose(); onMoved(data.info); }
    catch (e) { console.error('[pi-web session-menu] move failed', e); setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <PwDialog title="移动会话到项目" busy={busy} onClose={onClose} onSubmit={() => void submit()} returnFocus={returnFocus}
      footer={<>
        <button type="button" className="pw-btn pw-btn--ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="pw-btn pw-btn--primary" disabled={busy || !value}>{busy ? '移动中…' : '移动'}</button>
      </>}>
      <p className="pw-dialog-desc pw-truncate" title={session.name || session.firstMessage}>{deriveSessionTitle(session.name, session.firstMessage, session.id)}</p>
      <label className="pw-label" htmlFor="pw-move-target">目标项目</label>
      <select id="pw-move-target" className="pw-input" data-autofocus="" required value={value} onChange={e => setValue(e.target.value)} disabled={busy || targets.length === 0}>
        {targets.length === 0 && <option value="">暂无其他项目</option>}
        {targets.map(p => <option key={p.key} value={p.root}>{projectLabel(p)} — {p.root}</option>)}
      </select>
      {targets.length === 0 && <p className="pw-field-hint">请先在项目菜单里新建或添加目录。</p>}
      <p className="pw-field-hint">保留全部历史、ID 和关联子代理，下次继续时在目标目录工作；不移动项目文件。</p>
      {error && <p className="pw-field-error" role="alert">{error}</p>}
    </PwDialog>
  );
}

function DeleteSessionDialog({ session, returnFocus, onClose, onDeleted }: { session: SessionInfo; returnFocus: HTMLElement | null; onClose: () => void; onDeleted?: (id: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await projectRequest(`/api/sessions/${encodeURIComponent(session.id)}/physical-delete`, { confirmId: session.id }); onClose(); onDeleted?.(session.id); }
    catch (e) { console.error('[pi-web session-menu] delete failed', e); setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <PwDialog title="永久删除会话" size="sm" busy={busy} onClose={onClose} onSubmit={() => void submit()} returnFocus={returnFocus}
      footer={<>
        <button type="button" className="pw-btn pw-btn--ghost" disabled={busy} onClick={onClose} data-autofocus="">取消</button>
        <button type="submit" className="pw-btn pw-btn--danger-solid" disabled={busy}>{busy ? '删除中…' : '永久删除'}</button>
      </>}>
      <p className="pw-sb-dialog-title-line">{deriveSessionTitle(session.name, session.firstMessage, session.id)}</p>
      <p className="pw-sb-dialog-warn" role="note">永久删除此会话和关联子代理的 JSONL 文件，不是归档，不能撤销。项目文件和独立分支不受影响。</p>
      <p className="pw-sb-dialog-path pw-mono">{session.path}</p>
      {error && <p className="pw-field-error" role="alert">{error}</p>}
    </PwDialog>
  );
}
