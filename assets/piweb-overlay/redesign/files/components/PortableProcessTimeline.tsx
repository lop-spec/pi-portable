"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { PortableTextBlock, PortableToolCallBlock, estimateAssistantTokens, getModelDisplayName, portableLoadThinkingContent, portableToolPreview } from "./MessageView";
import { InlineFailure, type InlineFailureRecord } from "./conversation/ErrorNotice";
import { CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, CompressIcon, StopCircleIcon, SwapIcon, XCircleIcon } from "./conversation/icons";
import {
  formatClock,
  formatDuration,
  getAssistantErrorMessage,
  isAssistantTruncated,
  isEmptyThinkingBlock,
  modelNameWithoutNote,
  parseAssistantError,
  plainThinkingText,
  thinkingHeadline,
  thinkingParagraphs,
} from "@/lib/message-display";
import { applyPatchResultHasFailures } from "@/lib/apply-patch";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "@/lib/tool-names";
import type { AssistantContentBlock, AssistantMessage, TextContent, ThinkingContent, ToolCallContent, ToolResultMessage } from "@/lib/types";

// One turn's process as a quiet timeline (lop 2026-09-30「直接都隐藏命令」「英文推理折叠，中文还是
// 跟之前一样的显示」): the model's Chinese narration stays fully visible, consecutive reasoning
// folds into one row, and tool calls are not shown. The full history view still lists every call;
// only a search hit on a tool call is kept so the jump still lands. Streaming turns render through
// this same component, so nothing changes shape when a step finishes.
export type PortableTimelineEntry =
  | { kind: "node"; key: string; node: ReactNode }
  | { kind: "assistant"; key: string; entryId?: string; message: AssistantMessage; streaming?: boolean }
  | { kind: "compaction"; key: string; entryId?: string; timestamp?: number }
  | { kind: "failure"; key: string; entryId?: string; message: AssistantMessage };

type ToolItem = { block: ToolCallContent; entryId?: string; timestamp?: number };
type ThinkingItem = { block: ThinkingContent; entryId?: string; blockIndex: number };
type Item =
  | { type: "node"; key: string; node: ReactNode }
  | { type: "text"; key: string; block: TextContent; entryId?: string; streaming: boolean }
  | { type: "thinking"; key: string; blocks: ThinkingItem[]; streaming: boolean }
  | { type: "tools"; key: string; calls: ToolItem[] }
  | { type: "compaction"; key: string; entryId?: string }
  | { type: "switch"; key: string; model: string }
  | { type: "failure"; key: string; group: string; failures: InlineFailureRecord[] };

export type TimelineEnd = { status: "done" | "error" | "stopped"; at?: number };

type Props = {
  entries: PortableTimelineEntry[];
  toolResults: Map<string, ToolResultMessage>;
  cwd?: string;
  sessionId?: string;
  searchEntryId?: string;
  searchBlock?: AssistantContentBlock;
  live?: boolean;
  modelNames?: Record<string, string>;
  /** Page-lifetime key for the collapse state (session + turn anchor). */
  collapseKey?: string;
  /** Turn start (the anchor message time); drives 用时 / 已用. */
  startedAt?: number;
  /** How a finished turn ended; omitted when the turn start is not loaded. */
  end?: TimelineEnd | null;
  /** Live phase text (等待模型 / 正在运行工具 …). */
  phase?: string | null;
  /** The message being streamed, for the t/s readout in the live end node. */
  streamingMessage?: AssistantMessage | null;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSession?: (sessionId: string) => void;
};

/**
 * Turns timeline entries into display items:
 * - hidden tool calls, empty text and non-Chinese reasoning never break a run of reasoning;
 * - one-line markers (compaction, model switch, custom nodes) right after reasoning do not
 *   split it either: the run keeps merging and the markers follow it;
 * - consecutive failures with the same error code merge into one item (×N);
 * - a model change inside the turn inserts a switch marker.
 */
