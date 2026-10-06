"use client";
// 左栏文件抽屉里的文件树（方向 A spec §2.5）。
// 性能（审计 P11）：展开状态下的树扁平成「可见行数组」，固定 26px 行高，只挂载视口 ±8 行；
// 子目录内容放在组件级 Map 里（不再每个节点各自 state），行组件 memo，悬停操作靠 CSS :hover。
// 外观：线性文件夹/文件图标（--text-dim），每级缩进 12px 带竖线参考；状态色只用语义 token。
import { forwardRef, memo, useState, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import { buildSearchTree, type SearchTreeNode } from "@/lib/search-tree";
import { useI18n } from "@/hooks/useI18n";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { Icon } from "./sidebar/icons";
type Translate = ReturnType<typeof useI18n>["t"];

const TREE_ROW_H = 26;
const TREE_OVERSCAN = 8;

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  fileSearchOpen?: boolean;
  onFileSearchOpenChange?: (open: boolean) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

/** 状态码颜色走语义 token：修改=警示，新增/未跟踪=成功，删除/冲突=危险，重命名=主色。 */
const GIT_STATUS_TONES: Record<GitFileStatusKind, "warning" | "success" | "danger" | "accent"> = {
  modified: "warning",
  added: "success",
  deleted: "danger",
  renamed: "accent",
  untracked: "success",
  conflict: "danger",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      className={`pw-tree-git is-${GIT_STATUS_TONES[status.status]}`}
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
    >
      {status.code}
    </span>
  );
}

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 12 }: { size?: number }) {
  return <Icon name="at" size={size} />;
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button type="button" className="pw-icon-btn pw-icon-btn--sm" onClick={onClick} title={title} aria-label={title}>
      <Icon name="close" />
    </button>
  );
}

function isDimmedName(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

interface TreeRowProps {
  node: FileNode;
  depth: number;
  open: boolean;
  loading: boolean;
  highlighted: boolean;
  gitStatus: GitFileStatus | undefined;
  containsGitChanges: boolean;
  cwd: string;
  onToggle: (node: FileNode, open: boolean) => void;
  onOpenFile: OpenFileHandler;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  t: Translate;
}

/** 一行文件树：文件夹点开/收起，文件打开；悬停出现「提及」和下载。 */
const TreeRow = memo(function TreeRow({
  node,
  depth,
  open,
  loading,
  highlighted,
  gitStatus,
  containsGitChanges,
  cwd,
  onToggle,
  onOpenFile,
  onAtMention,
  t,
}: TreeRowProps) {
  const handleClick = () => {
    if (node.isDir) onToggle(node, !open);
    else onOpenFile(node.fullPath, node.name);
  };
  return (
    <div
      className={`pw-tree-row${isDimmedName(node.name) ? " is-dim" : ""}${node.isDir ? " is-dir" : ""}`}
      style={{ "--depth": depth } as CSSProperties}
      onClick={handleClick}
      title={node.fullPath}
    >
      <span className="pw-tree-twisty" aria-hidden="true">
        {node.isDir && <Icon name={open ? "down" : "right"} size={12} />}
      </span>
      <Icon name={node.isDir ? (open ? "folderOpen" : "folder") : "file"} size={14} className="pw-tree-icon" />
      <span className="pw-tree-name">{node.name}</span>
      {highlighted && <span className="pw-dot pw-tree-mark" role="img" title={t("files.newlyUploaded")} aria-label={t("files.newlyUploaded")} />}
      {!node.isDir && gitStatus && <GitStatusBadge status={gitStatus} t={t} />}
      {containsGitChanges && <span className="pw-dot pw-dot--warning pw-tree-mark" role="img" title={t("files.containsChangedFiles")} aria-label={t("files.containsChangedFiles")} />}
      {loading && <span className="pw-spinner pw-spinner--sm pw-spinner--current" role="status" aria-label={t("files.loading")} />}
      <span className="pw-tree-actions">
        {onAtMention && (
          <button
            type="button"
            className="pw-tree-action is-accent"
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files.insertPath")}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {!node.isDir && (
          <a
            className="pw-tree-action"
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            aria-label={t("files.download")}
          >
            <Icon name="download" size={12} />
          </a>
        )}
      </span>
    </div>
  );
});

/** 搜索结果树（结果有上限，直接递归渲染）：子节点已随结果一起给出。 */
function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: OpenFileHandler;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const toggle = useCallback((target: FileNode, next: boolean) => onToggleExpanded(target.fullPath, next), [onToggleExpanded]);
  return (
    <>
      <TreeRow
        node={node}
        depth={depth}
        open={open}
        loading={false}
        highlighted={highlightedPaths.has(node.fullPath)}
        gitStatus={gitStatus}
        containsGitChanges={node.isDir && (gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath))}
        cwd={cwd}
        onToggle={toggle}
        onOpenFile={onOpenFile}
        onAtMention={onAtMention}
        t={t}
      />
      {node.isDir && open && (node.children ?? []).map((child) => (
        <TreeNode
          key={child.fullPath}
          node={child}
          depth={depth + 1}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={onToggleExpanded}
          highlightedPaths={highlightedPaths}
          gitStatusByPath={gitStatusByPath}
          changedDirectoryPaths={changedDirectoryPaths}
          t={t}
        />
      ))}
    </>
  );
}

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  onAtMention,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  t: Translate;
}) {
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  // Split the path so the directory part ellipsizes while the file name stays fully visible
  const lastSlash = rel.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
  const baseName = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
  return (
    <div
      className="pw-tree-row pw-change-row"
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      title={status.filePath}
    >
      <GitStatusBadge status={status} t={t} />
      <Icon name="file" size={14} className="pw-tree-icon" />
      <span className="pw-change-path">
        {dirPart && <span className="pw-change-dir">{dirPart}</span>}
        <span className="pw-change-base">{baseName}</span>
      </span>
      {onAtMention && (
        <span className="pw-tree-actions">
          <button
            type="button"
            className="pw-tree-action is-accent"
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(rel, false);
            }}
            title={t("files.insertPath")}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        </span>
      )}
    </div>
  );
}

