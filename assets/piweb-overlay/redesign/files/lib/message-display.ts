import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  // A background subagent completion starts a new displayed turn, same as a
  // user message. A compaction summary does not: auto-compaction lands in the
  // middle of a turn, and anchoring on it split one turn's process into several
  // timelines. It now stays inside the turn as a one-line marker.
  return message.role === "user"
    || (message.role === "custom" && message.customType === "pi-web:subagent-notification");
}

export function isCompactionMessage(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  return message.role === "custom" && message.customType === "compaction";
}

/**
 * Only Chinese reasoning is shown (lop 2026-10-02\u300c\u5982\u679c\u4e0d\u662f\u4e2d\u6587\u63a8\u7406\u8fc7\u7a0b\u90a3\u5c31\u76f4\u63a5\u4e0d\u8981\u663e\u793a\u4e86\u300d; 2026-10-06 tightened:
 * Gemini-style English reasoning that merely quotes a few Chinese words must stay hidden). Reading units are
 * CJK characters plus whole Latin words (a run of letters, digits and . _ - counts once), so Chinese prose full of
 * identifiers like `run-supervisor.mjs` is not penalised; the block is shown when Chinese makes up at least
 * CHINESE_REASONING_MIN_SHARE of the units.
 */
export const CHINESE_REASONING_MIN_SHARE = 0.3;
export function chineseShare(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff]/gu, " ").match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)?.length ?? 0;
  return cjk + words === 0 ? 0 : cjk / (cjk + words);
}
export function isEmptyThinkingBlock(block: AssistantContentBlock, _options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && chineseShare(block.thinking) < CHINESE_REASONING_MIN_SHARE;
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * A turn that ended on `stopReason: "length"` spent its whole output budget
 * (often on reasoning alone) and produced no final answer; without a notice it
 * looks like a hung session. The copy lives in i18n (`chat.truncatedByOutputLimit`).
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

// ---------------------------------------------------------------------------
// Conversation display helpers (redesign: quiet timeline). Pure functions so
// the timeline, the answer footer and the error notices share one wording.
// ---------------------------------------------------------------------------

const HAN = /[㐀-鿿]/u;
const BOLD_HEADING_LINE = /^\s*\*\*(.+?)\*\*\s*$/u;

/**
 * Reasoning paragraphs for display: emphasis removed, and English-only bold headings
 * dropped (lop: 英文标题不渲染) — the Chinese body stays complete.
 */
export function thinkingParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter((part) => part && !(BOLD_HEADING_LINE.test(part) && !HAN.test(part)))
    .map((part) => part.replace(/\*\*(.+?)\*\*/gu, "$1"));
}

/** Plain thinking text for length checks and inline display, without English headings. */
export function plainThinkingText(text: string): string {
  return thinkingParagraphs(text).join(" ").replace(/\s+/gu, " ").trim();
}

function hanRatio(text: string): number {
  const visible = text.replace(/\s+/gu, "");
  if (!visible) return 0;
  return (visible.match(/[㐀-鿿]/gu)?.length ?? 0) / [...visible].length;
}

/**
 * Preview for a reasoning row: the latest Chinese bold heading; else the first line that is
 * mostly Chinese; else the first line that contains any Chinese. Markdown removed.
 */
