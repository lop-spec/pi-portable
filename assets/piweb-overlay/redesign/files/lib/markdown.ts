import type { Element as HastElement, Root as HastRoot, RootContent as HastNode } from "hast";
import { defaultUrlTransform, type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { portableImageUrls } from "./portable-image-urls";
import { KATEX_OPTIONS, markdownSanitizeSchema, remarkGfmOptions } from "./markdown-shared";

export { KATEX_OPTIONS, markdownPreviewRemarkPlugins, markdownSanitizeSchema, rehypeEnsureMathStyles } from "./markdown-shared";

type PluginList = NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
type Plugin = PluginList[number];

export function markdownUrlTransform(value: string): string {
  return /^file:/i.test(value) ? value : defaultUrlTransform(value);
}

const escapedInlineCodePattern = /(?<![\\`])`((?:[^`\n]|\\`)+?)(?<![\\`])`(?!`)/g;

function rewriteEscapedInlineCodeBackticks(line: string): string {
  return line.replace(escapedInlineCodePattern, (match, content: string) => {
    const code = content.replace(/\\`/g, "`");
    if (code === content) return match;
    const marker = "`".repeat(Math.max(...(code.match(/`+/g)?.map((run) => run.length) ?? [0])) + 1);
    return `${marker}${code}${marker}`;
  });
}

export function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inlineCodeMarkerSize = 0;
  let rawCodeTag: string | null = null;
  const unmatchedDisplayMathUntil = new Map<string, number>();

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (new RegExp(`</${rawCodeTag}\\s*>`, "i").test(line)) rawCodeTag = null;
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (fence) {
      normalized.push(line);
      continue;
    }

    const rawCodeOpen = line.match(/<(code|pre|script|style)\b/i);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = line.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) rawCodeTag = tag;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) || line.trim() === "") {
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (!inlineCodeMarkerSize) line = rewriteEscapedInlineCodeBackticks(line);

    if (inlineCodeMarkerSize || line.includes("`")) {
      inlineCodeMarkerSize = updateInlineCodeMarker(line, inlineCodeMarkerSize);
      normalized.push(line);
      continue;
    }

    const bracketDisplayOneLine = line.match(/^([ ]{0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/);
    if (bracketDisplayOneLine) {
      const math = bracketDisplayOneLine[2].trim();
      if (math) {
        // Keep the content line indented together with the `$$` fence. When the
        // formula is nested inside a GFM list item (indented `$$`), a content line
        // at column 0 becomes a "lazy continuation" line, which makes remark-math
        // mis-parse the fence pair: the opening `$$` turns into an empty math node
        // and the closing one swallows the rest of the document as math content.
        normalized.push(
          `${bracketDisplayOneLine[1]}$$`,
          `${bracketDisplayOneLine[1]}${math}`,
          `${bracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const looseBracketDisplayOneLine = line.match(/^([ ]{0,3})\[[ \t]*(.+?)[ \t]*\][ \t]*$/);
    if (looseBracketDisplayOneLine) {
      const math = looseBracketDisplayOneLine[2].trim();
      if (isLikelyMathExpression(math)) {
        normalized.push(
          `${looseBracketDisplayOneLine[1]}$$`,
          `${looseBracketDisplayOneLine[1]}${math}`,
          `${looseBracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1);
      if (closingIndex !== -1) {
        // Same lazy-continuation guard as above: indent content lines that sit at
        // column 0 so the block stays parseable when nested inside a list item.
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex).map((mathLine) =>
            indentDisplayMathContent(mathLine, bracketDisplayStart[1]),
          ),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
    if (displayMathMatch) {
      const math = displayMathMatch[2].trim();
      if (math) {
        // See the comment on bracketDisplayOneLine: without matching indentation,
        // a formula nested in a GFM list item is mis-parsed by remark-math and the
        // text after the formula renders as a garbled KaTeX error block.
        normalized.push(
          `${displayMathMatch[1]}$$`,
          `${displayMathMatch[1]}${math}`,
          `${displayMathMatch[1]}$$`,
        );
        continue;
      }
    }

    // remark-math requires both `$$` delimiters to sit on their own lines, but
    // models also emit display math as a multi-line block where the opening `$$`
    // is glued to the first formula line and/or the closing `$$` is glued to the
    // end of the last one (`$$x = 1` + `y = 2$$`). Without normalization such a
    // block swallows the following text as math content and renders as garbage.
    const displayMathMultiLine = line.match(/^([ \t]{0,3})\$\$(.+)$/);
    if (displayMathMultiLine) {
      const indent = displayMathMultiLine[1];
      const firstLine = displayMathMultiLine[2].trimEnd();
      // Only treat this as a block opener if no other `$$` is embedded mid-line
      // (e.g. `$$x$$ and text` stays untouched and is rendered as inline math).
      if (firstLine && !firstLine.includes("$$")) {
        const closing = findDisplayMathClose(
          lines,
          index + 1,
          indent,
          unmatchedDisplayMathUntil,
        );
        if (closing) {
          normalized.push(`${indent}$$`, `${indent}${firstLine}`);
          for (let j = index + 1; j < closing.index; j++) {
            normalized.push(indentDisplayMathContent(lines[j], indent));
          }
          if (closing.content) normalized.push(`${indent}${closing.content}`);
          normalized.push(`${indent}$$`);
          index = closing.index;
          continue;
        }
      }
    }

    // Bare `$$` opener (possibly indented inside a GFM list item). Two problems
    // need fixing: (1) when the closing `$$` is glued to the last content line
    // (e.g. `z = w$$`) remark-math never finds a valid closing fence and swallows
    // the rest of the document; (2) inside a list item, content lines at column 0
    // are lazy continuations that break the math flow. Both are fixed by moving
    // the closing `$$` to its own line and re-indenting lazy content lines.
    // A column-0 block with a properly detached closing `$$` is left untouched
    // (remark-math already parses it correctly).
    const displayMathBareOpen = line.match(/^([ \t]{0,3})\$\$\s*$/);
    if (displayMathBareOpen) {
      const indent = displayMathBareOpen[1];
      const closing = findDisplayMathClose(
        lines,
        index + 1,
        indent,
        unmatchedDisplayMathUntil,
      );
      if (closing && (closing.glued || indent !== "")) {
        normalized.push(`${indent}$$`);
        for (let j = index + 1; j < closing.index; j++) {
          normalized.push(indentDisplayMathContent(lines[j], indent));
        }
        if (closing.content) normalized.push(`${indent}${closing.content}`);
        normalized.push(`${indent}$$`);
        index = closing.index;
        continue;
      }
    }

    normalized.push(normalizeInlineLatexMath(line));
  }

  return normalized.join(lineBreak);
}

interface DisplayMathClose {
  index: number;
  content: string;
  glued: boolean;
}

function findDisplayMathClose(
  lines: string[],
  startIndex: number,
  indent: string,
  unmatchedUntil: Map<string, number>,
): DisplayMathClose | null {
  const knownUnmatchedUntil = unmatchedUntil.get(indent);
  if (knownUnmatchedUntil !== undefined && startIndex < knownUnmatchedUntil) return null;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (isDisplayMathFence(line, indent)) return { index, content: "", glued: false };

    // A new Markdown block cannot belong to the preceding formula. In particular,
    // do not let a later sibling list item provide a closing `$$` for this block.
    if (isDisplayMathBlockBoundary(line) || isDisplayMathOpeningLine(line)) {
      unmatchedUntil.set(indent, index);
      return null;
    }

    const content = getDisplayMathGluedCloseContent(line, indent);
    if (content !== null) return { index, content, glued: true };
  }

  // Multiple unmatched glued openers with the same indentation previously each
  // scanned to EOF. Cache this range so the overall search remains linear.
  unmatchedUntil.set(indent, lines.length);
  return null;
}

function isDisplayMathFence(line: string, indent: string): boolean {
  if (indent === "") return /^ {0,3}\$\$\s*$/.test(line);
  return line.startsWith(indent) && /^\$\$\s*$/.test(line.slice(indent.length));
}

function getDisplayMathGluedCloseContent(line: string, indent: string): string | null {
  if (!line.startsWith(indent)) return null;

  const match = line.slice(indent.length).match(/^(.+?)\$\$\s*$/);
  if (!match) return null;

  const content = match[1].trimEnd();
  return content && !content.includes("$$") ? content : null;
}

function isDisplayMathOpeningLine(line: string): boolean {
  return /^ {0,3}\$\$(?:\S|[ \t]+\S)/.test(line);
}

function isDisplayMathBlockBoundary(line: string): boolean {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /<(code|pre|script|style)\b/i.test(line)
  );
}

function indentDisplayMathContent(line: string, indent: string): string {
  if (!indent || !line || line.startsWith("\t")) return line;

  const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
  if (leadingSpaces >= indent.length) return line;
  return `${indent.slice(leadingSpaces)}${line}`;
}

function findBracketDisplayClose(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // Do not pair delimiters across another Markdown block boundary.
    if (
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      /<(code|pre|script|style)\b/i.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function updateInlineCodeMarker(line: string, initialMarkerSize: number): number {
  let markerSize = initialMarkerSize;
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] !== "`") {
      cursor++;
      continue;
    }

    let end = cursor + 1;
    while (line[end] === "`") end++;
    const runSize = end - cursor;
    if (markerSize === 0) markerSize = runSize;
    else if (runSize === markerSize) markerSize = 0;
    cursor = end;
  }
  return markerSize;
}

function normalizeInlineLatexMath(line: string): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /]\s*\(/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b(?:https?|file|mailto):/i.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  return line.replace(
    /(?<!\\)\\\(([^`\r\n$]+?)(?<!\\)\\\)/g,
    (match, math: string) => (math.trim() ? `$${math}$` : match),
  );
}

function isLikelyMathExpression(value: string): boolean {
  return /\\[A-Za-z]+/.test(value) && !/\b(?:https?|file|mailto):|\b[A-Za-z]:\\|^\\\\/i.test(value);
}


// ---------------------------------------------------------------------------
// Chat pipeline: plugins chosen by content, KaTeX loaded on demand.
//
// - rehype-raw re-parses the whole tree through parse5. Raw HTML nodes only exist
//   when the source has a `<` that opens a tag/comment/declaration, so plain
//   markdown skips it (the output is identical: there is nothing raw to parse).
// - remark-frontmatter only ever matches at the very start of the document.
// - remark-math stays on for every message so parsing never changes; only the
//   KaTeX renderer (and its stylesheet) is lazy. Until it arrives, math nodes show
//   their TeX source as code, then every mounted message with math re-renders.
// ---------------------------------------------------------------------------

const RAW_HTML_PATTERN = /<[A-Za-z!/?]/;

/** True when the (normalized) markdown may contain raw HTML nodes. */
export function needsRawHtml(normalized: string): boolean {
  return RAW_HTML_PATTERN.test(normalized);
}

/** True when the (normalized) markdown may contain math nodes (remark-math only reacts to `$`). */
export function needsMath(normalized: string): boolean {
  return normalized.includes("$");
}

const chatRemarkPlugins: PluginList = [[remarkGfm, remarkGfmOptions], remarkMath];
const chatRemarkPluginsWithFrontmatter: PluginList = [[remarkFrontmatter, ["yaml"]], [remarkGfm, remarkGfmOptions], remarkMath];

export function getChatRemarkPlugins(normalized: string): PluginList {
  return normalized.trimStart().startsWith("---") ? chatRemarkPluginsWithFrontmatter : chatRemarkPlugins;
}

let mathRehype: Plugin | null = null;
let mathLoad: Promise<void> | null = null;
const mathListeners = new Set<() => void>();

export function isMarkdownMathReady(): boolean {
  return mathRehype !== null;
}

export function subscribeMarkdownMath(listener: () => void): () => void {
  mathListeners.add(listener);
  return () => { mathListeners.delete(listener); };
}

/** Loads KaTeX (renderer + stylesheet) once; resolves immediately when already loaded. */
export function loadMarkdownMath(): Promise<void> {
  if (mathRehype) return Promise.resolve();
  if (!mathLoad) {
    const load = typeof window === "undefined"
      ? import("rehype-katex").then((module) => module.default)
      : import("./markdown-katex").then((module) => module.rehypeKatex);
    mathLoad = load.then((plugin) => {
      mathRehype = [plugin, KATEX_OPTIONS];
      for (const listener of [...mathListeners]) listener();
    }, (error) => {
      // Formulas keep showing their TeX source; the next message with math retries.
      mathLoad = null;
      console.error("[pi-web] KaTeX failed to load; formulas stay as TeX source:", error);
    });
  }
  return mathLoad;
}

function hasClass(node: HastElement, name: string): boolean {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.includes(name) : value === name;
}

/**
 * Before KaTeX arrives: math nodes render as plain code holding the TeX source, and the
 * first real math node (not just a `$` in shell text) starts loading KaTeX.
 */
function rehypeMathPending() {
  return (tree: HastRoot) => {
    let found = false;
    const visit = (node: HastRoot | HastNode) => {
      if (node.type === "element" && node.tagName === "code" && (hasClass(node, "math-inline") || hasClass(node, "math-display"))) {
        // Plain text holders (not code): inline math can span lines and must stay valid
        // inside a paragraph.
        node.tagName = hasClass(node, "math-inline") ? "span" : "div";
        node.properties = { className: ["pw-math-pending"] };
        found = true;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
    // This runs while React renders; start the import afterwards (it inserts a stylesheet).
    if (found && typeof window !== "undefined") setTimeout(() => void loadMarkdownMath(), 0);
  };
}

export type ChatMathMode = "none" | "pending" | "katex";

const chatRehypeCache = new Map<string, PluginList>();

/** Rehype plugins for one chat message: same order and schema as the file-preview plugins. */
export function getChatRehypePlugins(cwd: string | undefined, raw: boolean, math: ChatMathMode): PluginList {
  const mode: ChatMathMode = math === "katex" && !mathRehype ? "pending" : math;
  const key = `${raw ? 1 : 0}${mode}|${cwd ?? ""}`;
  let plugins = chatRehypeCache.get(key);
  if (!plugins) {
    const mathPlugin = mode === "katex" ? mathRehype : mode === "pending" ? rehypeMathPending : null;
    plugins = [
      ...(raw ? [rehypeRaw] : []),
      [portableImageUrls, { cwd }],
      [rehypeSanitize, markdownSanitizeSchema],
      ...(mathPlugin ? [mathPlugin] : []),
    ];
    if (chatRehypeCache.size > 64) chatRehypeCache.clear();
    chatRehypeCache.set(key, plugins);
  }
  return plugins;
}

// ---------------------------------------------------------------------------
// Streaming: split the reply into closed blocks (parsed once, cached) and the
// growing tail (re-parsed each frame). Only splits where CommonMark guarantees the
// previous blocks are final: a blank line outside fences/display math, followed by
// a complete, unindented line that cannot continue a list or block quote. Documents
// whose blocks can affect each other (reference definitions, footnotes, multi-line
// raw HTML) are not split. The finished message is always parsed as a whole.
// ---------------------------------------------------------------------------

const UNSPLITTABLE_PATTERN = /^ {0,3}\[[^\]\n]+\]:|\[\^|<!--|<(?:pre|script|style|textarea)\b|<\?|<!\[CDATA\[/im;
const MIN_SPLIT_CHARS = 600;

export function splitStreamingMarkdown(markdown: string): { stable: string[]; tail: string } | null {
  if (markdown.length < MIN_SPLIT_CHARS || UNSPLITTABLE_PATTERN.test(markdown)) return null;
  const lines = markdown.split("\n");
  const stable: string[] = [];
  let blockStart = 0;
  let fence: { marker: string; size: number } | null = null;
  let inMath = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!inMath) {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const size = fenceMatch[1].length;
        if (!fence) fence = { marker, size };
        else if (marker === fence.marker && size >= fence.size && line.trim().length === size) fence = null;
        continue;
      }
    }
    if (fence) continue;
    if (/^\s*\$\$\s*$/.test(line)) { inMath = !inMath; continue; }
    if (inMath || line.trim() !== "") continue;
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === "") next++;
    // The next block's first line must be complete before its kind is known.
    if (next >= lines.length - 1) break;
    const first = lines[next];
    if (/^[ \t]/.test(first) || /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|\r?$)/.test(first) || first.startsWith(">")) {
      index = next - 1;
      continue;
    }
    stable.push(lines.slice(blockStart, next).join("\n"));
    blockStart = next;
    index = next - 1;
  }
  if (stable.length === 0) return null;
  return { stable, tail: lines.slice(blockStart).join("\n") };
}
