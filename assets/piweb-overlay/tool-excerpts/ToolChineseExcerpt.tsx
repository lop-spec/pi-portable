"use client";

import { memo, useLayoutEffect, useRef, useState } from "react";

/** Extracted source text, explicitly NOT the assistant's reasoning. */
export const ToolChineseExcerpt = memo(function ToolChineseExcerpt({ phrases, toolName, entryId, replyActive = false }: {
  phrases: string[];
  toolName: string;
  entryId?: string;
  replyActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [wasReplyActive, setWasReplyActive] = useState(replyActive);
  // Reset once at the reply boundary, not on every tool-result update. A user may
  // expand the completed reply again without the next render fighting that choice.
  if (wasReplyActive !== replyActive) {
    setWasReplyActive(replyActive);
    if (wasReplyActive && !replyActive) setExpanded(false);
  }
  const text = phrases.join("\n\n");
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || expanded) return;
    const measure = () => setOverflowing(content.scrollHeight > content.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div data-entry-id={entryId} data-tool-chinese-excerpt="true" data-source-kind="tool-output" title={`来源：${toolName} 工具输出`}>
      <div ref={contentRef} data-tool-excerpt-content="true" style={{ margin: "4px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", display: expanded ? "block" : "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: expanded ? "unset" : 2, overflow: "hidden" }}>{text}</div>
      {overflowing && (
        <button type="button" className="pw-think-fold" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起摘录" : "展开摘录"}
        </button>
      )}
    </div>
  );
});
