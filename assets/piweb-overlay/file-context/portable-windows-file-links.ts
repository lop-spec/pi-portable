import type { Root } from "hast";

/** Keep absolute Windows paths local before the HTML sanitizer sees `C:` as a URL scheme. */
export function portableWindowsFileLinks() {
  return (tree: Root) => {
    const walk = (node: { type: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
      const href = node.properties?.href;
      if (node.type === "element" && node.tagName === "a" && typeof href === "string" && /^[a-zA-Z]:[\\/]/.test(href)) {
        node.properties!.href = `file:///${href.replace(/\\/g, "/")}`;
      }
      for (const child of node.children ?? []) if (child && typeof child === "object") walk(child as typeof node);
    };
    walk(tree);
  };
}