export function buildTimelineItems(
  entries: PortableTimelineEntry[],
  showTool: (block: ToolCallContent) => boolean = () => false,
  modelNames?: Record<string, string>,
): Item[] {
  const items: Item[] = [];
  let pending: Item[] = [];
  let lastModel: string | undefined;
  const flush = () => {
    if (pending.length === 0) return;
    items.push(...pending);
    pending = [];
  };
  const pushMarker = (item: Item) => {
    if (items.at(-1)?.type === "thinking") pending.push(item);
    else items.push(item);
  };
  const pushContent = (item: Item) => {
    flush();
    items.push(item);
  };
  const noteModel = (message: AssistantMessage, key: string) => {
    if (!message.provider && !message.model) return;
    const id = `${message.provider}/${message.model}`;
    if (lastModel !== undefined && id !== lastModel) {
      pushMarker({ type: "switch", key: `switch-${key}`, model: modelNameWithoutNote(getModelDisplayName(message.provider, message.model, modelNames)) });
    }
    lastModel = id;
  };

  for (const entry of entries) {
    if (entry.kind === "node") { pushMarker({ type: "node", key: entry.key, node: entry.node }); continue; }
    if (entry.kind === "compaction") { pushMarker({ type: "compaction", key: entry.key, entryId: entry.entryId }); continue; }
    if (entry.kind === "failure") {
      noteModel(entry.message, entry.key);
      const raw = getAssistantErrorMessage(entry.message);
      const record: InlineFailureRecord = { entryId: entry.entryId, raw: raw ?? "", truncated: !raw && isAssistantTruncated(entry.message), timestamp: entry.message.timestamp };
      const parsed = record.truncated ? null : parseAssistantError(record.raw);
      const group = parsed ? (parsed.code ?? parsed.title) : "length";
      const last = items.at(-1);
      if (pending.length === 0 && last?.type === "failure" && last.group === group) last.failures.push(record);
      else pushContent({ type: "failure", key: entry.key, group, failures: [record] });
      continue;
    }
    noteModel(entry.message, entry.key);
    const content = entry.message.content ?? [];
    content.forEach((block, blockIndex) => {
      const streaming = Boolean(entry.streaming) && blockIndex === content.length - 1;
      if (block.type === "toolCall") {
        if (!showTool(block)) return;
        const call = { block, entryId: entry.entryId, timestamp: entry.message.timestamp };
        const last = items.at(-1);
        if (pending.length === 0 && last?.type === "tools") last.calls.push(call);
        else pushContent({ type: "tools", key: `tools-${block.toolCallId}`, calls: [call] });
        return;
      }
      if (block.type === "text") {
        if (block.text.trim()) pushContent({ type: "text", key: `${entry.key}-${blockIndex}`, block, entryId: entry.entryId, streaming });
        return;
      }
      if (block.type !== "thinking" || isEmptyThinkingBlock(block)) return;
      const item = { block, entryId: entry.entryId, blockIndex };
      const last = items.at(-1);
      if (last?.type === "thinking") {
        last.blocks.push(item);
        last.streaming = streaming;
      } else {
        pushContent({ type: "thinking", key: `thinking-${entry.key}-${blockIndex}`, blocks: [item], streaming });
      }
    });
  }
  flush();
  return items;
}

/** Header counts: 段叙述 / 思考 / 失败 (reasoning without Chinese never reaches the items). */
export function summarizeTimelineItems(items: Item[]): { narration: number; thinking: number; failures: number } {
  let narration = 0;
  let thinking = 0;
  let failures = 0;
  for (const item of items) {
    if (item.type === "text") narration++;
    else if (item.type === "thinking") thinking += item.blocks.length;
    else if (item.type === "failure") failures += item.failures.length;
  }
  return { narration, thinking, failures };
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
      <button type="button" className="pw-think-fold" aria-expanded={expanded} onClick={() => setOpen(value => !value)}>
        {running ? <span className="pw-spinner pw-spinner--sm" aria-hidden="true" /> : <ChevronRightIcon className="pw-think-chev" />}
        <span className="pw-think-label">{summarizeTools(calls)}</span>
        {failed > 0 && <span className="pw-tool-failed">{failed} 条失败</span>}
        {running && <span className="pw-think-preview">{portableToolPreview(running.block) || running.block.toolName}</span>}
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
    <div className="pw-think-text">
      {thinkingParagraphs(text).map((line, index) => <p key={index}>{line}</p>)}
      {block.deferred && full === null && (
        <button type="button" className="pw-think-more" onClick={load} disabled={state === "loading"}>
          {state === "loading" ? "正在加载…" : state === "error" ? `加载失败：${error}，点此重试` : "展开全文"}
        </button>
      )}
    </div>
  );
}

