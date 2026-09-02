import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MARK,
  applyShowThinking,
  localizeVisibleThinkingSummary,
} from "../tools/patch-piweb-show-thinking.mjs";

const scriptPath = path.resolve(new URL("../tools/patch-piweb-show-thinking.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function thinkingFixture({ server = false, hidden = true } = {}) {
  const fn = hidden
    ? `function ef(e,t={}){return"thinking"===e.type}${server ? "/*__pwHideThinkingV1*/" : "typeof window<\"u\"&&(window.__pwHideThinkingV1=!0);"}`
    : `function ef(e,t={}){return"thinking"===e.type&&!e.deferred&&!t.isStreaming&&""===e.thinking.trim()}`;
  return `${fn}function tx({block:e,duration:t}){let{t:l}=i18n(),[a,d]=(0,r.useState)(!1),[c,u]=(0,r.useState)(null),[h,p]=(0,r.useState)(!1),[g,f]=(0,r.useState)(null),m=()=>l("i18n.thinkingUnavailable");return a?l("i18n.loadingThinking"):g??(e.deferred?c:e.thinking)}`;
}

function hiddenPredicate(source) {
  const start = source.indexOf("function ef");
  const end = source.indexOf("function tx", start);
  return Function(`${source.slice(start, end).replace(/typeof window[^;]+;/u, "").replace(/\/\*[^*]+\*\//gu, "")};return ef;`)();
}

for (const server of [false, true]) {
  test(`${server ? "server" : "client"}: restores non-empty thinking and opens live cards without breaking deferred loading`, () => {
    const result = applyShowThinking(thinkingFixture({ server }), server ? "server" : "client", { browserMark: !server });
    const hidden = hiddenPredicate(result.out);

    assert.equal(result.applied, true);
    assert.match(result.out, new RegExp(MARK));
    assert.doesNotMatch(result.out, /__pwHideThinkingV1/u);
    assert.equal(hidden({ type: "thinking", thinking: "中文推理摘要", deferred: false }, { isStreaming: true }), false);
    assert.equal(hidden({ type: "thinking", thinking: "中文推理摘要", deferred: false }, { isStreaming: false }), false);
    assert.equal(hidden({ type: "thinking", thinking: "", deferred: false }, { isStreaming: true }), false);
    assert.equal(hidden({ type: "thinking", thinking: "", deferred: false }, { isStreaming: false }), true);
    assert.equal(hidden({ type: "text", text: "answer" }, { isStreaming: false }), false);
    assert.match(result.out, /\[a,d\]=\(0,r\.useState\)\(!e\.deferred\)/u, "live thinking opens while deferred history still triggers click-to-load");
    assert.match(result.out, /\[h,p\]=\(0,r\.useState\)\(!1\)/u, "loading state must remain unchanged");
    assert.match(result.out, /__pwLocalizeVisibleThinkingSummary\(e\.deferred\?c:e\.thinking\)/u);
    assert.match(result.out, /正在验证修改结果/u);
  });
}

test("English-only upstream stage headings become accurate Chinese status while Chinese text is preserved", () => {
  assert.equal(localizeVisibleThinkingSummary("**Planning robust live verification**"), "正在规划当前任务…");
  assert.equal(localizeVisibleThinkingSummary("**Investigating a stale runtime**"), "正在定位问题原因…");
  assert.equal(localizeVisibleThinkingSummary("**Verifying the current UI**"), "正在验证修改结果…");
  assert.equal(localizeVisibleThinkingSummary("An uncategorized reasoning stage"), "正在深入分析当前任务…");
  assert.equal(localizeVisibleThinkingSummary("正在核对当前界面"), "正在核对当前界面");
});

test("also upgrades pristine pi-web, is idempotent, and fails closed on changed anchors", () => {
  const pristine = applyShowThinking(thinkingFixture({ hidden: false }), "pristine", { browserMark: true });
  assert.equal(pristine.applied, true);
  assert.equal(applyShowThinking(pristine.out, "again", { browserMark: true }).applied, false);
  assert.throws(() => applyShowThinking("no thinking renderer", "missing"), /thinking visibility anchor/u);
});

test("filesystem deployment is backup-first, cache-safe, and repeatable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piweb-show-thinking-"));
  const chunkDir = path.join(root, ".next", "static", "chunks", "app");
  const serverDir = path.join(root, ".next", "server", "app");
  const backup = path.join(root, "backup");
  const oldHash = "aaaaaaaaaaaaaaaa";
  const oldChunk = path.join(chunkDir, `page-${oldHash}.js`);
  const serverPage = path.join(serverDir, "page.js");
  const manifest = path.join(serverDir, "page_client-reference-manifest.js");
  await mkdir(chunkDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.8.11" }));
  await writeFile(oldChunk, thinkingFixture());
  await writeFile(serverPage, `${thinkingFixture({ server: true })}/*${oldHash}*/`);
  await writeFile(manifest, `self.__RSC_MANIFEST={chunk:"static/chunks/app/page-${oldHash}.js"}`);

  const apply = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  const summary = JSON.parse(apply.stdout);
  assert.equal(summary.status, "patched");
  const newChunk = path.join(chunkDir, summary.chunk.to);
  assert.match(await readFile(newChunk, "utf8"), new RegExp(MARK));
  assert.match(await readFile(serverPage, "utf8"), new RegExp(MARK));
  assert.match(await readFile(manifest, "utf8"), new RegExp(summary.chunk.to.replace(/^page-|\.js$/g, "")));
  assert.equal(await readFile(oldChunk, "utf8"), thinkingFixture(), "old running-client chunk must remain untouched");
  await stat(path.join(backup, ".next", "static", "chunks", "app", `page-${oldHash}.js`));

  const rerun = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).status, "already-patched");
});

test("launcher and cloud release use show-thinking instead of the retired hide-thinking patch", async () => {
  const [launcher, workflow] = await Promise.all([
    readFile(new URL("../src/launcher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  const chain = launcher.match(/for \(const patchName of \[(.*?)\]\)/su)?.[1] ?? "";
  assert.match(chain, /"patch-piweb-show-thinking\.mjs"/u);
  assert.doesNotMatch(chain, /"patch-piweb-hide-thinking\.mjs"/u);
  assert.match(workflow, /node --test tests\/patch-piweb-show-thinking-contract\.mjs/u);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-show-thinking\.mjs stage\/tools\/patch-piweb-show-thinking\.mjs/u);
});
