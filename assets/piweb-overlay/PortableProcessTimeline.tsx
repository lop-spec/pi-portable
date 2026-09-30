"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PortableTextBlock, PortableToolCallBlock, portableLoadThinkingContent, portableToolPreview } from "./MessageView";
import { isEmptyThinkingBlock } from "@/lib/message-display";
import { applyPatchResultHasFailures } from "@/lib/apply-patch";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "@/lib/tool-names";
import type { AssistantContentBlock, AssistantMessage, TextContent, ThinkingContent, ToolCallContent, ToolResultMessage } from "@/lib/types";

// One turn's process as a timeline (lop 2026-09-30「直接都隐藏命令」「英文推理折叠，中文还是
// 跟之前一样的显示」): the model's Chinese narration stays visible, each run of consecutive
// thinking summaries folds into one row, and tool calls are not shown. The full history view
// still lists every call; only a search hit on a tool call is kept so the jump still lands.
export type PortableTimelineEntry =
  | { kind: "node"; key: string; node: ReactNode }
  | { kind: "assistant"; key: string; entryId?: string; message: AssistantMessage };

type ToolItem = { block: ToolCallContent; entryId?: string; timestamp?: number };
type ThinkingItem = { block: ThinkingContent; entryId?: string; blockIndex: number };
type Item =
  | { type: "node"; key: string; node: ReactNode }
  | { type: "text"; key: string; block: TextContent; entryId?: string }
  | { type: "thinking"; key: string; blocks: ThinkingItem[] }
  | { type: "tools"; key: string; calls: ToolItem[] };

type Props = {
  entries: PortableTimelineEntry[];
  toolResults: Map<string, ToolResultMessage>;
  cwd?: string;
  sessionId?: string;
  searchEntryId?: string;
  searchBlock?: AssistantContentBlock;
  live?: boolean;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSession?: (sessionId: string) => void;
};

export function buildTimelineItems(entries: PortableTimelineEntry[], showTool: (block: ToolCallContent) => boolean = () => false): Item[] {
  const items: Item[] = [];
  for (const entry of entries) {
    if (entry.kind === "node") { items.push({ type: "node", key: entry.key, node: entry.node }); continue; }
    (entry.message.content ?? []).forEach((block, blockIndex) => {
      if (block.type === "toolCall") {
        if (!showTool(block)) return;
        const call = { block, entryId: entry.entryId, timestamp: entry.message.timestamp };
        const last = items.at(-1);
        if (last?.type === "tools") last.calls.push(call);
        else items.push({ type: "tools", key: `tools-${block.toolCallId}`, calls: [call] });
        return;
      }
      if (block.type === "text") {
        if (block.text.trim()) items.push({ type: "text", key: `${entry.key}-${blockIndex}`, block, entryId: entry.entryId });
        return;
      }
      if (block.type !== "thinking" || isEmptyThinkingBlock(block)) return;
      const item = { block, entryId: entry.entryId, blockIndex };
      const last = items.at(-1);
      if (last?.type === "thinking") last.blocks.push(item);
      else items.push({ type: "thinking", key: `thinking-${entry.key}-${blockIndex}`, blocks: [item] });
    });
  }
  return items;
}

function toolFailed(block: ToolCallContent, result?: ToolResultMessage): boolean {
  return Boolean(result?.isError) || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
}

