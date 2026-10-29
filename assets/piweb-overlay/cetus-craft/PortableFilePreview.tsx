"use client";
// Cetus ArtifactPreviewDialog interaction, hosted on Pi's existing file renderer/API.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";

type File = { id: string; filePath?: string; sourceSessionId?: string | null };
export function PortableFilePreview({ file, files, onSelect, onClose, children }: {
  file: File; files: File[]; onSelect: (id: string) => void; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const current = files.findIndex(item => item.id === file.id);
  const path = file.filePath!;
  const url = `/api/files/${encodeFilePathForApi(path)}?type=download${file.sourceSessionId ? `&sessionId=${encodeURIComponent(file.sourceSessionId)}` : ""}`;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
    };
    const message = (event: MessageEvent) => {
      if (![...element.querySelectorAll("iframe")].some(frame => frame.contentWindow === event.source)) return;
      if (event.data?.__piPreview === "escape") closeRef.current();
      if (event.data?.__piPreview === "link" && typeof event.data.url === "string" && /^https?:\/\//i.test(event.data.url)) window.open(event.data.url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("message", message);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("message", message); element.close(); previous?.focus(); };
  }, []);
  useEffect(() => { setError(""); setCopied(false); }, [path]);
  const step = (delta: number) => onSelect(files[(current + delta + files.length) % files.length].id);
  const run = async (action: "file" | "path") => {
    setError("");
    try {
      const response = await fetch("/api/open-local-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, action, sessionId: file.sourceSessionId }) });
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    } catch (cause) { setError(String(cause)); }
  };
  const copy = async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await navigator.clipboard.writeText(await response.text()); setCopied(true);
    } catch (cause) { setError(String(cause)); }
  };
  return <dialog ref={dialog} className="pw-file-preview" aria-label={getFileName(path)} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }} onKeyDown={event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || files.length < 2) return;
    const target = event.target as HTMLElement;
    if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(target.tagName)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
  }}>
    <header className="pw-file-preview-head">
      <div className="pw-file-preview-title"><strong>{getFileName(path)}</strong><small title={path}>{path}</small></div>
      <div className="pw-file-preview-actions">
        {/\.(md|mdx|txt|html?|json|csv|[cm]?[jt]sx?|py|sql|ya?ml|log|css)$/i.test(path) && <button title="复制文件原文" onClick={() => void copy()}>{copied ? "已复制" : "复制"}</button>}
        <button title="用系统默认程序打开" onClick={() => void run("file")}>外部打开</button>
        <a title="下载文件" href={url} download={getFileName(path)}>下载</a>
        <button title="打开所在目录" onClick={() => void run("path")}>所在目录</button>
        <button title="关闭预览（Esc）" aria-label="关闭预览" onClick={onClose}>×</button>
      </div>
    </header>
    {error && <div role="alert">{error}</div>}
    <section className="pw-file-preview-body">{children}</section>
    {files.length > 1 && <nav aria-label="切换文件" className="pw-file-preview-nav"><button title="上一个文件（←）" onClick={() => step(-1)}>←</button><span>{current + 1} / {files.length}</span><button title="下一个文件（→）" onClick={() => step(1)}>→</button></nav>}
  </dialog>;
}
