import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MARK,
  applyHideHiddenExtensionMessages,
} from "../tools/patch-piweb-hide-hidden-extension-messages.mjs";

const scriptPath = path.resolve(new URL("../tools/patch-piweb-hide-hidden-extension-messages.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function rendererFixture(messageId = "a") {
  return `let render=function({message:${messageId}}){return"user"===${messageId}.role?"USER":"toolResult"===${messageId}.role?null:"custom"===${messageId}.role?"compaction"===${messageId}.customType?"COMPACTION":"CUSTOM":"bashExecution"===${messageId}.role?"BASH":null};`;
}

function evaluateRenderer(source) {
  return Function(`${source};return render;`)();
}

for (const [label, fixture] of [["client", rendererFixture("a")], ["server", rendererFixture("z")]]) {
  test(`${label}: display:false custom messages render nothing while visible and normal messages remain`, () => {
    const result = applyHideHiddenExtensionMessages(fixture, label, { browserMark: label === "client" });
    const render = evaluateRenderer(result.out);

    assert.equal(result.applied, true);
    assert.match(result.out, new RegExp(MARK));
    assert.equal(render({ message: { role: "custom", customType: "lop-adversary", display: false } }), null);
    assert.equal(render({ message: { role: "custom", customType: "lop-chain", display: false } }), null);
    assert.equal(render({ message: { role: "custom", customType: "compaction", display: false } }), null);
    assert.equal(render({ message: { role: "custom", customType: "status", display: true } }), "CUSTOM");
    assert.equal(render({ message: { role: "custom", customType: "status" } }), "CUSTOM");
    assert.equal(render({ message: { role: "custom", customType: "compaction", display: true } }), "COMPACTION");
    assert.equal(render({ message: { role: "user" } }), "USER");
    assert.equal(render({ message: { role: "bashExecution" } }), "BASH");
  });
}

test("patch is idempotent and fails closed when the pi-web renderer anchor changes", () => {
  const once = applyHideHiddenExtensionMessages(rendererFixture(), "fixture", { browserMark: true });
  assert.equal(applyHideHiddenExtensionMessages(once.out, "fixture", { browserMark: true }).applied, false);
  assert.throws(() => applyHideHiddenExtensionMessages("no renderer anchor", "missing"), /锚点命中 0 次/);
  assert.throws(
    () => applyHideHiddenExtensionMessages(rendererFixture("a") + rendererFixture("b").replace("render", "render2"), "duplicate"),
    /锚点命中 2 次/,
  );
});

test("filesystem deployment is checkable, backup-first, cache-safe, and repeatable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piweb-hide-hidden-"));
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
  await writeFile(oldChunk, rendererFixture("a"));
  await writeFile(serverPage, `${rendererFixture("z")}/*${oldHash}*/`);
  await writeFile(manifest, `self.__RSC_MANIFEST={chunk:"static/chunks/app/page-${oldHash}.js"}`);

  const check = spawnSync(process.execPath, [scriptPath, "--check", "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, "check-ok");
  assert.equal(await readFile(oldChunk, "utf8"), rendererFixture("a"), "--check must not mutate the package");

  const apply = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  const summary = JSON.parse(apply.stdout);
  assert.equal(summary.status, "patched");
  assert.notEqual(summary.chunk.from, summary.chunk.to);
  const newChunk = path.join(chunkDir, summary.chunk.to);
  assert.match(await readFile(newChunk, "utf8"), new RegExp(MARK));
  assert.match(await readFile(serverPage, "utf8"), new RegExp(MARK));
  assert.match(await readFile(manifest, "utf8"), new RegExp(summary.chunk.to.replace(/^page-|\.js$/g, "")));
  assert.equal(await readFile(oldChunk, "utf8"), rendererFixture("a"), "old running-client chunk must remain untouched");
  await stat(path.join(backup, ".next", "static", "chunks", "app", `page-${oldHash}.js`));

  const rerun = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).status, "already-patched");
});

test("launcher and cloud release keep the patch and contract in the product path", async () => {
  const [launcher, workflow] = await Promise.all([
    readFile(new URL("../src/launcher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(launcher, /"patch-piweb-hide-hidden-extension-messages\.mjs"/);
  assert.match(workflow, /node --test tests\/patch-piweb-hide-hidden-extension-messages-contract\.mjs/);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-hide-hidden-extension-messages\.mjs stage\/tools\/patch-piweb-hide-hidden-extension-messages\.mjs/);
});