export function summarizeTools(calls: { block: ToolCallContent }[]): string {
  const count = { bash: 0, read: new Set<string>(), search: 0, change: new Set<string>(), browser: 0 };
  const other = new Map<string, number>();
  for (const { block } of calls) {
    const name = block.toolName.toLowerCase();
    const target = String(block.input?.path ?? block.input?.file_path ?? block.toolCallId);
    if (name === "bash") count.bash++;
    else if (name === "read") count.read.add(target);
    else if (name === "grep" || name === "find" || name === "ls") count.search++;
    else if (isEditToolName(name) || isWriteToolName(name) || isApplyPatchToolName(name)) count.change.add(target);
    else if (name === "browser") count.browser++;
    else other.set(block.toolName, (other.get(block.toolName) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (count.bash) parts.push(`运行 ${count.bash} 条命令`);
  if (count.read.size) parts.push(`读取 ${count.read.size} 个文件`);
  if (count.search) parts.push(`搜索 ${count.search} 次`);
  if (count.change.size) parts.push(`修改 ${count.change.size} 个文件`);
  if (count.browser) parts.push(`浏览器操作 ${count.browser} 次`);
  for (const [name, n] of other) parts.push(`${name} ${n} 次`);
  return parts.join(" · ");
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
      <polyline points="4 2.5 7.5 6 4 9.5" />
    </svg>
  );
}

// Only rendered for a search hit on a tool call; ordinary tool runs are hidden.
function ToolGroup({ calls, toolResults, live, searchEntryId, searchBlock, onOpenSession }: { calls: ToolItem[] } & Pick<Props, "toolResults" | "live" | "searchEntryId" | "searchBlock" | "onOpenSession">) {
  const [open, setOpen] = useState(false);
  const target = calls.find(call => call.entryId === searchEntryId && call.block === searchBlock);
  const expanded = open || Boolean(target);
  const pending = calls.filter(call => !toolResults.get(call.block.toolCallId));
  const failed = calls.filter(call => toolFailed(call.block, toolResults.get(call.block.toolCallId))).length;
  const running = live && pending.length > 0 ? pending[0] : undefined;
  return (
    <div className="pw-tool-group">
      <button type="button" className="pw-tool-fold" aria-expanded={expanded} onClick={() => setOpen(value => !value)}>
        <Chevron open={expanded} />
        {running && <span className="pw-tool-spinner" aria-hidden="true" />}
        <span className="pw-tool-summary">{summarizeTools(calls)}</span>
        {failed > 0 && <span className="pw-tool-failed">{failed} 条失败</span>}
        {running && <span className="pw-tool-running">{portableToolPreview(running.block) || running.block.toolName}</span>}
      </button>
      {expanded && (
        <div className="pw-tool-cards">
          {calls.map(({ block, entryId, timestamp }) => {
            const result = toolResults.get(block.toolCallId);
            const seconds = result?.timestamp && timestamp ? Math.round((result.timestamp - timestamp) / 1000) : 0;
            return (
              <div key={block.toolCallId} data-entry-id={entryId}>
                <div data-search-target={block === target?.block || undefined}>
                  <PortableToolCallBlock block={block} result={result} duration={seconds > 0 ? seconds : undefined} onOpenSession={onOpenSession} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function thinkingLines(text: string): string[] {
  return text.replace(/\*\*(.+?)\*\*/gu, "$1").split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean);
}

function Thinking({ block, sessionId, entryId, blockIndex }: { block: ThinkingContent; sessionId?: string; entryId?: string; blockIndex: number }) {
  const [full, setFull] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => { setFull(null); setState("idle"); }, [block]);
  const load = () => {
    if (!sessionId || !entryId) { setState("error"); setError("推理全文不可用"); return; }
    setState("loading");
    portableLoadThinkingContent(sessionId, entryId, blockIndex)
      .then(value => { setFull(value); setState("idle"); })
      .catch(cause => { console.error("[pi-web] thinking load failed:", entryId, blockIndex, cause); setError(cause instanceof Error ? cause.message : String(cause)); setState("error"); });
  };
  const text = full ?? block.thinking;
  return (
    <div className="pw-reason-thinking">
      {thinkingLines(text).map((line, index) => <p key={index}>{line}</p>)}
      {block.deferred && full === null && (
        <button type="button" className="pw-reason-more" onClick={load} disabled={state === "loading"}>
          {state === "loading" ? "正在加载…" : state === "error" ? `加载失败：${error}，点此重试` : "展开全文"}
        </button>
      )}
    </div>
  );
}

// Folded by default. As the live tail it shows a spinner and the newest heading, so progress stays
// visible without opening it; a search hit inside opens it.
function ThinkingGroup({ blocks, sessionId, live, searchEntryId, searchBlock }: { blocks: ThinkingItem[]; live: boolean } & Pick<Props, "sessionId" | "searchEntryId" | "searchBlock">) {
  const [open, setOpen] = useState(false);
  const target = blocks.find(item => item.entryId === searchEntryId && item.block === searchBlock);
  const expanded = open || Boolean(target);
  const latest = live ? thinkingLines(blocks[blocks.length - 1].block.thinking).at(-1) : undefined;
  return (
    <div className="pw-think-group">
      <button type="button" className="pw-tool-fold" aria-expanded={expanded} onClick={() => setOpen(value => !value)}>
        <Chevron open={expanded} />
        {live && <span className="pw-tool-spinner" aria-hidden="true" />}
        <span className="pw-tool-summary">{live ? "正在思考" : `已思考 ${blocks.length} 步`}</span>
        {latest && <span className="pw-tool-running">{latest}</span>}
      </button>
      {expanded && (
        <div className="pw-think-cards">
          {blocks.map(item => (
            <div key={`${item.entryId}-${item.blockIndex}`} data-entry-id={item.entryId} data-search-target={item === target || undefined}>
              <Thinking block={item.block} sessionId={sessionId} entryId={item.entryId} blockIndex={item.blockIndex} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PortableProcessTimeline({ entries, toolResults, cwd, sessionId, searchEntryId, searchBlock, live, onOpenFile, onOpenSession }: Props) {
  const items = buildTimelineItems(entries, block => block === searchBlock);
  if (items.length === 0) return null;
  return (
    <div className="pw-process-timeline">
      {items.map((item, index) => {
        if (item.type === "node") return <div key={item.key}>{item.node}</div>;
        if (item.type === "tools") {
          return <ToolGroup key={item.key} calls={item.calls} toolResults={toolResults} live={live} searchEntryId={searchEntryId} searchBlock={searchBlock} onOpenSession={onOpenSession} />;
        }
        if (item.type === "thinking") {
          return <ThinkingGroup key={item.key} blocks={item.blocks} sessionId={sessionId} live={Boolean(live) && index === items.length - 1} searchEntryId={searchEntryId} searchBlock={searchBlock} />;
        }
        const isTarget = item.entryId === searchEntryId && item.block === searchBlock;
        return (
          <div key={item.key} data-entry-id={item.entryId} className="pw-reason">
            <div data-message-text data-search-target={isTarget || undefined}><PortableTextBlock block={item.block} cwd={cwd} onOpenFile={onOpenFile} /></div>
          </div>
        );
      })}
    </div>
  );
}
