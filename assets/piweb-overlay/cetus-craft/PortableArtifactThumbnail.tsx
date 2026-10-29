"use client";
import { useContext, useEffect, useRef, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { MarkdownBody } from "./MarkdownBody";
import { PortableFileSession } from "./PortableFileContextMenu";
export function PortableArtifactThumbnail({ path, name }: { path: string; name: string }) {
  const sessionId = useContext(PortableFileSession);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const image = /^(png|jpe?g|gif|webp|avif|bmp)$/.test(ext), video = /^(mp4|webm|mov|mkv)$/.test(ext);
  const textual = /^(md|mdx|html?|txt|json|csv|[cm]?[jt]sx?|py|sql|ya?ml|log|css)$/.test(ext);
  const url = `/api/files/${encodeFilePathForApi(path)}?type=read${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(item => item.isIntersecting)) { setVisible(true); observer.disconnect(); } });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !textual) return;
    const controller = new AbortController();
    setText(null); setFailed(false);
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json(); setText(String(data.content || '').slice(0, 6000));
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [url, visible, textual]);
  if (!image && !video && !textual && ext !== 'pdf') return <div className="pw-artifact-icon" aria-hidden="true">{ext.toUpperCase() || 'FILE'}</div>;
  return <div ref={root} className="pw-artifact-thumb" aria-hidden="true" inert>
    {!visible || failed ? <div className="pw-artifact-icon">{ext.toUpperCase()}</div> : image ? <img src={url} alt={name} loading="lazy" onError={() => setFailed(true)} /> : video ? <video src={url} muted preload="metadata" /> : ext === 'pdf' ? <div className="pw-artifact-icon">PDF</div> : /html?/.test(ext) ? <iframe srcDoc={text || ''} title={name} sandbox="" tabIndex={-1} /> : /^mdx?$/.test(ext) ? <MarkdownBody>{text || ''}</MarkdownBody> : <pre>{text}</pre>}
  </div>;
}