const INLINE_THINKING_CHARS = 40;

// Folded by default and labelled 思考 / 思考 N 处 with the latest point as a preview. A short
// group (≤40 characters, nothing deferred) is shown inline instead of behind a click. While the
// reasoning is still streaming the chevron becomes a spinner and the preview tracks the newest
// heading; a search hit inside opens it.
type ThinkingGroupProps = { item: Extract<Item, { type: "thinking" }>; live: boolean } & Pick<Props, "sessionId" | "searchEntryId" | "searchBlock">;

// Items are rebuilt whenever the turn re-renders (every frame while it streams); a group
// only needs to re-render when its own blocks or flags changed.
function sameThinkingGroup(prev: ThinkingGroupProps, next: ThinkingGroupProps): boolean {
  if (prev.live !== next.live || prev.sessionId !== next.sessionId || prev.searchEntryId !== next.searchEntryId || prev.searchBlock !== next.searchBlock) return false;
  if (prev.item === next.item) return true;
  const a = prev.item.blocks;
  const b = next.item.blocks;
  return prev.item.streaming === next.item.streaming
    && a.length === b.length
    && a.every((entry, index) => entry.block === b[index].block && entry.entryId === b[index].entryId && entry.blockIndex === b[index].blockIndex);
}

const ThinkingGroup = memo(function ThinkingGroup({ item, sessionId, live, searchEntryId, searchBlock }: ThinkingGroupProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const { blocks } = item;
  const target = blocks.find(entry => entry.entryId === searchEntryId && entry.block === searchBlock);
  const active = live && item.streaming;
  const plain = blocks.map(entry => plainThinkingText(entry.block.thinking));
  const total = plain.reduce((sum, text) => sum + [...text].length, 0);
  if (!active && total <= INLINE_THINKING_CHARS && blocks.every(entry => !entry.block.deferred)) {
    return (
      <p className="pw-think-inline">
        <span className="pw-think-label">思考</span>
        {blocks.map((entry, index) => (
          <span key={`${entry.entryId}-${entry.blockIndex}`} data-entry-id={entry.entryId}>
            <span data-search-target={entry === target || undefined}>{index > 0 ? "；" : ""}{plain[index]}</span>
          </span>
        ))}
      </p>
    );
  }
  const expanded = open || Boolean(target);
  const headline = thinkingHeadline(blocks[blocks.length - 1].block.thinking);
  const label = active ? "正在思考" : blocks.length > 1 ? `思考 ${blocks.length} 处` : "思考";
  return (
    <>
      <button type="button" className={active ? "pw-think-fold is-live" : "pw-think-fold"} aria-expanded={expanded} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
        {active ? <span className="pw-spinner pw-spinner--sm" aria-hidden="true" /> : <ChevronRightIcon className="pw-think-chev" />}
        <span className="pw-think-label">{label}</span>
        {headline && <span className="pw-think-preview">{headline}</span>}
      </button>
      {expanded && (
        <div id={bodyId} className="pw-think-body">
          {blocks.map(entry => (
            <div key={`${entry.entryId}-${entry.blockIndex}`} data-entry-id={entry.entryId} data-search-target={entry === target || undefined}>
              <Thinking block={entry.block} sessionId={sessionId} entryId={entry.entryId} blockIndex={entry.blockIndex} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}, sameThinkingGroup);

// Narration is the readable part of the process: full markdown, never folded or clipped.
const Narration = memo(function Narration({ block, entryId, isTarget, streaming, cwd, onOpenFile }: { block: TextContent; entryId?: string; isTarget: boolean; streaming: boolean; cwd?: string; onOpenFile?: (filePath: string, page?: number) => void }) {
  return (
    <div data-entry-id={entryId}>
      <div data-message-text data-search-target={isTarget || undefined}>
        <PortableTextBlock block={block} isStreaming={streaming} cwd={cwd} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
});

function stripPhase(text: string): string {
  return text.replace(/[.。…]+$/u, "").trim();
}

// Running turn: spinner + phase + elapsed clock + t/s, ticking once a second on its own.
function LiveEnd({ startedAt, phase, streamingMessage }: Pick<Props, "startedAt" | "phase" | "streamingMessage">) {
  const [now, setNow] = useState(() => Date.now());
  const [tps, setTps] = useState<number | null>(null);
  const messageRef = useRef(streamingMessage);
  messageRef.current = streamingMessage;
  useEffect(() => {
    let previous = { tokens: 0, at: 0, idle: 0, rate: null as number | null };
    const tick = () => {
      const at = Date.now();
      const tokens = messageRef.current ? estimateAssistantTokens(messageRef.current) : 0;
      if (tokens > previous.tokens && previous.at > 0) {
        const instant = (tokens - previous.tokens) / Math.max(0.25, (at - previous.at) / 1000);
        previous.rate = previous.rate === null ? instant : previous.rate * 0.5 + instant * 0.5;
        previous.idle = 0;
      } else if (tokens < previous.tokens || tokens === 0) {
        previous.rate = null;
        previous.idle = 0;
      } else if (++previous.idle >= 2) {
        previous.rate = null;
      }
      previous = { ...previous, tokens, at };
      setNow(at);
      setTps(previous.rate === null ? null : Math.round(previous.rate));
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const parts = [phase ? stripPhase(phase) : "进行中"];
  if (startedAt) parts.push(`已用 ${formatClock(now - startedAt)}`);
  if (tps && tps > 0) parts.push(`${tps} t/s`);
  return (
    <li className="pw-proc-end is-live">
      <span className="pw-proc-node"><span className="pw-spinner" aria-hidden="true" /></span>
      <span className="pw-num" role="status">{parts.join(" · ")}</span>
    </li>
  );
}

function EndNode({ end, startedAt }: { end: TimelineEnd; startedAt?: number }) {
  const label = end.status === "done" ? "完成" : end.status === "stopped" ? "已停止" : "中断";
  const duration = startedAt && end.at && end.at >= startedAt ? ` · 用时 ${formatDuration(end.at - startedAt)}` : "";
  return (
    <li className={`pw-proc-end is-${end.status}`}>
      <span className="pw-proc-node">{end.status === "done" ? <CheckCircleIcon /> : end.status === "stopped" ? <StopCircleIcon /> : <XCircleIcon />}</span>
      <span className="pw-num">{label}{duration}</span>
    </li>
  );
}

// Collapse state lives for the page only (not persisted), keyed by session + turn anchor so a
// turn that scrolls out of the lazy-load window comes back the way the user left it.
const collapsedTimelines = new Set<string>();

// Memoized: a finished turn keeps the same entries array, so it skips re-rendering
// while another turn streams or the window pages.
export const PortableProcessTimeline = memo(function PortableProcessTimeline({ entries, toolResults, cwd, sessionId, searchEntryId, searchBlock, live, modelNames, collapseKey, startedAt, end, phase, streamingMessage, onOpenFile, onOpenSession }: Props) {
  const listId = useId();
  const items = useMemo(() => buildTimelineItems(entries, block => block === searchBlock, modelNames), [entries, searchBlock, modelNames]);
  const stats = useMemo(() => summarizeTimelineItems(items), [items]);
  // The jump target lives in this process: its entry is here and, for a text hit, so is the matched block
  // (a hit in the final answer shares the entry but is rendered below the process).
  const hasTarget = useMemo(() => Boolean(searchEntryId) && entries.some(entry => (
    "entryId" in entry && entry.entryId === searchEntryId && (!searchBlock || entry.kind !== "assistant" || entry.message.content.includes(searchBlock))
  )), [entries, searchEntryId, searchBlock]);
  const [collapsed, setCollapsed] = useState(() => Boolean(collapseKey && collapsedTimelines.has(collapseKey)) && !hasTarget);
  // A search hit inside a process the reader had collapsed: open it for good. The turn only
  // receives `searchEntryId` while the jump is pending (it is cleared right after the scroll),
  // so tying the open state to it would fold the process again and the hit would vanish.
  // It stays open until the reader collapses it by hand.
  const [hadTarget, setHadTarget] = useState(hasTarget);
  if (hasTarget !== hadTarget) {
    setHadTarget(hasTarget);
    if (hasTarget && collapsed) setCollapsed(false);
  }
  useEffect(() => {
    if (hasTarget && collapseKey) collapsedTimelines.delete(collapseKey);
  }, [hasTarget, collapseKey]);
  if (items.length === 0 && !live) return null;

  const expanded = Boolean(live) || hasTarget || !collapsed;
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (!collapseKey) return;
    if (next) collapsedTimelines.add(collapseKey);
    else collapsedTimelines.delete(collapseKey);
  };
  const statParts: { key: string; text: string; error?: boolean }[] = [];
  if (stats.narration) statParts.push({ key: "narration", text: `${stats.narration} 段叙述` });
  if (stats.thinking) statParts.push({ key: "thinking", text: stats.thinking > 1 ? `思考 ${stats.thinking} 处` : "思考" });
  if (stats.failures) statParts.push({ key: "failures", text: `${stats.failures} 次失败`, error: true });
  const headContent = (
    <>
      <span className="pw-proc-title">过程</span>
      {statParts.map(part => (
        <span key={part.key} className={part.error ? "pw-proc-stat is-error" : "pw-proc-stat"}>
          <span className="pw-proc-sep" aria-hidden="true">·</span>{part.text}
        </span>
      ))}
    </>
  );

  return (
    <section className="pw-proc-section" aria-label="处理过程">
      {items.length > 0 && (live
        ? <div className="pw-proc-head is-static">{headContent}</div>
        : (
          <button type="button" className="pw-proc-head" aria-expanded={expanded} aria-controls={listId} title={expanded ? "收起过程" : "展开过程"} onClick={toggle}>
            <ChevronDownIcon className="pw-proc-chev" />
            {headContent}
          </button>
        ))}
      {expanded && (
        <ol id={listId} className="pw-proc">
          {items.map((item, index) => {
            if (item.type === "node") return <li key={item.key} className="pw-proc-item pw-proc-node-item">{item.node}</li>;
            if (item.type === "tools") {
              return <li key={item.key} className="pw-proc-item pw-proc-tool"><ToolGroup calls={item.calls} toolResults={toolResults} live={live} searchEntryId={searchEntryId} searchBlock={searchBlock} onOpenSession={onOpenSession} /></li>;
            }
            if (item.type === "thinking") {
              return <li key={item.key} className="pw-proc-item pw-proc-think"><ThinkingGroup item={item} sessionId={sessionId} live={Boolean(live)} searchEntryId={searchEntryId} searchBlock={searchBlock} /></li>;
            }
            if (item.type === "compaction") {
              return (
                <li key={item.key} className="pw-proc-item pw-proc-mark" data-entry-id={item.entryId}>
                  <span data-search-target={(item.entryId && item.entryId === searchEntryId) || undefined}><CompressIcon />上下文已自动压缩</span>
                </li>
              );
            }
            if (item.type === "switch") {
              return <li key={item.key} className="pw-proc-item pw-proc-mark"><span><SwapIcon />改用 <b>{item.model}</b></span></li>;
            }
            if (item.type === "failure") {
              const continued = !live || index < items.length - 1;
              return (
                <li key={item.key} className={item.failures[0].truncated ? "pw-proc-item pw-proc-error is-warn" : "pw-proc-item pw-proc-error"} data-entry-id={item.failures[0].entryId}>
                  <InlineFailure failures={item.failures} continued={continued} />
                </li>
              );
            }
            const isTarget = item.entryId === searchEntryId && item.block === searchBlock;
            const streaming = Boolean(live) && item.streaming;
            return (
              <li key={item.key} className={streaming ? "pw-proc-item pw-proc-narr is-streaming" : "pw-proc-item pw-proc-narr"}>
                <Narration block={item.block} entryId={item.entryId} isTarget={isTarget} streaming={streaming} cwd={cwd} onOpenFile={onOpenFile} />
              </li>
            );
          })}
          {live
            ? <LiveEnd startedAt={startedAt} phase={phase} streamingMessage={streamingMessage} />
            : end && <EndNode end={end} startedAt={startedAt} />}
        </ol>
      )}
    </section>
  );
});
