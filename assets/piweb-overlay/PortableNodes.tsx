"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collectConversationNodeRecords } from "@/lib/pi-portable-runtime.js";

type NodeRecord = { entryId: string; role: "user" | "assistant"; text: string; fullText: string };
type Props = { sessionId?: string; leafId?: string | null; messages: unknown[]; entryIds: string[]; navigating?: boolean; navigationError?: string; onSelect: (entryId: string) => void };
const ROW_HEIGHT = 38;
function isNode(value: unknown): value is NodeRecord {
  if (!value || typeof value !== "object") return false;
  const node = value as NodeRecord;
  return typeof node.entryId === "string" && ["user", "assistant"].includes(node.role) && typeof node.text === "string" && typeof node.fullText === "string";
}
export function PortableNodes({ sessionId, leafId, messages, entryIds, navigating, navigationError, onSelect }: Props) {
  const [history, setHistory] = useState<NodeRecord[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setHistory([]); setError(""); setOpen(false); setScrollTop(0);
    if (!sessionId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ nodes: "1", deferThinking: "1", deferMedia: "1" });
    if (leafId) query.set("leafId", leafId);
    void (async () => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.nodes) || !data.nodes.every(isNode)) throw new Error("对话节点响应格式不正确");
      if (!controller.signal.aborted) setHistory(data.nodes);
    })().catch(cause => {
      if (controller.signal.aborted) return;
      console.error("[pi-web] conversation node index load failed:", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [sessionId, leafId]);
  const nodes = useMemo(() => {
    const map = new Map(history.map(node => [node.entryId, node]));
    for (const node of collectConversationNodeRecords(messages, entryIds)) {
      if (isNode(node)) map.set(node.entryId, node);
    }
    return [...map.values()];
  }, [history, messages, entryIds]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  if (!nodes.length && !error && !navigationError && !navigating) return null;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const shown = nodes.slice(start, start + 24);
  return <aside ref={panel} className="pw-conversation-nodes" aria-label="对话节点" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
  }}>
    <button type="button" className="pw-node-toggle" aria-label={`对话节点（${nodes.length}）`} aria-expanded={open} onClick={() => setOpen(value => !value)}>Q/A <span>{nodes.length}</span></button>
    {navigating && <p role="status">正在加载并定位消息…</p>}
    {navigationError && <p role="alert">定位失败：{navigationError}</p>}
    {open && <section className="pw-node-panel" aria-label="问题与最终回答">
      <header>问题 / 最终回答 · {nodes.length}</header>
      {error && <p role="alert">节点索引加载失败：{error}</p>}
      <div className="pw-node-list" tabIndex={0} aria-label="滚动查看全部对话节点" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: nodes.length * ROW_HEIGHT, position: "relative" }}>
          {shown.map((node, index) => <button key={node.entryId} type="button" data-conversation-node-role={node.role} data-conversation-node-entry={node.entryId} title={node.fullText} aria-label={`${node.role === "user" ? "问题" : "最终回答"}：${node.fullText}`} style={{ top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }} onClick={() => { onSelect(node.entryId); setOpen(false); }}>
            <b>{node.role === "user" ? "Q" : "A"}</b><span>{node.text}</span>
          </button>)}
        </div>
      </div>
    </section>}
  </aside>;
}
