import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MARK,
  applyPiWebInteractions,
  formatAtMentions,
  getClipboardPastePlan,
  isAwayFromBottom,
  uploadClipboardFiles,
} from "../tools/patch-piweb-interactions.mjs";

const scriptPath = path.resolve(new URL("../tools/patch-piweb-interactions.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function clipboard({ files = [], text = "", includeItems = true } = {}) {
  return {
    items: includeItems
      ? files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }))
      : [],
    files,
    getData(type) { return type === "text/plain" || type === "text" ? text : ""; },
  };
}

function file(name, type = "", size = 12, extra = {}) {
  return { name, type, size, lastModified: 1, ...extra };
}

function fixtureBundle() {
  return [
    "function composer(){let X=\"\",H=\"C:/work\",eu=!0;",
    "useImperativeHandle(ref,()=>({insertText(e){let t=ez.current;if(!t)return void Q(t=>t+(t?\" \":\"\")+e);let n=t.selectionStart??t.value.length,r=t.selectionEnd??t.value.length,i=t.value.slice(0,n),o=t.value.slice(r),s=i.length>0&&!i.endsWith(\" \")?\" \":\"\",l=i+s+e+o;eX.current=l,Q(l),ev(null),requestAnimationFrame(()=>{t.focus()})}}));",
    "let tx=(0,i.useCallback)(()=>{},[]),tv=(0,i.useCallback)(e=>{let t=Array.from(e.clipboardData?.items??[]).filter(e=>e.type.startsWith(\"image/\"));t.length&&(e.preventDefault(),e1(t.map(e=>e.getAsFile()).filter(e=>null!==e)))},[e1]);",
    "(0,i.useEffect)(()=>{fetch(`/api/skills?cwd=${encodeURIComponent(H)}`)},[eu,H]);",
    "return(0,r.jsxs)(\"div\",{children:[(0,r.jsx)(nv,{error:u}),(0,r.jsx)(ny,{warnings:h}),body]})}",
    "function chat(){let td=(0,i.useCallback)(()=>{e2(e=>Math.max(e,2*B.length))},[B.length]),tc=eL&&0===B.length&&!_.isStreaming&&!e0,tu=!!_.streamingMessage?.content.length,tp=e?.cwd??o??void 0,tg=(0,i.useRef)(null),tf=(0,i.useRef)(null);",
    ";(0,i.useLayoutEffect)(()=>{let e=tf.current;if(!q||!e$)return;work()},[q]);",
    "return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsxs)(\"div\",{className:\"relative flex min-w-0 flex-1 overflow-hidden\",children:[(0,r.jsx)(\"div\",{ref:eP,className:\"min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]\",children:messages}),W?null:(0,r.jsx)(nR,{messages:B,streamingMessage:_.streamingMessage,scrollContainer:eP,messageRefs:ta,onRevealHistory:td})]}),input]})}",
  ].join("");
}

test("pure text remains a native browser paste", () => {
  const plan = getClipboardPastePlan(clipboard({ text: "hello world" }));
  assert.equal(plan.shouldPreventDefault, false);
  assert.equal(plan.text, "hello world");
  assert.deepEqual(plan.files, []);
});

test("Explorer image with an empty MIME type is recovered by extension without duplication", () => {
  const screenshot = file("screen.PNG");
  const plan = getClipboardPastePlan(clipboard({ files: [screenshot], text: "screen.PNG" }));
  assert.equal(plan.shouldPreventDefault, true);
  assert.equal(plan.files.length, 1, "items and files must not double-enumerate one clipboard file");
  assert.deepEqual(plan.images, [{ file: screenshot, mimeType: "image/png" }]);
  assert.equal(plan.text, "", "file-manager generated filename text must not be duplicated");
});

test("mixed clipboard preserves real text and routes a non-image file to upload", () => {
  const report = file("report.pdf", "application/pdf", 256);
  const plan = getClipboardPastePlan(clipboard({ files: [report], text: "请检查这份报告" }));
  assert.equal(plan.shouldPreventDefault, true);
  assert.equal(plan.text, "请检查这份报告");
  assert.deepEqual(plan.images, []);
  assert.deepEqual(plan.others, [report]);
  assert.deepEqual(plan.paths, []);
});

test("an exposed or textual absolute path is referenced directly instead of uploaded", () => {
  const direct = file("notes.txt", "text/plain", 20, { path: "C:\\Docs\\notes.txt" });
  const directPlan = getClipboardPastePlan(clipboard({ files: [direct], text: "C:\\Docs\\notes.txt" }));
  assert.deepEqual(directPlan.paths, ["C:/Docs/notes.txt"]);
  assert.deepEqual(directPlan.others, []);
  assert.equal(directPlan.text, "");

  const browserFile = file("brief.pdf", "application/pdf", 20);
  const uriPlan = getClipboardPastePlan(clipboard({ files: [browserFile], text: "file:///C:/My%20Docs/brief.pdf" }));
  assert.deepEqual(uriPlan.paths, ["C:/My Docs/brief.pdf"]);
  assert.deepEqual(uriPlan.others, []);
  assert.equal(uriPlan.text, "");
});

test("@ mentions normalize Windows paths and quote whitespace", () => {
  assert.equal(
    formatAtMentions(["C:\\My Docs\\brief.pdf", "src/main.ts"]),
    '@"C:/My Docs/brief.pdf" @src/main.ts',
  );
});

