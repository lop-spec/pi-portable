"use client";

import { memo, useState } from "react";

/** Extracted source text, explicitly NOT the assistant's reasoning. */
export const ToolChineseExcerpt = memo(function ToolChineseExcerpt({ phrases, toolName, entryId }: {
  phrases: string[];
  toolName: string;
  entryId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
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
