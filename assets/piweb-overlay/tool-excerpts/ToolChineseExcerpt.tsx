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
    <div data-entry-id={entryId} data-tool-chinese-excerpt="true">
      <span className="pw-think-label" title="工具返回文本的中文摘录，不是模型推理；已过滤敏感字段行">工具中文摘录 · {toolName}</span>
      <p style={{ margin: "4px 0", overflowWrap: "anywhere" }}>{visible.join("；")}</p>
      {phrases.length > 6 && (
        <button type="button" className="pw-think-fold" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起摘录" : `展开其余 ${phrases.length - 6} 条`}
        </button>
      )}
    </div>
  );
});