test("ordinary file upload never overwrites conflicts and returns inserted names", async () => {
  class FakeFormData {
    constructor() { this.rows = []; }
    append(key, value, name) { this.rows.push({ key, value, name }); }
  }
  const calls = [];
  const responses = [
    { status: 409, ok: false, json: async () => ({ conflicts: ["report.pdf"] }) },
    { status: 200, ok: true, json: async () => ({ uploaded: ["report.pasted-42-1.pdf"], errors: [] }) },
  ];
  const report = file("report.pdf", "application/pdf", 10);
  const result = await uploadClipboardFiles([report], "C:\\work space", {
    FormData: FakeFormData,
    now: () => 42,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });
  assert.deepEqual(result, { uploaded: ["report.pasted-42-1.pdf"], errors: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/files/C%3A/work%20space?type=upload&conflict=error");
  assert.deepEqual(calls[0].init.body.rows.map((row) => row.name), ["report.pdf"]);
  assert.deepEqual(calls[1].init.body.rows.map((row) => row.name), ["report.pasted-42-1.pdf"]);
  assert.ok(calls.every((call) => call.url.includes("conflict=error")), "overwrite mode must never be used");
});

test("ordinary file upload enforces the server size contract before network I/O", async () => {
  let fetched = false;
  await assert.rejects(
    uploadClipboardFiles([file("huge.bin", "application/octet-stream", 25 * 1024 * 1024 + 1)], "C:/work", {
      fetch: async () => { fetched = true; },
    }),
    /25 MB/,
  );
  assert.equal(fetched, false);
});

test("scroll-bottom visibility uses the same eight-pixel tail tolerance", () => {
  assert.equal(isAwayFromBottom(91, 100, 200), true);
  assert.equal(isAwayFromBottom(92, 100, 200), false);
  assert.equal(isAwayFromBottom(100, 100, 200), false);
});

test("bundle patch installs both behaviors atomically and is idempotent", () => {
  const source = fixtureBundle();
  const patched = applyPiWebInteractions(source, "fixture");
  assert.equal(patched.applied, true);
  assert.match(patched.out, new RegExp(MARK));
  assert.match(patched.out, /pwPayload\.shouldPreventDefault/);
  assert.match(patched.out, /if\(!pwPayload\.shouldPreventDefault\)return/);
  assert.match(patched.out, /\/api\/files\//);
  assert.match(patched.out, /pwPayload\.text&&pwPasteInsert/);
  assert.match(patched.out, /"data-pw-scroll-bottom":"true"/);
  assert.match(patched.out, /e\.addEventListener\("scroll"/);
  assert.match(patched.out, /\[tc,B\.length,eP,pwScrollCheck\]/, "listener must attach after an initially loading session receives messages");
  assert.match(patched.out, /pwScrollAway\(e\.scrollTop,e\.clientHeight,e\.scrollHeight\)/);
  assert.doesNotMatch(patched.out, /clipboardData\?\.items\?\?\[\]\)\.filter\(e=>e\.type\.startsWith\("image\/"\)\)/);

  const again = applyPiWebInteractions(patched.out, "fixture-patched");
  assert.equal(again.applied, false);
  assert.equal(again.out, patched.out);
});

test("an anchor mismatch aborts before producing a partial bundle", () => {
  const source = fixtureBundle().replace("dataTransfer-does-not-exist", "unused");
  assert.throws(
    () => applyPiWebInteractions(source.replace("onRevealHistory:td", "onRevealHistory:missing"), "broken"),
    /交叉校验失败|锚点命中/,
  );
});

test("CLI check is read-only, apply rotates the chunk URL, and rerun is idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piweb-interactions-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chunkDir = path.join(root, ".next", "static", "chunks", "app");
  const serverDir = path.join(root, ".next", "server", "app");
  await mkdir(chunkDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.8.11" }));
  const oldHash = "aaaaaaaaaaaaaaaa";
  const oldChunk = path.join(chunkDir, `page-${oldHash}.js`);
  const manifest = path.join(serverDir, "page_client-reference-manifest.js");
  await writeFile(oldChunk, fixtureBundle());
  await writeFile(manifest, `self.__RSC_MANIFEST={chunk:"static/chunks/app/page-${oldHash}.js"}`);
  const beforeManifest = await readFile(manifest, "utf8");

  const check = spawnSync(process.execPath, [scriptPath, "--check", "--pkg", root], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const checkSummary = JSON.parse(check.stdout);
  assert.equal(checkSummary.status, "check-ok");
  assert.equal(await readFile(manifest, "utf8"), beforeManifest);
  await assert.rejects(stat(path.join(chunkDir, checkSummary.chunk.to)), /ENOENT/);

  const backup = path.join(root, "backup");
  const apply = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  const summary = JSON.parse(apply.stdout);
  assert.equal(summary.status, "patched");
  const newChunk = path.join(chunkDir, summary.chunk.to);
  assert.match(await readFile(newChunk, "utf8"), new RegExp(MARK));
  assert.match(await readFile(manifest, "utf8"), new RegExp(summary.chunk.to.replace(/^page-|\.js$/g, "")));
  assert.equal(await readFile(oldChunk, "utf8"), fixtureBundle(), "old running-client chunk must remain untouched");
  await stat(path.join(backup, ".next", "static", "chunks", "app", `page-${oldHash}.js`));

  const rerun = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).status, "already-patched");
});

test("launcher, CI contract suite, and release stage all carry the patch", async () => {
  const [launcher, workflow] = await Promise.all([
    readFile(new URL("../src/launcher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(launcher, /"patch-piweb-interactions\.mjs"/);
  assert.match(workflow, /node --test tests\/patch-piweb-interactions-contract\.mjs/);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-interactions\.mjs stage\/tools\/patch-piweb-interactions\.mjs/);
});