type FlatRow =
  | { kind: "node"; node: FileNode; depth: number; open: boolean }
  | { kind: "loading" | "empty" | "error"; key: string; depth: number; path: string };

export const FileExplorer = memo(forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed,
  onChangesCountChange,
  fileSearchOpen = false,
  onFileSearchOpenChange,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [failedDirs, setFailedDirs] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const [viewportH, setViewportH] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCwdRef = useRef<string | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const childrenRef = useRef(childrenByPath);
  childrenRef.current = childrenByPath;
  const expandedRef = useRef(expandedPaths);
  expandedRef.current = expandedPaths;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const stableOpenFile = useCallback<OpenFileHandler>((...args) => onOpenFileRef.current(...args), []);
  const uploadBusy = uploadPhase !== "idle";
  const hasSearchQuery = searchQuery.trim().length > 0;
  useScrollbarVisibility(scrollRef);

  // Reuse the cached, bounded file index used by @ mentions.
  useEffect(() => {
    if (!fileSearchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchPaths([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(false);
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ matches?: FileIndexEntry[] }> : Promise.reject(new Error("Search failed")))
        .then((data) => setSearchPaths((data.matches ?? []).filter((entry) => !entry.isDir).map((entry) => entry.path)))
        .catch((cause) => {
          if (!controller.signal.aborted) {
            console.error("[pi-web files] file search failed:", cause);
            setSearchPaths([]);
            setSearchError(true);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, fileSearchOpen, searchQuery]);

  // Focus the search input whenever the search panel opens.
  useEffect(() => {
    if (fileSearchOpen) searchInputRef.current?.focus();
  }, [fileSearchOpen]);

  // Results render as a tree; keep every directory that contains a match
  // expanded, while preserving the user's manual collapses as they type.
  useEffect(() => {
    if (searchPaths.length === 0) return;
    const dirs = new Set<string>();
    for (const relative of searchPaths) {
      const parts = relative.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        dirs.add(joinFilePath(cwd, path));
      }
    }
    setSearchExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of dirs) {
        if (!next.has(dir)) { next.add(dir); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [cwd, searchPaths]);

  const searchRoots = useMemo(() => {
    const toFileNode = (node: SearchTreeNode): FileNode => ({
      name: node.name,
      fullPath: joinFilePath(cwd, node.path),
      isDir: node.isDir,
      size: 0,
      children: node.children.map(toFileNode),
      loaded: true,
    });
    return buildSearchTree(searchPaths).map(toFileNode);
  }, [cwd, searchPaths]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const loadDir = useCallback(async (path: string, force = false) => {
    if (!force && childrenRef.current.has(path)) return;
    const owner = cwdRef.current;
    setLoadingDirs((prev) => new Set(prev).add(path));
    try {
      const entries = await fetchEntries(path);
      if (cwdRef.current !== owner) return;
      setChildrenByPath((prev) => new Map(prev).set(path, entries));
      setFailedDirs((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } catch (cause) {
      console.error("[pi-web files] directory listing failed:", path, cause);
      if (cwdRef.current === owner) setFailedDirs((prev) => new Set(prev).add(path));
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleToggleNode = useCallback((node: FileNode, open: boolean) => {
    handleToggleExpanded(node.fullPath, open);
    if (open) void loadDir(node.fullPath);
  }, [handleToggleExpanded, loadDir]);

  const handleSearchToggle = useCallback((fullPath: string, open: boolean) => {
    setSearchExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setChildrenByPath(new Map());
      setFailedDirs(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
    } else {
      // Tree refresh: re-list every open directory that was already loaded.
      for (const path of expandedRef.current) {
        if (childrenRef.current.has(path)) void loadDir(path, true);
      }
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => {
        if (cancelled) return;
        console.error("[pi-web files] root listing failed:", cwd, e);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, loadDir, refreshKey, treeRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  // 展开状态下的可见行（扁平）；只有这一份决定虚拟列表的高度。
  const flatRows = useMemo(() => {
    const out: FlatRow[] = [];
    const walk = (nodes: FileNode[], depth: number) => {
      for (const node of nodes) {
        const open = node.isDir && expandedPaths.has(node.fullPath);
        out.push({ kind: "node", node, depth, open });
        if (!open) continue;
        const children = childrenByPath.get(node.fullPath);
        if (children === undefined) {
          if (failedDirs.has(node.fullPath)) out.push({ kind: "error", key: `${node.fullPath}:error`, depth: depth + 1, path: node.fullPath });
          else out.push({ kind: "loading", key: `${node.fullPath}:loading`, depth: depth + 1, path: node.fullPath });
        } else if (children.length === 0) {
          out.push({ kind: "empty", key: `${node.fullPath}:empty`, depth: depth + 1, path: node.fullPath });
        } else {
          walk(children, depth + 1);
        }
      }
    };
    walk(roots, 0);
    return out;
  }, [childrenByPath, expandedPaths, failedDirs, roots]);

  const showTree = (changesCollapsed || gitFiles.length === 0) && (!fileSearchOpen || !hasSearchQuery);
  const treeRowCount = showTree && !loading && !error ? flatRows.length : 0;

  const syncRange = useCallback(() => {
    const element = scrollRef.current;
    const top = element?.scrollTop ?? 0;
    const height = element?.clientHeight || viewportH || 400;
    const start = Math.max(0, Math.floor(top / TREE_ROW_H) - TREE_OVERSCAN);
    const end = Math.min(treeRowCount, Math.ceil((top + height) / TREE_ROW_H) + TREE_OVERSCAN);
    setRange((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, [treeRowCount, viewportH]);

  useLayoutEffect(() => { syncRange(); }, [syncRange]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setViewportH(Math.round(entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      syncRange();
    });
  }, [syncRange]);
  useEffect(() => () => { if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current); }, []);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  const renderFlatRow = (row: FlatRow, index: number) => {
    const style = { position: "absolute", top: index * TREE_ROW_H, left: 0, right: 0 } as CSSProperties;
    if (row.kind !== "node") {
      return (
        <div key={row.key} className={`pw-tree-row pw-tree-note${row.kind === "error" ? " is-error" : ""}`} style={{ ...style, "--depth": row.depth } as CSSProperties}>
          <span className="pw-tree-twisty" />
          {row.kind === "loading" && <span className="pw-skeleton pw-tree-skeleton" aria-label={t("files.loading")} />}
          {row.kind === "empty" && <span>空目录</span>}
          {row.kind === "error" && (
            <>
              <span>读取失败</span>
              <button type="button" className="pw-tree-action is-accent is-inline" onClick={(e) => { e.stopPropagation(); void loadDir(row.path, true); }}>重试</button>
            </>
          )}
        </div>
      );
    }
    const { node, depth, open } = row;
    const normalizedPath = normalizeFilePathSlashes(node.fullPath);
    const gitStatus = gitStatusByPath.get(normalizedPath);
    return (
      <div key={node.fullPath} style={style}>
        <TreeRow
          node={node}
          depth={depth}
          open={open}
          loading={loadingDirs.has(node.fullPath)}
          highlighted={highlightedPaths.has(node.fullPath)}
          gitStatus={gitStatus}
          containsGitChanges={node.isDir && (gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath))}
          cwd={cwd}
          onToggle={handleToggleNode}
          onOpenFile={stableOpenFile}
          onAtMention={onAtMention}
          t={t}
        />
      </div>
    );
  };

  return (
    <div className="pw-fx">
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div className="pw-fx-feedback">
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div className="pw-fx-progress-line">
              {uploadPhase === "checking" ? (
                <span className="pw-spinner pw-spinner--current" aria-hidden="true" />
              ) : (
                <Icon name="upload" size={14} />
              )}
              <span>{uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}</span>
            </div>
            {uploadPhase === "uploading" && (
              <div className="pw-fx-progress"><div className="pw-fx-progress-bar" style={{ transform: `scaleX(${uploadProgress / 100})` }} /></div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" className="pw-fx-conflict">
            <div className="pw-fx-conflict-text">
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div className="pw-fx-conflict-warn">
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div className="pw-fx-conflict-actions">
              <button type="button" className="pw-btn pw-btn--danger pw-btn--sm" onClick={() => void performUpload(pendingConflict.files, "overwrite")}>
                {t("files.replace")}
              </button>
              <button type="button" className="pw-btn pw-btn--sm" onClick={() => void performUpload(pendingConflict.files, "skip")}>
                {t("files.skipExisting")}
              </button>
              <button type="button" className="pw-btn pw-btn--ghost pw-btn--sm" onClick={() => setPendingConflict(null)}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" className="pw-fx-error">
            <span>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div className="pw-fx-summary">
              <div className="pw-fx-summary-counts">
                {uploadSummary.uploaded.length > 0 && (
                  <span className="is-success" title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`}>
                    <Icon name="check" size={14} />
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`}>
                    <Icon name="close" size={14} />
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span className="is-danger" title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`}>
                    <Icon name="alert" size={14} />
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  className="pw-btn pw-btn--sm pw-fx-mention"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} className="pw-fx-summary-error">
                <Icon name="alert" size={12} />
                <span className="pw-truncate">{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {fileSearchOpen && (
      <div className="pw-fx-search">
        <div className="pw-field pw-fx-search-field">
          <Icon name="search" size={14} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); onFileSearchOpenChange?.(false); }
            }}
            placeholder={t("sidebar.searchFilesPlaceholder")}
            aria-label={t("sidebar.searchFiles")}
          />
          {searchQuery && (
            <button
              type="button"
              className="pw-icon-btn pw-icon-btn--sm"
              onClick={() => setSearchQuery("")}
              title={t("sidebar.clearSearch")}
              aria-label={t("sidebar.clearSearch")}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>
      )}

      <div ref={scrollRef} className="pw-fx-scroll scrollbar-subtle" onScroll={handleScroll}>
        {fileSearchOpen && hasSearchQuery && (
          <div className="pw-fx-results">
            {searchLoading && <div role="status" className="pw-fx-note">{t("sidebar.searchingFiles")}</div>}
            {!searchLoading && searchError && <div role="alert" className="pw-fx-note is-error">{t("i18n.networkError")}</div>}
            {!searchLoading && !searchError && searchPaths.length === 0 && <div className="pw-fx-note">{t("sidebar.noMatchingFiles")}</div>}
            {!searchLoading && !searchError && searchPaths.length > 0 && (
              <div>
                {searchRoots.map((node) => (
                  <TreeNode
                    key={`${searchQuery}:${node.fullPath}`}
                    node={node}
                    depth={0}
                    cwd={cwd}
                    onOpenFile={stableOpenFile}
                    onAtMention={onAtMention}
                    expandedPaths={searchExpanded}
                    onToggleExpanded={handleSearchToggle}
                    highlightedPaths={highlightedPaths}
                    gitStatusByPath={gitStatusByPath}
                    changedDirectoryPaths={changedDirectoryPaths}
                    t={t}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {!changesCollapsed && gitFiles.length > 0 && (!fileSearchOpen || !hasSearchQuery) && (
          <div className="pw-fx-changes">
            <div
              className="pw-fx-changes-head"
              aria-label={t("files.changeStats", {
                count: gitFiles.length,
                additions: gitLineStats.additions,
                deletions: gitLineStats.deletions,
              })}
            >
              <span>{t("files.changedCount", { count: gitFiles.length })}</span>
              <span className="pw-num is-success">+{gitLineStats.additions}</span>
              <span className="pw-num is-danger">-{gitLineStats.deletions}</span>
            </div>
            {gitFiles.map((status) => (
              <ChangeRow
                key={status.filePath}
                status={status}
                cwd={cwd}
                onOpenFile={stableOpenFile}
                onAtMention={onAtMention}
                t={t}
              />
            ))}
          </div>
        )}

        {showTree && (
          loading ? (
            <div className="pw-fx-skeleton" aria-busy="true" aria-label={t("files.loading")}>
              <span className="pw-skeleton" style={{ width: "62%" }} />
              <span className="pw-skeleton" style={{ width: "48%" }} />
              <span className="pw-skeleton" style={{ width: "56%" }} />
            </div>
          ) : error ? (
            <div className="pw-fx-note is-error" role="alert">
              <span>{error}</span>
              <button type="button" className="pw-btn pw-btn--sm" onClick={() => setTreeRefreshKey((key) => key + 1)}><Icon name="refresh" />重试</button>
            </div>
          ) : roots.length === 0 ? (
            <div className="pw-fx-note">空目录</div>
          ) : (
            <div className="pw-tree" style={{ height: flatRows.length * TREE_ROW_H }}>
              {flatRows.slice(range.start, range.end).map((row, offset) => renderFlatRow(row, range.start + offset))}
            </div>
          )
        )}
      </div>
    </div>
  );
}));
