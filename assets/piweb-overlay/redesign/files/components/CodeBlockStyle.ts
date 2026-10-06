// CodeBlock 的版式常量：高亮视图（CodeBlockHighlighter，懒加载）和占位视图（流式 / chunk 加载中，MermaidBlock.tsx）
// 共用同一套尺寸与底色，高亮到达时不跳版。这个文件必须保持轻量，首屏会带上它。
export const CODE_PRE_STYLE = {
  margin: 0,
  padding: "11px 13px",
  fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))",
  lineHeight: 1.62,
  borderRadius: 0,
  background: "var(--code-bg)",
} as const;

export const CODE_LINE_NUMBER_STYLE = { color: "var(--text-dim)", fontStyle: "normal" } as const;

// react-syntax-highlighter 会改写 codeTagProps.style（补 whiteSpace），所以外层对象每次渲染新建，只共享这个内层样式。
export const CODE_FONT_STYLE = { fontFamily: "var(--font-mono)" } as const;