export function thinkingHeadline(text: string): string {
  const headings = [...text.matchAll(/^\s*\*\*(.+?)\*\*\s*$/gmu)].map((match) => match[1].trim()).filter((line) => HAN.test(line));
  if (headings.length > 0) return headings[headings.length - 1].replace(/\*\*(.+?)\*\*/gu, "$1").trim();
  const lines = text.split(/\r?\n/u).map((part) => part.replace(/\*\*(.+?)\*\*/gu, "$1").trim()).filter(Boolean);
  return lines.find((line) => hanRatio(line) >= 0.3) ?? lines.find((line) => HAN.test(line)) ?? "";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 今天「11:06」，今年「9月29日 11:06」，跨年「2025/9/29 11:06」。 */
export function formatMessageTime(ts?: number, now: number = Date.now()): string | null {
  if (!ts) return null;
  const date = new Date(ts);
  const today = new Date(now);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() !== today.getFullYear()) return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`;
  if (date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) return time;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** Full local timestamp for tooltips. */
export function formatFullTime(ts?: number): string | null {
  if (!ts) return null;
  const date = new Date(ts);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 「38 秒」「4 分 07 秒」「1 小时 12 分」。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${pad2(total % 60)} 秒`;
  return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`;
}

/** Ticking clock for a running turn: 「0:42」「12:05」「1:02:03」。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

/** Below 10k keep thousands separators; above, one decimal with k / M. */
export function formatTokenCount(value: number): string {
  const trim = (text: string) => text.replace(/\.0$/u, "");
  if (value >= 1_000_000) return `${trim((value / 1_000_000).toFixed(1))}M`;
  if (value >= 10_000) return `${trim((value / 1_000).toFixed(1))}k`;
  return value.toLocaleString("en-US");
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** 「入 1,288 · 出 759 · 缓存 49.7k」，精确值放 title。 */
export function formatUsageCompact(usage: UsageLike | undefined | null): { text: string; title: string } | null {
  if (!usage) return null;
  const parts: string[] = [];
  const exact: string[] = [];
  const add = (short: string, long: string, value?: number) => {
    if (!value) return;
    parts.push(`${short} ${formatTokenCount(value)}`);
    exact.push(`${long} ${value.toLocaleString("en-US")}`);
  };
  add("入", "输入", usage.input);
  add("出", "输出", usage.output);
  add("缓存", "缓存读", usage.cacheRead);
  add("写缓存", "缓存写", usage.cacheWrite);
  const cost = usage.cost?.total;
  if (cost) {
    parts.push(`$${cost.toFixed(cost >= 1 ? 2 : 4)}`);
    exact.push(`费用 $${cost.toFixed(4)}`);
  }
  return parts.length > 0 ? { text: parts.join(" · "), title: exact.join(" · ") } : null;
}

/** Model name without the trailing configuration note: keeps the channel (「· AI Studio 网页」). */
export function modelNameWithoutNote(displayName: string): string {
  return displayName.replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim() || displayName;
}

/** 「GPT-5.6 Sol · 网页（max = Sol Pro）」→「GPT-5.6 Sol」；「provider/model-id」→「model-id」。 */
export function shortModelName(displayName: string): string {
  let name = modelNameWithoutNote(displayName).split(" · ")[0].trim();
  if (!/\s/u.test(name) && name.includes("/")) name = name.slice(name.lastIndexOf("/") + 1);
  return name || displayName;
}

export interface AssistantErrorSummary {
  /** Error code such as CHATGPT_RATE_LIMIT or HTTP 502; null when none is recognizable. */
  code: string | null;
  /** Chinese title for the code (「回复失败」 when unknown). */
  title: string;
  /** One-sentence Chinese explanation for known codes. */
  hint: string | null;
  /** The provider marked it as a transient transport failure (safe to retry). */
  transient: boolean;
  /** Original text without the code prefix and the transient note. */
  detail: string;
  raw: string;
}

const TRANSIENT_NOTE = /\s*\(transient transport failure;[^)]*\)\s*$/iu;

function clockOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Splits a provider error into code + Chinese title/explanation + original
 * text. Unknown codes keep only the original text; nothing is machine-translated.
 */
export function parseAssistantError(raw: string): AssistantErrorSummary {
  const text = (raw ?? "").trim();
  const transient = TRANSIENT_NOTE.test(text);
  const named = text.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/u)?.[1] ?? null;
  const status = text.match(/\bHTTP[\s/]?(\d{3})\b/iu)?.[1]
    ?? text.match(/\berror\s*\((\d{3})\)/iu)?.[1]
    ?? text.match(/\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/iu)?.[1]
    ?? null;
  const code = named ?? (status ? `HTTP ${status}` : null);
  let detail = text.replace(TRANSIENT_NOTE, "");
  detail = named
    ? detail.replace(new RegExp(`^(?:Error:\\s*)?${named}:\\s*`, "u"), "")
    : detail.replace(/^Error:\s*/u, "");
  detail = detail.trim() || text;
  const cooldown = clockOf(text.match(/cooldownUntil=(\S+?Z)\b/u)?.[1] ?? text.match(/paused until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/u)?.[1]);

  let title = "回复失败";
  let hint: string | null = null;
  const has = (pattern: RegExp) => Boolean(named && pattern.test(named));
  if (has(/PRE_SEND_BLOCKED$/u)) {
    title = "发送前被拦截";
    hint = cooldown ? `上一次限流到 ${cooldown} 才解除，本次没有发送。` : "本次请求没有发出。";
  } else if (has(/RATE_LIMIT/u) || status === "429") {
    title = "对话被限流";
    hint = cooldown ? `冷却至 ${cooldown}，之后可重试或切换模型。` : "请求过于频繁，稍后重试或切换模型。";
  } else if (has(/(USAGE_LIMIT|QUOTA)/u)) {
    title = "额度用尽";
    hint = "未重新提交。可切换模型，或等额度恢复后重发。";
  } else if (has(/INVALID_JSON$/u)) {
    title = "工具批次解析失败";
    hint = "模型返回的工具调用 JSON 不完整。";
  } else if (has(/WRITE_FAILED$/u)) {
    title = "提示词未写入";
    hint = "提示词没有完整写进网页输入框，本次没有发送。";
  } else if (has(/TOOL_CALL_(UNFINISHED|INVALID)/u)) {
    title = "工具调用无效";
    hint = "模型输出的工具调用不完整或不存在。";
  } else if (has(/EMPTY_ANSWER$/u)) {
    title = "回答为空";
    hint = "模型返回了空回答。";
  } else if (has(/REQUEST_MISMATCH$/u)) {
    title = "请求不一致";
    hint = "页面发出的请求与预期不符，已停止并重开对话。";
  } else if (has(/BROWSER_UNAVAILABLE$/u)) {
    title = "浏览器不可用";
    hint = "网页模型所用的浏览器未就绪，检查浏览器后重试。";
  } else if (has(/TIMEOUT/u)) {
    title = "请求超时";
  } else if (status === "401" || status === "403") {
    title = "鉴权失败";
  } else if (status?.startsWith("5")) {
    title = "上游服务出错";
  } else if (!code && /\b(aborted|terminated|cancell?ed)\b/iu.test(text)) {
    title = "回复中断";
  }
  if (!hint && transient) hint = "属于瞬时错误，可直接重试。";
  return { code, title, hint, transient, detail, raw: text };
}
