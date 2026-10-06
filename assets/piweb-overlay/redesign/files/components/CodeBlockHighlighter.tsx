"use client";
// 代码高亮的懒加载 chunk（P26）：PrismLight + 静态注册常用语言，其余语言按纯文本显示。
// 只由 CodeBlock（React.lazy，见 MermaidBlock.tsx）和 FileViewer（本身是 next/dynamic chunk）引用，
// 首屏不加载 refractor 全量语言和 46 套主题。主题按文件路径导入 ESM 单文件（只有 vs / vsc-dark-plus）。
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { useTheme } from "@/hooks/useTheme";
import { CODE_FONT_STYLE, CODE_LINE_NUMBER_STYLE, CODE_PRE_STYLE } from "./CodeBlockStyle";

// 依赖（clike、markup-templating 等）由 refractor 的语言函数自行注册；别名（js/ts/sh/html/xml/yml/py/md…）随语言带上。
for (const [name, language] of [
  ["markup", markup], ["css", css], ["javascript", javascript], ["jsx", jsx], ["typescript", typescript], ["tsx", tsx],
  ["bash", bash], ["json", json], ["yaml", yaml], ["python", python], ["go", go], ["diff", diff],
  ["markdown", markdown], ["sql", sql], ["powershell", powershell],
] as const) {
  PrismLight.registerLanguage(name, language);
}
PrismLight.alias({ bash: ["zsh", "console", "shell-session"], json: ["jsonc", "jsonl"], powershell: ["ps1", "pwsh"], javascript: ["mjs", "cjs"], typescript: ["mts", "cts"] });

export { PrismLight as SyntaxHighlighter };

export function codeStyleFor(isDark: boolean) {
  return isDark ? vscDarkPlus : vs;
}

export interface HighlightedCodeProps {
  code: string;
  lang: string;
}

/**
 * 对话里的代码块正文（CodeBlock 的非流式视图）。外层 .markdown-code-block 与表头由 CodeBlock 渲染，
 * 这里只出 <pre>。未注册的语言由 refractor 抛错、react-syntax-highlighter 回退为纯文本，不会白屏。
 */
export default function HighlightedCode({ code, lang }: HighlightedCodeProps) {
  const { isDark } = useTheme();
  return (
    <PrismLight
      language={lang || "text"}
      style={codeStyleFor(isDark)}
      showLineNumbers
      lineNumberStyle={CODE_LINE_NUMBER_STYLE}
      customStyle={CODE_PRE_STYLE}
      codeTagProps={{ style: CODE_FONT_STYLE }}
    >
      {code}
    </PrismLight>
  );
}

