"use client";

import { createContext, useContext, useState, type MouseEvent } from "react";
import { resolveLocalFilePath } from "@/lib/file-links";
import { PopMenu } from "./sidebar/PopMenu";

export const PortableFileSession = createContext<string | undefined>(undefined);

/** The markdown image plugin has already converted a local path into this API URL. */
export function localFilePathFromImageApi(src: string): string | null {
  const match = /^\/api\/files\/([^?#]+)/.exec(src);
  if (!match) return null;
  try {
    const parts = match[1].split("/").map(decodeURIComponent);
    if (!parts.length || parts.some(part => !part)) return null;
    const joined = parts.join("/");
    return /^[A-Za-z]:\//.test(joined) || joined.startsWith("//") ? joined : `/${joined}`;
  } catch { return null; }
}

type MenuState = { path: string; x: number; y: number; trigger: HTMLElement | null } | null;

/** One menu for all representations of a file in a conversation. */
export function usePortableFileMenu(cwd?: string, explicitSessionId?: string, onPreviewFile?: (path: string) => void) {
  const contextSessionId = useContext(PortableFileSession);
  const [state, setState] = useState<MenuState>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = explicitSessionId ?? contextSessionId;
  const close = () => { if (!busy) { setState(null); setError(""); } };
  const open = (event: MouseEvent<HTMLElement>, filePath: string) => {
    const resolved = resolveLocalFilePath(filePath, cwd);
    if (!resolved) return;
    event.preventDefault();
    event.stopPropagation();
    setError("");
    setState({ path: resolved, x: event.clientX, y: event.clientY, trigger: event.currentTarget });
  };
  const run = async (action: "file" | "path") => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/open-local-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.path, action, sessionId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
      if (action === "file") onPreviewFile?.(state.path);
      setState(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { state, error, busy, open, close, run };
}

export type PortableFileMenuState = ReturnType<typeof usePortableFileMenu>;

export function PortableFileContextMenu({ menu }: { menu: PortableFileMenuState }) {
  const { state, error, busy, close, run } = menu;
  if (!state) return null;
  return (
    <PopMenu anchor={{ kind: "point", x: state.x, y: state.y }} onClose={close} returnFocus={state.trigger} ariaLabel="文件操作" width={184}>
      <button type="button" role="menuitem" className="pw-menu-item" title="用系统默认程序打开文件" disabled={busy} onClick={() => void run("file")}>Open file</button>
      <button type="button" role="menuitem" className="pw-menu-item" title="打开文件所在目录" disabled={busy} onClick={() => void run("path")}>Open path</button>
      {error && <div role="alert" style={{ padding: "6px 10px", color: "var(--danger)", overflowWrap: "anywhere" }}>打开失败：{error}</div>}
    </PopMenu>
  );
}
