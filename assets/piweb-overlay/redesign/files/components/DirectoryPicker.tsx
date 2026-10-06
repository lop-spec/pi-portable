"use client";
// 自定义路径的目录浏览器：原生 <dialog class="pw-dialog pw-dialog--lg">（居中、遮罩、Esc），
// 顶部 上级 / 路径输入 / 转到，中间目录列表（系统字体，路径只在输入框里用等宽），底部 取消 + 主按钮。
import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { focusInitialControl } from "./sidebar/dialog-focus";
import { Icon } from "./sidebar/icons";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
}

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, initialPath, busy = false, error }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      console.error("[pi-web directory-picker] browse failed:", cause);
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo(initialPath || undefined);
  }, [initialPath, navigateTo]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // showModal() 默认聚焦第一个可聚焦元素（关闭按钮）；路径输入框带 data-autofocus，这里主动聚焦。
    focusInitialControl(dialog);
    return () => { if (dialog.open) dialog.close(); };
  }, [portalTarget]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !busy;
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);
  const entries = drives ?? directories;

  if (!portalTarget) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="pw-dialog pw-dialog--lg pw-dirpicker"
      aria-labelledby={titleId}
      data-pi-project-dialog="true"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="pw-dialog-header">
        <h2 id={titleId} className="pw-dialog-title">{t("directoryPicker.selectDirectory")}</h2>
        <button type="button" className="pw-icon-btn" onClick={onCancel} disabled={busy} title={t("i18n.close")} aria-label={t("i18n.close")}>
          <Icon name="close" />
        </button>
      </div>

      <form onSubmit={handlePathSubmit} className="pw-dirpicker-bar">
        <button
          className="pw-icon-btn directory-picker-back"
          type="button"
          onClick={() => void navigateTo(parentDirectory ?? undefined)}
          disabled={loading || !canNavigateUp}
          title={t("directoryPicker.goToParent")}
          aria-label={t("directoryPicker.goToParent")}
        >
          <Icon name="up" />
        </button>
        <label htmlFor="directory-path" className="pw-sr-only">{t("directoryPicker.directoryPath")}</label>
        <input
          className="pw-input pw-mono directory-picker-path"
          id="directory-path"
          type="text"
          value={pathInput}
          placeholder="例如 D:\Projects 或 ~\Documents"
          data-autofocus=""
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setPathInput(event.target.value);
            setLoadError(null);
          }}
        />
        <button
          className="pw-btn directory-picker-action"
          type="submit"
          disabled={loading || !pathInput.trim()}
          title={t("directoryPicker.goToDirectory")}
        >
          {t("directoryPicker.go")}
        </button>
      </form>

      <div className="pw-dirpicker-list directory-picker-list scrollbar-subtle" role="list" aria-busy={loading}>
        {loading ? (
          <div className="pw-dirpicker-skeleton">
            <span className="pw-skeleton" style={{ width: "46%" }} />
            <span className="pw-skeleton" style={{ width: "62%" }} />
            <span className="pw-skeleton" style={{ width: "38%" }} />
          </div>
        ) : entries.length > 0 ? (
          entries.map((entry) => (
            <div role="listitem" key={entry.path}>
              <button
                className="pw-dirpicker-entry directory-picker-entry"
                type="button"
                onClick={() => void navigateTo(entry.path)}
                title={entry.path}
              >
                <Icon name={drives ? "drive" : "folder"} size={14} />
                <span className="pw-truncate">{entry.name}</span>
              </button>
            </div>
          ))
        ) : (
          <p className="pw-dirpicker-note">{drives ? t("directoryPicker.noDrives") : t("directoryPicker.noSubdirectories")}</p>
        )}
        {(loadError || error) && <p className="pw-field-error pw-dirpicker-error" role="alert">{loadError ?? error}</p>}
      </div>

      <div className="pw-dialog-footer directory-picker-footer">
        <span className="pw-dialog-footer-start pw-dirpicker-current pw-truncate" title={currentPath}>{currentPath}</span>
        <button className="pw-btn pw-btn--ghost directory-picker-action" type="button" onClick={onCancel} disabled={busy}>{t("i18n.cancel")}</button>
        <button
          className="pw-btn pw-btn--primary directory-picker-action"
          type="button"
          onClick={() => onSelect(currentPath)}
          disabled={!canSelect}
          title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
        >
          {busy ? t("i18n.checking") : t("directoryPicker.selectThisFolder")}
        </button>
      </div>
    </dialog>,
    portalTarget,
  );
}
