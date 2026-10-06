import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const panels = await jiti.import("./lazy-panels.tsx");
const source = (await readFile(new URL("./lazy-panels.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const chunkError = () => Object.assign(new Error("Loading chunk 4703 failed.\n(error: /_next/static/chunks/4703.js)"), { name: "ChunkLoadError" });

test("regression: a failed panel chunk is not cached; the lazy instance is replaced and the failure is logged with the panel name", async () => {
  // 旧实现：next/dynamic 内部的 React.lazy 永久记住拒绝，旧标签页（发版后 chunk 404）里这个面板之后永远打不开，且抛进渲染树整页白屏
  let calls = 0;
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const loader = panels.createPanelLoader("设置", async () => {
      calls += 1;
      if (calls === 1) throw chunkError();
      return function SettingsPanelStub() { return null; };
    });
    const before = loader.current();
    assert.equal(loader.current(), before, "the lazy instance is stable while nothing failed");
    await assert.rejects(loader.load(), /Loading chunk 4703 failed/);
    assert.notEqual(loader.current(), before, "React.lazy remembers a rejection forever, so a fresh instance replaces it");
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /\[pi-web\] 面板「设置」chunk 加载失败/);
    assert.equal(logged[0][1].name, "ChunkLoadError");
    const first = loader.load();
    assert.equal(loader.load(), first, "concurrent callers share the in-flight load");
    assert.equal(typeof (await first), "function");
    assert.equal(loader.load(), first, "a success stays cached");
    assert.equal(calls, 2);
  } finally { console.error = original; }
});

test("regression: every on-demand panel renders its skeleton on the server and before mount, without loading the chunk", () => {
  const dialog = renderToStaticMarkup(React.createElement(panels.SettingsPanel, { onClose() {} }));
  assert.match(dialog, /aria-busy="true"/);
  const topPanel = renderToStaticMarkup(React.createElement(panels.SystemPromptPanel, { loading: true, prompt: "", translate: (key) => key }));
  assert.match(topPanel, /aria-busy="true"/);
  for (const name of ["FileViewer", "TerminalPanel", "SettingsPanel", "ProjectTrustDialog", "DirectoryPicker", "BranchNavigator", "SystemPromptPanel", "ToolDefinitionsPanel", "AgentSessionPanel"]) {
    assert.equal(typeof panels[name], "function", `${name} stays exported under the same name`);
  }
});

test("regression: a failed dialog panel shows a closable alert card over the backdrop instead of a blank or blocked screen", () => {
  const closed = [];
  const failure = panels.dialogFailure({ width: 480, zIndex: 1000, dismiss: "onClose" });
  const view = failure({ onClose: () => closed.push("closed") }, { name: "设置", error: chunkError(), reset() {} });
  const html = renderToStaticMarkup(view);
  assert.match(html, /role="alert"/);
  assert.match(html, /设置显示出错/);
  assert.match(html, /刷新页面即可恢复/);
  assert.match(html, />重试</);
  assert.match(html, />关闭</);
  assert.match(html, />刷新页面</);
  assert.match(html, /z-index:1000/);
});

test("regression: a failed branch trigger becomes a small retry button in the top bar; with the inline trigger hidden it is a floating alert", () => {
  const inline = renderToStaticMarkup(panels.branchFailure({}, { name: "分支", error: chunkError(), reset() {} }));
  assert.match(inline, /<button type="button" class="pw-tb-btn"[^>]*aria-label="分支面板加载失败，点击重试"/);
  assert.doesNotMatch(inline, /role="alert"/);
  const hidden = renderToStaticMarkup(panels.branchFailure({ hideInlineButton: true, onToggle() {} }, { name: "分支", error: chunkError(), reset() {} }));
  assert.match(hidden, /role="alert"/);
  assert.match(hidden, /分支显示出错/);
  assert.match(hidden, />关闭</);
});

test("regression: all nine on-demand panels sit inside an ErrorBoundary with their own scope, retry rebuilds the lazy instance, and preloads never leave an unhandled rejection", () => {
  assert.doesNotMatch(source, /from "next\/dynamic"/, "next/dynamic caches a rejected chunk forever; panels use createPanelLoader instead");
  assert.match(source, /import \{ createRetryableLoader \} from "\.\/MermaidBlock";/);
  assert.match(source, /import \{ ErrorBanner, ErrorBoundary \} from "\.\/ErrorBoundary";/);
  for (const [exportName, scope] of [
    ["FileViewer", "文件查看器"], ["TerminalPanel", "终端"], ["SettingsPanel", "设置"], ["ProjectTrustDialog", "项目信任确认"],
    ["DirectoryPicker", "目录选择器"], ["BranchNavigator", "分支"], ["SystemPromptPanel", "系统提示词"], ["ToolDefinitionsPanel", "工具定义"],
    ["AgentSessionPanel", "子代理"],
  ]) {
    assert.match(source, new RegExp(`export const ${exportName} = guardedPanel\\("${scope}", `), `${exportName} is guarded as 「${scope}」`);
  }
  // 骨架、边界、客户端门都在 guardedPanel 里：失败 → 面板位置显示提示条，其余界面不受影响
  assert.match(source, /<ErrorBoundary scope=\{name\} fill=\{failure\.fill\} onReset=\{\(\) => setAttempt\(\(count\) => count \+ 1\)\} fallback=/);
  assert.match(source, /<ClientOnly fallback=\{<Loading \/>\}>\n\s+<Suspense fallback=\{<Loading \/>\}>/);
  assert.match(source, /export function preloadSettingsPanel\(\) \{\n  void settingsLoader\.load\(\)\.catch\(\(\) => \{\}\);\n\}/);
  assert.match(source, /export function preloadProjectTrustDialog\(\) \{\n  void trustLoader\.load\(\)\.catch\(\(\) => \{\}\);\n\}/);
});
