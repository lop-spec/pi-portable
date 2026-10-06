"use client";
// 项目切换器（方向 A spec §2.2，审计 D01–D06、D08）：头像 + 名称/短路径两行，⇅ 图标；
// 下拉为 .pw-menu：项目行（名称、短路径、会话数、运行/未读），当前项目被隐藏时置顶并带「已隐藏」，
// 底部可折叠「已隐藏 · N」分组可恢复，分隔线后是 新建项目 / 使用默认目录 / 自定义路径…。
// 项目行右键、⋯ 按钮、Shift+F10 打开同一个竖排文字菜单。
import { memo, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CreateProjectDialog, groupProjectList, type NamedProject, type ProjectRegistry } from "../PortableProjects";
import { NoticeDialog, ProjectActionDialog, ProjectActionMenu, setProjectHidden, type ProjectActionKind } from "../PortableContextActions";
import { Icon } from "./icons";
import { PopMenu, anchorFromElement, type MenuAnchor } from "./PopMenu";
import { projectInitial, projectLabel, shortProjectPath } from "./project-label";

export interface ProjectActivity { running: number; unread: number }

interface ActionMenuState { project: NamedProject; hidden: boolean; anchor: MenuAnchor; returnFocus: HTMLElement | null }

export interface ProjectSwitcherProps {
  current: NamedProject | null;
  currentHidden: boolean;
  placeholder: string;
  projects: NamedProject[];
  hiddenProjects: NamedProject[];
  registry: ProjectRegistry;
  homeDir: string;
  activity: Map<string, ProjectActivity>;
  sessionCounts: Map<string, number>;
  hasOtherActivity: boolean;
  hint?: string | null;
  children?: ReactNode;
  onSelect: (root: string) => void;
  /** removedKey：被隐藏或删除的项目 key；deleted：是永久删除文件夹（目录已不存在），而不是隐藏。 */
  onRegistryChange: (registry: ProjectRegistry, removedKey: string | null, deleted?: boolean) => void;
  onCreated: (cwd: string, registry: ProjectRegistry) => void;
  onDefaultCwd: () => void;
  onCustomPath: () => void;
}

function parentWithSeparator(path: string | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[/\\]+$/u, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index > 0 ? `${trimmed.slice(0, index)}${separator}` : `${trimmed}${separator}`;
}

