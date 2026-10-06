import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TurnWrittenFiles } = await jiti.import("./TurnWrittenFiles.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(TurnWrittenFiles, props)));

test("labels the row, uses sans chips and shows the folder relative to the project", () => {
  const html = render({
    cwd: "C:\\Users\\team\\示例项目",
    files: [
      { filePath: "C:\\Users\\team\\示例项目\\next.config.ts" },
      { filePath: "C:\\Users\\team\\示例项目\\.tmp\\piweb-fast-deploy.mjs" },
      { filePath: "c:\\users\\team\\示例项目\\.tmp\\a\\b\\deep.ts" },
    ],
  });
  assert.match(html, /改动 3 个文件/);
  assert.match(html, /class="pw-chip"/);
  assert.doesNotMatch(html, /font-mono/);
  assert.match(html, /next\.config\.ts<\/span><\/button>/);
  assert.match(html, /<span class="pw-chip-sub">\.tmp<\/span>/);
  assert.match(html, /<span class="pw-chip-sub">\.tmp\/…\/b<\/span>/);
});

test("folds files past six into a +N button", () => {
  const files = Array.from({ length: 9 }, (_, index) => ({ filePath: `/repo/src/file-${index}.ts` }));
  const html = render({ cwd: "/repo", files });
  assert.equal((html.match(/class="pw-chip"/g) ?? []).length, 6);
  assert.match(html, />\+3<\/button>/);
});
