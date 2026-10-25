"use client";

import { memo, useState } from "react";

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
  const visible = expanded ? phrases : phrases.slice(0, 6);
  return (
    <div data-entry-id={entryId} data-tool-chinese-excerpt="true" data-source-kind="tool-output" title={`来源：${toolName} 工具输出`}>
      {visible.map((text, index) => <p key={index} style={{ margin: "4px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</p>)}
      {phrases.length > 6 && (
        <button type="button" className="pw-think-fold" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起摘录" : `展开其余 ${phrases.length - 6} 段`}
        </button>
      )}
    </div>
  );
});
