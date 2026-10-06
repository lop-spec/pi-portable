"use client";

// Error presentation for the conversation (redesign D15): a code + Chinese title
// + the original text in the body font, never a red monospace wall. The turn
// block sits where the answer would be; the inline form lives in the process rail.
import { useId, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { formatMessageTime, parseAssistantError } from "@/lib/message-display";
import { AlertCircleIcon, AlertTriangleIcon, CheckIcon, ChevronDownIcon, CopyIcon } from "./icons";

function canExpand(raw: string, detail: string): boolean {
  return raw !== detail || raw.length > 140 || raw.includes("\n");
}

/** Turn-level failure: the reply ended on a provider error. */
export function TurnErrorBlock({ message }: { message: string }) {
  const summary = parseAssistantError(message);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyId = useId();
  const expandable = canExpand(summary.raw, summary.detail);
  return (
    <div className="pw-err-block" role="alert">
      <div className="pw-err-head">
        <AlertCircleIcon className="pw-err-icon" />
        <span className="pw-err-title">{summary.title}</span>
        {summary.code && <code className="pw-err-code" title={summary.code}>{summary.code}</code>}
        <span className="pw-err-acts">
          <button
            type="button"
            className="pw-btn pw-btn--ghost pw-btn--sm"
            title="复制错误全文"
            onClick={() => { void copyText(summary.raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "已复制" : "复制"}
          </button>
          {expandable && (
            <button type="button" className="pw-btn pw-btn--ghost pw-btn--sm pw-err-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "展开"}
              <ChevronDownIcon />
            </button>
          )}
        </span>
      </div>
      <p id={bodyId} className={expanded ? "pw-err-msg is-open" : "pw-err-msg"}>{expanded ? summary.raw : summary.detail}</p>
      {summary.hint && <p className="pw-err-hint">{summary.hint}</p>}
    </div>
  );
}

export type InlineFailureRecord = { entryId?: string; raw: string; truncated: boolean; timestamp?: number };

/**
 * An intermediate reply that failed (or hit the output limit) while the turn
 * went on. Consecutive failures with the same code arrive merged (×N).
 */
export function InlineFailure({ failures, continued }: { failures: InlineFailureRecord[]; continued: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const latest = failures[failures.length - 1];
  if (latest.truncated) {
    return (
      <div className="pw-err-inline is-warn" role="note">
        <div className="pw-err-head">
          <AlertTriangleIcon className="pw-err-icon" />
          <span className="pw-err-title">输出被截断{failures.length > 1 ? ` ×${failures.length}` : ""}</span>
          <span className="pw-err-tag">{continued ? "已继续" : ""}</span>
        </div>
        <p className="pw-err-msg">这次回复达到模型输出长度上限，内容不完整。</p>
      </div>
    );
  }
  const summary = parseAssistantError(latest.raw);
  const single = failures.length === 1;
  const first = failures[0];
  const start = formatMessageTime(first.timestamp);
  const end = formatMessageTime(latest.timestamp);
  const range = failures.length > 1 && start && end ? (start === end ? start : `${start}–${end.replace(/^.*\s/u, "")}`) : null;
  const tag = [range, summary.transient ? "瞬时错误" : null, continued ? "已继续" : null].filter(Boolean).join(" · ");
  return (
    <div className="pw-err-inline" role="note">
      <div className="pw-err-head">
        <AlertTriangleIcon className="pw-err-icon" />
        <span className="pw-err-title">{summary.code ? summary.title : "中间回复失败"}{failures.length > 1 ? ` ×${failures.length}` : ""}</span>
        {summary.code && <code className="pw-err-code" title={summary.code}>{summary.code}</code>}
        {tag && <span className="pw-err-tag">{tag}</span>}
      </div>
      {/* 原文最多两行，点开看全文；合并的多次失败逐条列出时间和原文。 */}
      <button type="button" className="pw-err-msg-btn" aria-expanded={expanded} aria-controls={expanded && (summary.hint || !single) ? bodyId : undefined} title={expanded ? "收起原文" : "展开原文"} onClick={() => setExpanded((value) => !value)}>
        <span className={expanded && single ? "pw-err-msg is-open" : "pw-err-msg"}>{expanded && single ? summary.raw : summary.detail}</span>
      </button>
      {expanded && (summary.hint || !single) && (
        <div id={bodyId} className="pw-err-detail">
          {summary.hint && <p className="pw-err-hint">{summary.hint}</p>}
          {!single && failures.map((failure, index) => (
            <p key={`${failure.entryId ?? "failure"}-${index}`}>
              {failure.timestamp && <time>{formatMessageTime(failure.timestamp)}</time>}
              {failure.raw}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
