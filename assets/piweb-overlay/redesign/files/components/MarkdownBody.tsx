"use client";
import { PortableOutputImage } from "./PortableOutputImage";

import { createContext, memo, useContext, useMemo, useSyncExternalStore, type ComponentProps, type MouseEvent, type ReactElement } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import {
  getChatRehypePlugins,
  getChatRemarkPlugins,
  isMarkdownMathReady,
  loadMarkdownMath,
  markdownUrlTransform,
  needsMath,
  needsRawHtml,
  normalizeDisplayMath,
  splitStreamingMarkdown,
  subscribeMarkdownMath,
} from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

export { loadMarkdownMath };

const MarkdownLinkContext = createContext(false);

// Per-instance inputs for the renderers below. Keeping them out of the renderer
// closures makes the rendered element tree depend only on the text, so it can be
// cached across messages, re-renders and remounts (paging, switching sessions).
interface MarkdownRenderOptions {
  cwd?: string;
  isStreaming?: boolean;
  onOpenFile?: (filePath: string, page?: number) => void;
}
const MarkdownRenderContext = createContext<MarkdownRenderOptions>({});

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}

function MarkdownImage({
  src,
  alt,
  ...props
}: ComponentProps<"img"> & ExtraProps) {
  const insideLink = useContext(MarkdownLinkContext);
  const { cwd } = useContext(MarkdownRenderContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const imageSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
    : href;
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!imageSrc || insideLink) return image;
  return <PortableOutputImage src={imageSrc} alt={alt ?? ""} {...props} />;
}

function MarkdownCode({ className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const { isStreaming } = useContext(MarkdownRenderContext);
  const lang = className?.replace("language-", "").toLowerCase() ?? "";
  const raw = String(children);
  const isBlock = className?.includes("language-") || raw.includes("\n");
  if (isBlock) {
    if (lang === "mermaid") {
      return (
        <MermaidBlock
          code={raw.replace(/\n$/, "")}
          isStreaming={isStreaming}
          defaultPreview
        />
      );
    }
    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
  }
  return (
    <code
      className="markdown-inline-code"
      {...props}
    >
      {children}
    </code>
  );
}

function MarkdownPre({ children }: ComponentProps<"pre"> & ExtraProps) {
  return <>{children}</>;
}

function MarkdownLink({ href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const { cwd, onOpenFile } = useContext(MarkdownRenderContext);
  // `node` is react-markdown metadata, not a DOM attribute.
  delete props.node;
  const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
  const openFile = onOpenFile;
  if (!filePath || !openFile) {
    return (
      <MarkdownLinkContext.Provider value={true}>
        <a href={href} {...props} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      </MarkdownLinkContext.Provider>
    );
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldOpenLocalFileInApp(event)) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    openFile(filePath, parsePdfPageFragment(href) ?? undefined);
  };

  return (
    <MarkdownLinkContext.Provider value={true}>
      <a href={href} {...props} onClick={handleClick}>
        {children}
      </a>
    </MarkdownLinkContext.Provider>
  );
}

function MarkdownTable({ children }: ComponentProps<"table"> & ExtraProps) {
  return (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  code: MarkdownCode,
  pre: MarkdownPre,
  a: MarkdownLink,
  img: MarkdownImage,
  table: MarkdownTable,
};

// Parsed element trees, shared by every MarkdownBody: an LRU keyed by the
// normalized text plus the inputs that change the tree (cwd for local image URLs,
// in-app file links, KaTeX state). A hit costs nothing; React also skips the
// subtree because the element objects are identical.
const MAX_CACHE_ENTRIES = 600;
const MAX_CACHE_CHARS = 4_000_000;
const elementCache = new Map<string, { element: ReactElement; chars: number }>();
let cachedChars = 0;

function cacheGet(key: string): ReactElement | undefined {
  const hit = elementCache.get(key);
  if (!hit) return undefined;
  elementCache.delete(key);
  elementCache.set(key, hit);
  return hit.element;
}

function cacheSet(key: string, element: ReactElement, chars: number) {
  if (chars > MAX_CACHE_CHARS / 4) return;
  elementCache.set(key, { element, chars });
  cachedChars += chars;
  while (elementCache.size > MAX_CACHE_ENTRIES || cachedChars > MAX_CACHE_CHARS) {
    const oldest = elementCache.keys().next();
    if (oldest.done) break;
    cachedChars -= elementCache.get(oldest.value)?.chars ?? 0;
    elementCache.delete(oldest.value);
  }
}

function renderMarkdown(normalized: string, cwd: string | undefined, linkFiles: boolean, mathReady: boolean, cacheable: boolean): ReactElement {
  const math = needsMath(normalized) ? (mathReady ? "katex" : "pending") : "none";
  const key = `${math}|${linkFiles ? 1 : 0}|${cwd ?? ""}|${normalized}`;
  const cached = cacheable ? cacheGet(key) : undefined;
  if (cached) return cached;
  const element = Markdown({
    children: normalized,
    remarkPlugins: getChatRemarkPlugins(normalized),
    rehypePlugins: getChatRehypePlugins(cwd, needsRawHtml(normalized), math),
    urlTransform: linkFiles ? markdownUrlTransform : undefined,
    components: MARKDOWN_COMPONENTS,
  });
  if (cacheable) cacheSet(key, element, normalized.length);
  return element;
}

const StableMarkdownBlock = memo(function StableMarkdownBlock({ text, cwd, linkFiles, mathReady }: { text: string; cwd?: string; linkFiles: boolean; mathReady: boolean }) {
  return renderMarkdown(text, cwd, linkFiles, mathReady, true);
});

const MarkdownContent = memo(function MarkdownContent({ children, cwd, linkFiles, streaming }: { children: string; cwd?: string; linkFiles: boolean; streaming: boolean }) {
  const mathReady = useSyncExternalStore(subscribeMarkdownMath, isMarkdownMathReady, isMarkdownMathReady);
  const normalized = useMemo(() => normalizeDisplayMath(children), [children]);
  // While a reply streams, closed blocks are parsed once and only the growing tail
  // is parsed per frame; the finished message is parsed whole.
  const split = streaming ? splitStreamingMarkdown(normalized) : null;
  if (split) {
    return (
      <>
        {split.stable.map((text, index) => (
          <StableMarkdownBlock key={index} text={text} cwd={cwd} linkFiles={linkFiles} mathReady={mathReady} />
        ))}
        {renderMarkdown(split.tail, cwd, linkFiles, mathReady, false)}
      </>
    );
  }
  return renderMarkdown(normalized, cwd, linkFiles, mathReady, !streaming);
});

export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const options = useMemo<MarkdownRenderOptions>(() => ({ cwd, isStreaming, onOpenFile }), [cwd, isStreaming, onOpenFile]);
  return (
    <MarkdownRenderContext.Provider value={options}>
      <div className={["markdown-body", className].filter(Boolean).join(" ")}>
        <MarkdownContent cwd={cwd} linkFiles={Boolean(onOpenFile)} streaming={Boolean(isStreaming)}>{children}</MarkdownContent>
      </div>
    </MarkdownRenderContext.Provider>
  );
});
