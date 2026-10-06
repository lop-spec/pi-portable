// Markdown settings shared by the chat pipeline (lib/markdown) and file previews
// (lib/markdown-preview). Holds no KaTeX import, so neither side drags it in.
import type { Root as HastRoot } from "hast";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { defaultSchema } from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

// Parse YAML frontmatter into a `yaml` node before the math/GFM plugins run, so
// the raw metadata never leaks into the rendered output (without it, the opening
// `---` becomes an <hr> and the closing `---` turns the YAML into a setext heading).
// singleTilde:false requires ~~double~~ tildes for strikethrough. A single `~`
// is the standard CJK numeric-range separator (e.g. "5~7U", "100~200倍"), and
// GFM's default single-tilde strikethrough silently mangled such ranges (#385).
export const remarkGfmOptions = { singleTilde: false } as const;

export const markdownPreviewRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkMath,
];

export const KATEX_OPTIONS = { throwOnError: false, strict: false } as const;

// File previews render math synchronously; the KaTeX stylesheet is no longer part of
// the root layout, so request its lazy chunk whenever a preview has math.
export function rehypeEnsureMathStyles() {
  return (_tree: HastRoot, file: { value?: unknown }) => {
    if (typeof window === "undefined" || !String(file?.value ?? "").includes("$")) return;
    // Runs while React renders; start the import (it inserts a stylesheet) afterwards.
    setTimeout(() => {
      import("./markdown-katex").catch((error) => {
        console.error("[pi-web] KaTeX stylesheet failed to load:", error);
      });
    }, 0);
  };
}
