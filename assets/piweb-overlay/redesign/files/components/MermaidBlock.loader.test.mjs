import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { createRetryableLoader } = await jiti.import("./MermaidBlock.tsx");
const source = (await readFile(new URL("./MermaidBlock.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("a failed chunk load is not cached: the next call retries and the result is then shared", async () => {
  let calls = 0;
  const failures = [];
  const load = createRetryableLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Loading chunk 4703 failed.");
    return { SyntaxHighlighter: "ready" };
  }, (error) => failures.push(error.message));
  await assert.rejects(load(), /Loading chunk 4703 failed/);
  assert.deepEqual(failures, ["Loading chunk 4703 failed."], "the failure is reported once");
  const first = load();
  assert.equal(load(), first, "concurrent callers share the in-flight load");
  assert.deepEqual(await first, { SyntaxHighlighter: "ready" });
  assert.equal(load(), first, "a success stays cached");
  assert.equal(calls, 2);
});

test("a failed highlighter chunk degrades code blocks to plain text instead of unmounting the page", () => {
  // The cached rejection is cleared, React.lazy (which remembers rejections) is replaced, and the failure is logged.
  assert.match(source, /export const preloadCodeHighlighter = createRetryableLoader\(\n  \(\) => import\("\.\/CodeBlockHighlighter"\),\n  \(error\) => \{\n    HighlightedCode = lazy\(preloadCodeHighlighter\);\n    console\.error\(/);
  assert.match(source, /\nlet HighlightedCode = lazy\(preloadCodeHighlighter\);/);
  // The lazy view sits in a boundary whose fallback is the same plain code block.
  assert.match(source, /<ErrorBoundary scope="代码高亮" fallback=\{<PlainCode code=\{code\} \/>\}>\n\s+<Suspense fallback=\{<PlainCode code=\{code\} \/>\}>\n\s+<HighlightedCode code=\{code\} lang=\{lang\} \/>/);
  // A streaming block's early fetch must not leave an unhandled rejection behind.
  assert.match(source, /if \(isStreaming\) preloadCodeHighlighter\(\)\.catch\(\(\) => \{\}\);/);
});
