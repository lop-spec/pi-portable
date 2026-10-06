// Markdown pipeline for file previews (FileViewer): formulas render synchronously with
// KaTeX in place. Kept apart from lib/markdown so the chat bundle, which loads KaTeX
// only when a message has math, does not pull it into the first load.
import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { KATEX_OPTIONS, markdownPreviewRemarkPlugins, markdownSanitizeSchema, rehypeEnsureMathStyles } from "./markdown-shared";

export { markdownPreviewRemarkPlugins };

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, KATEX_OPTIONS],
  rehypeEnsureMathStyles,
];