export const ProjectSwitcher = memo(function ProjectSwitcher({
  current,
  currentHidden,
  placeholder,
  projects,
  hiddenProjects,
  registry,
  homeDir,
  activity,
  sessionCounts,
  hasOtherActivity,
  hint,
  children,
  onSelect,
  onRegistryChange,
  onCreated,
  onDefaultCwd,
  onCustomPath,
}: ProjectSwitcherProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [dialog, setDialog] = useState<{ kind: ProjectActionKind; project: NamedProject } | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const label = current ? projectLabel(current) : "";
  const shortPath = current ? shortProjectPath(current.root, homeDir) : "";
  // 可见项目 ≥8 个、或展开了较长的「已隐藏」分组时才出现筛选框。
  const showFilter = projects.length >= 8 || (showHidden && hiddenProjects.length >= 8);
  const query = filter.trim().toLowerCase();
  const matches = (project: NamedProject) => !query || `${project.root} ${project.name ?? ""}`.toLowerCase().includes(query);

  const visible = useMemo(() => projects.filter(matches), [projects, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const hiddenVisible = useMemo(() => hiddenProjects.filter(matches), [hiddenProjects, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupProjectList(visible, registry), [registry, visible]);
  const pinnedHidden = current && currentHidden ? current : null;

  const closeAll = () => { setOpen(false); setFilter(""); setActionMenu(null); };
  const select = (root: string) => { closeAll(); onSelect(root); triggerRef.current?.focus({ preventScroll: true }); };

  const openActions = (project: NamedProject, hidden: boolean, element: HTMLElement, point: { x: number; y: number } | null) => {
    setActionMenu({
      project,
      hidden,
      anchor: point ? { kind: "point", ...point } : anchorFromElement(element, { align: "end" }),
      returnFocus: element,
    });
  };

  const onRowContextMenu = (project: NamedProject, hidden: boolean) => (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    openActions(project, hidden, event.currentTarget, fromKeyboard ? null : { x: event.clientX, y: event.clientY });
  };
  const onRowKeyDown = (project: NamedProject, hidden: boolean) => (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      event.stopPropagation();
      openActions(project, hidden, event.currentTarget, null);
    }
  };

  const runHide = async (project: NamedProject, hidden: boolean) => {
    try {
      const next = await setProjectHidden(project, hidden);
      onRegistryChange(next, hidden ? project.key : null);
    } catch (error) {
      console.error("[pi-web projects] hide/restore failed", error);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const renderProject = (project: NamedProject, hidden: boolean, pinned = false) => {
    const checked = project.key === current?.key;
    const stats = activity.get(project.key);
    const count = sessionCounts.get(project.key) ?? 0;
    return (
      <div key={`${hidden ? "h" : "v"}:${project.key}`} className="pw-proj-item">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={checked}
          className={hidden ? "pw-menu-item pw-menu-item--two is-hidden-project" : "pw-menu-item pw-menu-item--two"}
          title={project.root}
          onClick={() => select(project.root)}
          onContextMenu={onRowContextMenu(project, hidden)}
          onKeyDown={onRowKeyDown(project, hidden)}
        >
          <span className="pw-menu-check">{checked && <Icon name="check" />}</span>
          <span className="pw-menu-text">
            <span className="pw-menu-title">
              <span className="pw-truncate">{projectLabel(project)}</span>
              {pinned && <span className="pw-badge pw-proj-hidden-tag">已隐藏</span>}
            </span>
            <span className="pw-menu-sub">{shortProjectPath(project.root, homeDir)}</span>
          </span>
          <span className="pw-menu-meta pw-proj-meta">
            {stats && stats.running > 0 && <span className="pw-spinner pw-spinner--sm" role="status" aria-label={`${stats.running} 个会话运行中`} title={`${stats.running} 个会话运行中`} />}
            {stats && stats.unread > 0 && <span className="pw-dot" role="img" aria-label={`${stats.unread} 个会话有新回复`} title={`${stats.unread} 个会话有新回复`} />}
            <span className="pw-num" title={`${count} 个会话`}>{count}</span>
          </span>
        </button>
        {hidden && !checked ? (
          <button
            type="button"
            className="pw-btn pw-btn--ghost pw-btn--sm pw-proj-restore"
            tabIndex={-1}
            title="恢复到项目列表"
            onClick={(event) => { event.stopPropagation(); void runHide(project, false); }}
          >
            恢复
          </button>
        ) : (
          <button
            type="button"
            className="pw-icon-btn pw-icon-btn--sm pw-proj-more"
            tabIndex={-1}
            aria-label="项目操作"
            aria-haspopup="menu"
            title="项目操作"
            onClick={(event) => { event.stopPropagation(); openActions(project, hidden, event.currentTarget, null); }}
          >
            <Icon name="more" />
          </button>
        )}
      </div>
    );
  };

  const totalCount = projects.length + (pinnedHidden ? 1 : 0);
  const hiddenOthers = hiddenVisible.filter((project) => project.key !== pinnedHidden?.key);

  return (
    <div className="pw-proj">
      <button
        ref={triggerRef}
        type="button"
        className="pw-proj-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `当前项目：${label}${currentHidden ? "（已隐藏）" : ""}` : placeholder || "选择项目"}
        title={current ? [current.root, hint].filter(Boolean).join("\n") : undefined}
        onClick={() => { if (open) closeAll(); else setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); }
          else if (current && ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu")) {
            event.preventDefault();
            openActions(current, currentHidden, event.currentTarget, null);
          }
        }}
        onContextMenu={current ? onRowContextMenu(current, currentHidden) : undefined}
      >
        <span className="pw-proj-avatar" aria-hidden="true">{current ? projectInitial(label) : <Icon name="folder" size={14} />}</span>
        <span className="pw-proj-text">
          {current ? (
            <>
              <span className="pw-proj-name">
                <span className="pw-truncate">{label}</span>
                {currentHidden && <span className="pw-badge pw-proj-hidden-tag">已隐藏</span>}
              </span>
              <span className="pw-proj-path">{shortPath}</span>
            </>
          ) : placeholder ? (
            <span className="pw-proj-name is-placeholder">{placeholder}</span>
          ) : (
            <span className="pw-skeleton pw-proj-skeleton" aria-label="正在载入项目" />
          )}
        </span>
        {hasOtherActivity && <span className="pw-dot" role="img" aria-label="其他项目有新活动" title="其他项目有新活动" />}
        <Icon name="updown" size={14} className="pw-proj-chevron" />
      </button>
      {children}

      {open && (
        <PopMenu
          anchor={anchorFromElement(triggerRef.current, { matchWidth: true, offset: 4 })}
          width={triggerRef.current?.getBoundingClientRect().width}
          ariaLabel="切换项目"
          returnFocus={triggerRef.current}
          initialFocus="checked"
          className="pw-proj-menu"
          ignoreOutside={(target) => Boolean(triggerRef.current?.contains(target))}
          onClose={() => closeAll()}
        >
          <div className="pw-menu-header"><span>项目</span><span className="pw-num">{totalCount}</span></div>
          {showFilter && (
            <input
              className="pw-menu-filter"
              data-autofocus=""
              value={filter}
              placeholder="筛选项目"
              aria-label="筛选项目"
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          {pinnedHidden && matches(pinnedHidden) && renderProject(pinnedHidden, true, true)}
          {groups.map((group) => (
            <div key={group.root || "uncategorized"} role="group" aria-label={group.name || undefined}>
              {groups.length > 1 && group.name && (
                <div className="pw-proj-group" data-pi-project-category={group.name}>{group.name}<span className="pw-num">{group.projects.length}</span></div>
              )}
              {group.projects.map((project) => renderProject(project, false))}
            </div>
          ))}
          {visible.length === 0 && !pinnedHidden && <div className="pw-menu-empty">{query ? "没有匹配的项目" : "还没有项目"}</div>}
          {hiddenOthers.length > 0 && (
            <>
              <button
                type="button"
                role="menuitem"
                className="pw-menu-item pw-proj-hidden-toggle"
                aria-expanded={showHidden || Boolean(query)}
                onClick={() => setShowHidden((value) => !value)}
              >
                <Icon name={showHidden || query ? "down" : "right"} size={14} />
                <span className="pw-menu-label">已隐藏</span>
                <span className="pw-menu-meta pw-num">{hiddenOthers.length}</span>
              </button>
              {(showHidden || Boolean(query)) && hiddenOthers.map((project) => renderProject(project, true))}
            </>
          )}
          <div className="pw-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { closeAll(); setCreating(true); }}>
            <Icon name="plus" /><span className="pw-menu-label">新建项目…</span>
          </button>
          <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { closeAll(); onDefaultCwd(); }}>
            <Icon name="home" /><span className="pw-menu-label">使用默认目录</span>
          </button>
          <button type="button" role="menuitem" className="pw-menu-item" onClick={() => { closeAll(); onCustomPath(); }}>
            <Icon name="folderOpen" /><span className="pw-menu-label">自定义路径…</span>
          </button>

          {actionMenu && (
            <ProjectActionMenu
              project={actionMenu.project}
              hidden={actionMenu.hidden}
              anchor={actionMenu.anchor}
              returnFocus={actionMenu.returnFocus}
              onClose={() => setActionMenu(null)}
              onAction={(kind) => { const project = actionMenu.project; closeAll(); setDialog({ kind, project }); }}
              onHide={() => { const project = actionMenu.project; setActionMenu(null); void runHide(project, true); }}
              onRestore={() => { const project = actionMenu.project; setActionMenu(null); void runHide(project, false); }}
            />
          )}
        </PopMenu>
      )}

      {!open && actionMenu && (
        <ProjectActionMenu
          project={actionMenu.project}
          hidden={actionMenu.hidden}
          anchor={actionMenu.anchor}
          returnFocus={actionMenu.returnFocus}
          onClose={() => setActionMenu(null)}
          onAction={(kind) => { const project = actionMenu.project; setActionMenu(null); setDialog({ kind, project }); }}
          onHide={() => { const project = actionMenu.project; setActionMenu(null); void runHide(project, true); }}
          onRestore={() => { const project = actionMenu.project; setActionMenu(null); void runHide(project, false); }}
        />
      )}

      {dialog && (
        <ProjectActionDialog
          kind={dialog.kind}
          project={dialog.project}
          returnFocus={triggerRef.current}
          onClose={() => setDialog(null)}
          onChanged={(registry, removed) => onRegistryChange(registry, removed ? dialog.project.key : null, dialog.kind === 'delete')}
        />
      )}
      {creating && (
        <CreateProjectDialog
          initialCwd={parentWithSeparator(current?.root)}
          returnFocus={triggerRef.current}
          onClose={() => setCreating(false)}
          onCreated={onCreated}
        />
      )}
      {notice && <NoticeDialog title="操作失败" message={notice} returnFocus={triggerRef.current} onClose={() => setNotice(null)} />}
    </div>
  );
});
