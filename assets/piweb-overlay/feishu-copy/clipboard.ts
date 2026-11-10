import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { toHtml } from "hast-util-to-html";
import type { Root, RootContent } from "hast";
import { portableCjkEmphasis } from "./portable-cjk-emphasis.mjs";

export type CopyFormat = "plain" | "markdown" | "code" | "html";
export type ClipboardPayload = { text: string; html: string };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const styles: Record<string, string> = {
  h1: "font-size:20px;font-weight:bold;margin:12px 0 6px",
  h2: "font-size:18px;font-weight:bold;margin:12px 0 6px",
  h3: "font-size:16px;font-weight:bold;margin:10px 0 6px",
  h4: "font-size:15px;font-weight:bold;margin:8px 0 4px",
  h5: "font-size:14px;font-weight:bold;margin:8px 0 4px",
  h6: "font-size:14px;font-weight:bold;margin:8px 0 4px",
  p: "margin:0 0 8px;line-height:1.6", strong: "font-weight:bold", b: "font-weight:bold",
  em: "font-style:italic", i: "font-style:italic", del: "text-decoration:line-through", u: "text-decoration:underline",
  pre: "white-space:pre-wrap;font-family:monospace;margin:8px 0", code: "white-space:pre-wrap;font-family:monospace",
  blockquote: "border-left:3px solid #bbb;padding-left:12px;margin:8px 0",
  table: "border-collapse:collapse;margin:8px 0", th: "border:1px solid #bbb;padding:6px 10px;font-weight:bold",
  td: "border:1px solid #bbb;padding:6px 10px", ul: "padding-left:24px;margin:4px 0", ol: "padding-left:24px;margin:4px 0",
  li: "margin:2px 0", a: "color:#1456f0;text-decoration:underline",
};
const wrap = (html: string) => `<html><body><!--StartFragment--><div style="font-family:Arial,sans-serif;line-height:1.6">${html}</div><!--EndFragment--></body></html>`;

function clipboardStyles() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "element") {
        if (styles[node.tagName]) node.properties.style = styles[node.tagName];
        // Do not turn a text copy into an implicit upload/network fetch at the destination.
        if (node.tagName === "img") {
          const alt = String(node.properties.alt || "图片");
          const src = String(node.properties.src || "");
          node.tagName = "span"; node.properties = {};
          node.children = [{ type: "text", value: `[${alt}]${/^(https?:|file:)/i.test(src) ? ` (${src})` : ""}` }];
        }
        if (node.tagName === "input") {
          node.tagName = "span";
          node.children = [{ type: "text", value: node.properties.checked ? "☑ " : "☐ " }];
          node.properties = {};
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(portableCjkEmphasis)
  .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitize)
  .use(clipboardStyles);
const htmlProcessor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw).use(rehypeSanitize).use(clipboardStyles);

/** HTML is for Feishu/Docs; plain text ALWAYS remains the exact source for editors/terminals. */
export function createClipboardPayload(text: string, format: CopyFormat = "plain"): ClipboardPayload {
  let html: string;
  if (format === "markdown" || format === "html") {
    const processor = format === "markdown" ? markdownProcessor : htmlProcessor;
    html = toHtml(processor.runSync(processor.parse(text)));
  } else if (format === "code") {
    html = `<pre style="${styles.pre}"><code style="${styles.code}">${escapeHtml(text)}</code></pre>`;
  } else {
    html = `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
  }
  return { text, html: wrap(html) };
}

export function fileCopyFormat(path: string): CopyFormat {
  if (/\.(md|markdown|mdx)$/i.test(path)) return "markdown";
  if (/\.html?$/i.test(path)) return "html";
  if (/\.(txt|log|csv)$/i.test(path)) return "plain";
  return "code";
}

/** Also works on LAN HTTP / older WebViews, without selecting a hidden textarea or stealing focus. */
function legacyCopy(payload: ClipboardPayload): boolean {
  let handled = false;
  const listener = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
    event.preventDefault(); handled = true;
  };
  document.addEventListener("copy", listener, true);
  try { return document.execCommand("copy") && handled; }
  catch { return false; }
  finally { document.removeEventListener("copy", listener, true); }
}

export async function writeClipboard(payload: ClipboardPayload): Promise<void> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([payload.text], { type: "text/plain" }),
        "text/html": new Blob([payload.html], { type: "text/html" }),
      })]);
      return;
    } catch { /* permission/secure-context failure: try the synchronous rich copy event */ }
  }
  if (legacyCopy(payload)) return;
  // Last-resort compatibility: never pretend a failed write succeeded.
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(payload.text);
  throw new Error("复制失败：浏览器不允许访问剪贴板");
}

export function copyText(text: string, format: CopyFormat = "plain"): Promise<void> {
  return writeClipboard(createClipboardPayload(text, format));
}

/** Keep Ctrl+C / context-menu copy of rendered messages and file source free of UI and line numbers. */
export function installSelectionCopy(): () => void {
  const listener = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input,textarea,[contenteditable]")) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const element = (node: Node) => node instanceof Element ? node : node.parentElement;
    const root = element(range.startContainer)?.closest(".markdown-body,.pw-markdown,.pd-transcript,.file-source-view,.file-diff-view,.pw-file-preview-body,.craft-detail-body,.message-content");
    if (!root?.contains(range.endContainer)) return;
    const fragment = range.cloneContents();
    fragment.querySelectorAll("button,script,style,[aria-hidden='true'],.react-syntax-highlighter-line-number,.code-block-head,.code-block-header,.file-line-number").forEach(node => node.remove());
    const serialize = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? "");
      if (!(node instanceof Element)) return Array.from(node.childNodes).map(serialize).join("");
      const children = Array.from(node.childNodes).map(serialize).join("");
      const tag = node.tagName.toLowerCase();
      if (tag === "img") return escapeHtml(`[${node.getAttribute("alt") || "图片"}]`);
      if (tag === "br") return "<br>";
      if (!/^(p|div|span|h[1-6]|strong|b|em|i|del|s|u|pre|code|blockquote|table|thead|tbody|tr|th|td|ul|ol|li|a|hr)$/.test(tag)) return children;
      const href = node.getAttribute("href") || "";
      const attrs = tag === "a" && /^(https?:|mailto:|file:)/i.test(href) ? ` href="${escapeHtml(href)}"` : "";
      const style = styles[tag] || "";
      return `<${tag}${attrs}${style ? ` style="${style}"` : ""}>${children}</${tag}>`;
    };
    const source = root.matches(".file-source-view,.file-diff-view");
    const lines = [...fragment.querySelectorAll(".file-source-line,.file-diff-line")];
    lines.slice(0, -1).forEach(line => { if (!line.textContent?.endsWith("\n")) line.append("\n"); });
    const html = source ? `<pre style="${styles.pre}">${serialize(fragment)}</pre>` : serialize(fragment);
    const text = source ? (fragment.textContent ?? "") : selection.toString();
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", wrap(html));
    event.preventDefault();
  };
  document.addEventListener("copy", listener);
  return () => document.removeEventListener("copy", listener);
}
