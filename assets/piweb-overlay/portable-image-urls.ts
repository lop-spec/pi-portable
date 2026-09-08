import type { Root } from "hast";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";

/** Rewrite image paths before sanitization; never relax the URL protocol allowlist. */
export function portableImageUrls({ cwd }: { cwd?: string } = {}) {
  return (tree: Root) => {
    const visit = (node: Root | Root["children"][number]) => {
      if (node.type === "element" && node.tagName === "img") {
        const src = node.properties.src;
        const file = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
        if (file) node.properties.src = `/api/files/${encodeFilePathForApi(file)}?type=read`;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}
