"use client";
// 左栏（方向 A「安静时间线」spec §2）：SidebarHeader → ProjectSwitcher(+WorktreeSwitcher) → SessionList → FileDrawer。
// 本文件只保留数据与状态机（会话目录加载/轮询、运行中/未读、项目注册表、worktree、首屏恢复、自定义路径），
// 展示拆到 components/sidebar/*。样式全部在 app/redesign-sidebar.css，组件里不写内联颜色。
import { filterSessionsForWorktree } from "@/lib/pi-portable-runtime.js";
import { hiddenProjectList, remapProjectSession, visibleProjectList, projectRequest, type NamedProject, type ProjectRegistry } from './PortableProjects';

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies } from "@/lib/session-family";
import { getProjectActivity, getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { useI18n } from "@/hooks/useI18n";
// 目录浏览器只在「自定义路径」时打开，走 next/dynamic（lazy-panels.tsx，P27）。
import { DirectoryPicker } from "./lazy-panels";
import { FileDrawer } from "./sidebar/FileDrawer";
import { Icon } from "./sidebar/icons";
import { ProjectSwitcher } from "./sidebar/ProjectSwitcher";
import { projectLabel, shortProjectPath } from "./sidebar/project-label";
import { pathWithinRoot, projectRemovalAction } from "./sidebar/project-removal";
import { SessionList } from "./sidebar/SessionList";
import { sameIdSet, shareJson, shareSessionList } from "./sidebar/shared-state";
import { WorktreeSwitcher, type WorktreeEntry } from "./sidebar/WorktreeSwitcher";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function sessionListUrl(summary: boolean, force: boolean): string {
  if (summary) return "/api/sessions?summary=1";
  if (force) return "/api/sessions?force=1";
  return "/api/sessions";
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;
const SESSION_DETAILS_HYDRATION_DELAY_MS = 750;
/** 文件抽屉展开时会话列表至少保留的行数（spec §2.5） */
const MIN_VISIBLE_SESSION_ROWS = 6;
const SESSION_ROW_HEIGHT = 30;
const DRAWER_CHROME_HEIGHT = 38 + 7;

/** 子代理字形：与设置页「子代理」分页同一个机器人图标（SettingsPanel.test 锁定两处一致）。 */
const SUBAGENT_GLYPH = (
  <svg className="pw-i" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="5" y="7" width="14" height="11" rx="2" />
    <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
  </svg>
);

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** 稳定引用的回调：下游 memo 组件不因父组件传入的新函数而重渲染。 */
function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const ref = useRef(callback);
  useLayoutEffect(() => { ref.current = callback; });
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  // Tracked in a ref only: the version is compared against the polled value to
  // decide whether the list needs reloading, and no render reads it.
  const sessionListVersionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  // 正在进行的列表请求数：首屏 summary 还没回来时，轮询不能因「版本号还是 null」再发一次全量请求
  // 并把 summary 的结果作废（审计 P10 的挂载竞态）。
  const sessionLoadsInFlightRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [projectRegistry, setProjectRegistry] = useState<ProjectRegistry>({ projects: [], hidden: [] });
  // 已永久删除的项目目录：当前项目被删光后，文件抽屉不能再回退去绑定打开会话里那个已不存在的 cwd。
  const [deletedRoots, setDeletedRoots] = useState<readonly string[]>([]);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const detailsHydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /** 只有内容变化才换新的 Set：轮询每 2.5 秒一次，内容不变不触发任何重渲染（审计 P10）。 */
  const updateRunningSessionIds = useCallback((ids: readonly string[]) => {
    setRunningSessionIds((previous) => {
      const next = new Set(ids);
      return sameIdSet(previous, next) ? previous : next;
    });
  }, []);

  const loadSessions = useCallback(async (showLoading = false, force = false, summary = false) => {
    const loadId = ++sessionLoadIdRef.current;
    sessionLoadsInFlightRef.current += 1;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(sessionListUrl(summary, force), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        portableProjects: ProjectRegistry;
        sessionListVersion: number;
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      // 结构共享：内容没变的行沿用旧对象，整表没变就沿用旧数组。
      setAllSessions((previous) => shareSessionList(previous, data.sessions));
      if (data.portableProjects) setProjectRegistry((previous) => shareJson(previous, data.portableProjects));
      else console.error("[pi-web projects] server project registry missing; check package version");
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        updateRunningSessionIds(data.runningSessionIds ?? []);
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) {
        console.error("[pi-web sidebar] session list load failed:", e);
        setError(String(e));
      }
    } finally {
      sessionLoadsInFlightRef.current -= 1;
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, [updateRunningSessionIds]);

  useEffect(() => {
    const refresh = () => { void loadSessions(false, true); };
    document.addEventListener('pi-web:refresh-sessions', refresh);
    return () => document.removeEventListener('pi-web:refresh-sessions', refresh);
  }, [loadSessions]);
  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    let active = true;

    if (isFirst) {
      // Header/stat metadata is enough to select the URL session and paint the
      // sidebar. Hydrate exact counts, names, and first messages once the
      // selected chat has had a chance to start loading. The hydration reuses the
      // server cache instead of forcing a rescan: a forced scan bumps the global
      // list version and makes every other open client re-download the list.
      void loadSessions(true, false, true).then(() => {
        if (!active) return;
        detailsHydrationTimerRef.current = setTimeout(() => {
          detailsHydrationTimerRef.current = null;
          if (active) void loadSessions(false, false);
        }, SESSION_DETAILS_HYDRATION_DELAY_MS);
      });
    } else {
      void loadSessions(false, true);
    }

    return () => {
      active = false;
      if (detailsHydrationTimerRef.current) {
        clearTimeout(detailsHydrationTimerRef.current);
        detailsHydrationTimerRef.current = null;
      }
    };
  }, [loadSessions, refreshKey]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          sessionListVersion: number;
          runningSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        updateRunningSessionIds(data.runningSessionIds ?? []);
        // A list request already in flight (the first-paint summary, a lifecycle
        // refresh) carries its own version; the next poll compares again.
        if (data.sessionListVersion !== sessionListVersionRef.current && sessionLoadsInFlightRef.current === 0) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSessions, updateRunningSessionIds]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch((cause) => console.error("[pi-web sidebar] home directory unavailable:", cause));
  }, []);

  const restoredRef = useRef(false);
  const restoredSnapshotIdRef = useRef<string | null>(null);
  // Restore only the selected row metadata immediately; refresh from disk in parallel.
  useEffect(() => {
    if (!initialSessionId || skipInitialProjectSelection || restoredRef.current) return;
    try {
      const stored = localStorage.getItem('pi-web:last-selected-info');
      const info = stored ? JSON.parse(stored) as SessionInfo : null;
      if (!info || info.id !== initialSessionId) return;
      if (typeof info.cwd !== 'string' || typeof info.path !== 'string' || typeof info.firstMessage !== 'string' || typeof info.created !== 'string' || typeof info.modified !== 'string' || typeof info.messageCount !== 'number') {
        console.error('[pi-web] initial session preview invalid; waiting for catalogue');
        return;
      }
      restoredRef.current = true;
      restoredSnapshotIdRef.current = info.id;
      setSelectedCwd(info.cwd);
      onSelectSession(info, true);
    } catch (error) { console.error('[pi-web] initial session preview unavailable:', error); }
  }, [initialSessionId, skipInitialProjectSelection, onSelectSession]);
  useEffect(() => {
    const id = restoredSnapshotIdRef.current;
    if (loading || error || !id) return;
    restoredSnapshotIdRef.current = null;
    const current = allSessions.find(s => s.id === id);
    if (!current && selectedSessionId === id) {
      try { localStorage.removeItem('pi-web:last-selected-info'); } catch (cause) { console.error('[pi-web] preview cleanup failed:', cause); }
      onSessionDeleted?.(id);
    }
  }, [allSessions, loading, error, selectedSessionId, onSessionDeleted]);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          if (d.error) console.error("[pi-web sidebar] worktree lookup failed:", d.error);
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch((cause) => {
        if (!cancelled) {
          console.error("[pi-web sidebar] worktree request failed:", cause);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
    // explorerRefreshKey: an agent turn may have switched branch or added a worktree
    // (AppShell bumps it on agent end; the session list no longer force-reloads then).
  }, [selectedCwd, wtRefreshKey, refreshKey, explorerRefreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (loading || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = visibleProjectList(getRecentProjects(allSessions), projectRegistry);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, loading, projectRegistry, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      const registry = await projectRequest('/api/projects', { action: 'add', cwd: data.cwd });
      setProjectRegistry(registry);
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useStableCallback(() => {
    // 没有记住的自定义路径时，从当前项目所在目录开始浏览，而不是从盘符根目录开始。
    if (!customPathValue.trim() && selectedProject?.root) setCustomPathValue(selectedProject.root);
    setCustomPathOpen(true);
    setCustomPathError(null);
  });
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
      } else if (data.error) {
        console.error("[pi-web sidebar] default directory unavailable:", data.error);
      }
    } catch (cause) {
      console.error("[pi-web sidebar] default directory request failed:", cause);
    }
  }, []);

  const handleCreateWorktree = useCallback(async (): Promise<boolean> => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return false;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
      return true;
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  const dismissWorktreeMenu = useCallback(() => {
    setWtNewOpen(false);
    setWtNewBranch("");
    setWtError(null);
    setWtConfirmRemove(null);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useStableCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId, blockIndex);
  });

  const handleNewSession = useStableCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  });

  const applyProjectChange = useStableCallback((registry: ProjectRegistry, removedKey: string | null, deleted = false) => {
    setProjectRegistry(registry);
    if (registry.cwd && registry.previousRoot) {
      setAllSessions(previous => previous.map(s => remapProjectSession(s, registry)));
      if (selectedCwd === registry.previousRoot) setSelectedCwd(registry.cwd);
      const selected = allSessions.find(s => s.id === selectedSessionId);
      if (selected && registry.sessionIds?.includes(selected.id)) handleSelectSessionFromList(remapProjectSession(selected, registry));
      void loadSessions(false, true);
    }
    // 当前项目被移除后切到剩余的第一个可见项目（没有就回到空态）：
    // 永久删除：目录已不存在，一律切走并放掉文件抽屉的绑定；隐藏：有打开的会话就保留（置顶显示「已隐藏」）。
    if (projectRemovalAction({ removedKey, currentKey: selectedProject?.key ?? null, deleted, hasOpenSession: Boolean(selectedSessionId) }) === "switch") {
      if (deleted && selectedProject) setDeletedRoots((previous) => [...previous, selectedProject.root]);
      setSelectedCwd(visibleProjectList(getRecentProjects(allSessions), registry)[0]?.root ?? null);
    }
  });

  const handleProjectCreated = useStableCallback((cwd: string, registry: ProjectRegistry) => {
    setProjectRegistry(registry);
    setSelectedCwd(cwd);
    saveLastCustomCwd(cwd);
  });

  const handleSelectProject = useStableCallback((root: string) => {
    setSelectedCwd(root);
    setCustomPathOpen(false);
    setCustomPathError(null);
  });

  const reloadSessions = useStableCallback(() => { void loadSessions(); });
  const retrySessions = useStableCallback(() => { void loadSessions(true, true); });
  const handleMoved = useStableCallback((info: SessionInfo) => { void loadSessions(false, true); handleSelectSessionFromList(info); });
  const handleDeleted = useStableCallback((id: string) => { onSessionDeleted?.(id); void loadSessions(); });
  const closeSearch = useStableCallback(() => { setSessionSearchOpen(false); setSessionSearchQuery(""); });
  const stableOpenFile = useStableCallback((filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => onOpenFile?.(filePath, fileName, options));
  const stableOpenTerminal = useStableCallback((cwd: string) => onOpenTerminal?.(cwd));
  const stableAtMention = useStableCallback((relativePath: string, isDir: boolean) => onAtMention?.(relativePath, isDir));
  const stableAtMentions = useStableCallback((relativePaths: string[]) => onAtMentions?.(relativePaths));
  const stableExplorerRefresh = useStableCallback(() => onExplorerRefresh?.());

  const openSearch = useCallback(() => {
    setSessionSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  // Ctrl K：打开并聚焦会话搜索（与现有快捷键不冲突）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearch]);

  const recentProjectsRaw = useMemo(() => getRecentProjects(allSessions), [allSessions]);
  const recentProjects = useMemo(() => visibleProjectList(recentProjectsRaw, projectRegistry), [recentProjectsRaw, projectRegistry]);
  const hiddenProjects = useMemo(() => hiddenProjectList(recentProjectsRaw, projectRegistry), [recentProjectsRaw, projectRegistry]);

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = useMemo(() => projectFor(selectedCwd), [projectFor, selectedCwd]);
  const projectNames = useMemo(() => new Map(projectRegistry.projects.map((project) => [project.key, project.name])), [projectRegistry]);
  const currentProject = useMemo<NamedProject | null>(() => (
    selectedProject ? { ...selectedProject, name: projectNames.get(selectedProject.key) } : null
  ), [projectNames, selectedProject]);
  const currentHidden = Boolean(selectedProject && projectRegistry.hidden.includes(selectedProject.key));

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );
  const projectSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of allSessions) {
      if (session.relation?.kind === "subagent") continue;
      const key = workspaceKeyOf(session);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [allSessions]);

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const filteredSessions = useMemo(
    () => selectedProject ? sessionsForProject(allSessions, selectedProject.key) : allSessions,
    [allSessions, selectedProject],
  );
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  // 非 Git 项目、仓库子目录不渲染分支行，说明放进项目切换器的悬停提示。
  const worktreeHint = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit ? t("sidebar.openRepoRootTitle") : t("sidebar.gitRepoRootOnlyTitle"))
    : null;

  const categorySessions = useMemo(() => showWorktreeSwitcher ? filterSessionsForWorktree(filteredSessions, worktreeState, selectedCwd) : filteredSessions, [filteredSessions, showWorktreeSwitcher, worktreeState, selectedCwd]);
  const sessionFamilies = useMemo(() => listSessionFamilies(categorySessions), [categorySessions]);
  const worktreeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!showWorktreeSwitcher || !worktreeState) return counts;
    for (const worktree of worktreeState.worktrees) {
      counts.set(worktree.path, listSessionFamilies(filterSessionsForWorktree(filteredSessions, worktreeState, worktree.path)).length);
    }
    return counts;
  }, [filteredSessions, showWorktreeSwitcher, worktreeState]);

  const displayPath = useCallback((path: string) => shortProjectPath(path, homeDir), [homeDir]);
  const labelForSession = useCallback((session: SessionInfo) => projectLabel({
    name: projectNames.get(workspaceKeyOf(session)),
    root: session.projectRoot ?? session.cwd,
  }), [projectNames]);

  const getSidebarHeight = useCallback(() => rootRef.current?.getBoundingClientRect().height ?? 0, []);
  const getDrawerMaxHeight = useCallback(() => {
    const root = rootRef.current;
    const head = root?.querySelector(".pw-sess-head");
    if (!root || !head) return 10000;
    const rootRect = root.getBoundingClientRect();
    const listTop = head.getBoundingClientRect().bottom - rootRect.top;
    return Math.floor(rootRect.height - listTop - MIN_VISIBLE_SESSION_ROWS * SESSION_ROW_HEIGHT - 8 - DRAWER_CHROME_HEIGHT);
  }, []);

  const drawerCwd = selectedCwd
    ?? (selectedCwdProp && !deletedRoots.some((root) => pathWithinRoot(selectedCwdProp, root)) ? selectedCwdProp : null);
  const placeholder = initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject");

  return (
    <div ref={rootRef} className="pw-sb">
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}

      <header className="pw-sb-header">
        <div
          className="pw-sb-brand"
          title={`Pi Web ${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"} · pi ${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}`}
        >
          <span className="pw-sb-brand-mark" aria-hidden="true">π</span>
          <span>Pi Web</span>
        </div>
        <div className="pw-sb-header-actions">
          <button
            type="button"
            className="pw-icon-btn"
            onClick={() => { if (sessionSearchOpen) closeSearch(); else openSearch(); }}
            title={`${t("sidebar.toggleSessionSearch")}（Ctrl K）`}
            aria-label={t("sidebar.toggleSessionSearch")}
            aria-expanded={sessionSearchOpen}
            aria-controls="session-search-input"
            aria-pressed={sessionSearchOpen}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="pw-btn pw-sb-new"
            onClick={handleNewSession}
            disabled={!selectedCwd}
            title={selectedCwd ? `${t("sidebar.newSessionTitle", { path: selectedCwd })}（Ctrl Alt N）` : t("sidebar.selectProject")}
          >
            <Icon name="newChat" size={14} />
            {t("sidebar.new")}
          </button>
        </div>
      </header>

      <ProjectSwitcher
        current={currentProject}
        currentHidden={currentHidden}
        placeholder={placeholder}
        projects={recentProjects}
        hiddenProjects={hiddenProjects}
        registry={projectRegistry}
        homeDir={homeDir}
        activity={projectActivity}
        sessionCounts={projectSessionCounts}
        hasOtherActivity={hasOtherWorkspaceActivity}
        hint={worktreeHint}
        onSelect={handleSelectProject}
        onRegistryChange={applyProjectChange}
        onCreated={handleProjectCreated}
        onDefaultCwd={handleDefaultCwd}
        onCustomPath={handleCustomPathClick}
      >
        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher && worktreeState && (
          <WorktreeSwitcher
            worktrees={worktreeState.worktrees}
            current={currentWorktree}
            currentPath={currentWorktreePath}
            sessionCount={sessionFamilies.length}
            countsByPath={worktreeCounts}
            displayPath={displayPath}
            busy={wtBusy}
            error={wtError}
            confirmRemove={wtConfirmRemove}
            newOpen={wtNewOpen}
            newBranch={wtNewBranch}
            onSelect={(path) => { setSelectedCwd(path); setWtError(null); }}
            onRemove={handleRemoveWorktree}
            onCancelRemove={() => setWtConfirmRemove(null)}
            onNewOpenChange={(open) => { setWtNewOpen(open); setWtError(null); if (!open) setWtNewBranch(""); }}
            onNewBranchChange={(value) => { setWtNewBranch(value); setWtError(null); }}
            onCreate={handleCreateWorktree}
            onDismiss={dismissWorktreeMenu}
          />
        )}
      </ProjectSwitcher>

      <SessionList
        families={sessionFamilies}
        loading={loading}
        error={error}
        selectedSessionId={selectedSessionId}
        runningSessionIds={runningSessionIds}
        unreadSessionIds={unreadSessionIds}
        projects={recentProjects}
        canCreate={Boolean(selectedCwd)}
        searchOpen={sessionSearchOpen}
        searchQuery={sessionSearchQuery}
        searchInputRef={searchInputRef}
        listScrollRef={listScrollRef}
        subagentGlyph={SUBAGENT_GLYPH}
        labelForSession={labelForSession}
        onSearchQueryChange={setSessionSearchQuery}
        onSearchClose={closeSearch}
        onSelect={handleSelectSessionFromList}
        onNewSession={handleNewSession}
        onRetry={retrySessions}
        onRenamed={reloadSessions}
        onMoved={handleMoved}
        onDeleted={handleDeleted}
      />

      {drawerCwd && (
        <FileDrawer
          cwd={drawerCwd}
          rootLabel={currentProject ? projectLabel(currentProject) : projectLabel({ root: drawerCwd })}
          explorerRefreshKey={explorerRefreshKey}
          getSidebarHeight={getSidebarHeight}
          getMaxHeight={getDrawerMaxHeight}
          onOpenFile={stableOpenFile}
          onOpenTerminal={onOpenTerminal ? stableOpenTerminal : undefined}
          onExplorerRefresh={onExplorerRefresh ? stableExplorerRefresh : undefined}
          onAtMention={onAtMention ? stableAtMention : undefined}
          onAtMentions={onAtMentions ? stableAtMentions : undefined}
        />
      )}
    </div>
  );
}
