// Lazy chunk for chat formulas: KaTeX's renderer and its stylesheet load only when a
// rendered message actually contains math (see loadMarkdownMath in lib/markdown.ts).
import "katex/dist/katex.min.css";

export { default as rehypeKatex } from "rehype-katex";
