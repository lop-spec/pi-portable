import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { default: GlobalError } = await jiti.import("./global-error.tsx");
const source = (await readFile(new URL("./global-error.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const chunkError = () => Object.assign(new Error("Loading chunk 4703 failed."), { name: "ChunkLoadError" });

test("regression: the root error page exists (the app had no global-error, so a render error outside every boundary left a white page)", () => {
  assert.match(source, /^"use client";/);
  // 它替换根布局：自带 html/body
  assert.match(source, /<html lang="zh-CN">\n\s+<body style=\{BODY_STYLE\}>/);
  assert.match(source, /export default function GlobalError\(\{ error, reset \}/);
});

test("regression: a chunk error offers 刷新页面 as the primary action; any other error stays recoverable with 重试 first", () => {
  const chunk = renderToStaticMarkup(React.createElement(GlobalError, { error: chunkError(), reset() {} }));
  assert.match(chunk, /role="alert"/);
  assert.match(chunk, /页面资源已更新/);
  assert.match(chunk, /刷新页面即可恢复/);
  assert.match(chunk, /<button type="button" style="[^"]*background:var\(--accent, LinkText\)[^"]*">刷新页面<\/button>/);
  const other = renderToStaticMarkup(React.createElement(GlobalError, { error: new Error("boom <b>"), reset() {} }));
  assert.match(other, /页面出错了/);
  assert.match(other, /boom &lt;b&gt;/);
  assert.match(other, /<button type="button" style="[^"]*background:var\(--accent, LinkText\)[^"]*">重试<\/button>/);
  assert.doesNotMatch(other, /刷新页面即可恢复/);
});

test("regression: a chunk error reloads once through the sessionStorage guard, logs why, and other errors never reload automatically", () => {
  assert.match(source, /import \{ claimChunkReload, isChunkLoadError \} from "@\/components\/ErrorBoundary";/);
  assert.match(source, /if \(!chunk\) return;/);
  assert.match(source, /storage = window\.sessionStorage;/);
  assert.match(source, /if \(claimChunkReload\(storage, Date\.now\(\)\)\) \{\n\s+console\.warn\([^\n]*\);\n\s+setReloading\(true\);\n\s+window\.location\.reload\(\);\n\s+\} else \{\n\s+console\.error\(/);
  assert.match(source, /console\.error\(`\[pi-web\] 页面渲染失败（global-error/);
  // 样式不依赖 layout 里的样式表，也不写字面色（硬编码颜色规则）
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
