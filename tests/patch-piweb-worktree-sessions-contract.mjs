import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MARK,
  applyWorktreeSessionIsolation,
  filterSessionsForWorktree,
} from "../tools/patch-piweb-worktree-sessions.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), "..");
const script = path.join(root, "tools", "patch-piweb-worktree-sessions.mjs");

const projectRoot = "C:\\Users\\lop\\Documents\\claude";
const historyRoot = "C:\\Users\\lop\\Documents\\claude-worktrees\\历史对话";
const featureRoot = "C:\\Users\\lop\\Documents\\claude-worktrees\\pi-web优化";
const emptyRoot = "C:\\Users\\lop\\Documents\\claude-worktrees\\空分类";
const generatedRoot = "C:\\Users\\lop\\Documents\\claude\\.claude\\worktrees\\generated-123";
const visibleWorktrees = [
  { path: projectRoot, branch: "main", isMain: true },
  { path: historyRoot, branch: "历史对话", isMain: false },
  { path: featureRoot, branch: "pi-web优化", isMain: false },
  { path: emptyRoot, branch: "空分类", isMain: false },
];
const sessions = [
  { id: "main", cwd: projectRoot },
  { id: "main-child", cwd: `${projectRoot}\\运维` },
  { id: "generated", cwd: generatedRoot },
  { id: "history", cwd: historyRoot },
  { id: "history-child", cwd: `${historyRoot}\\notes` },
  { id: "feature", cwd: featureRoot.toLowerCase().replaceAll("\\", "/") + "/" },
  { id: "prefix-collision", cwd: `${featureRoot}-old` },
];

function state(currentWorktreePath, forCwd = currentWorktreePath) {
  return { forCwd, currentWorktreePath, worktrees: visibleWorktrees };
}

function ids(items) {
  return items.map((item) => item.id);
}

function pageFixture() {
  return [
    "function sidebar(){let bi=bf?(s=bf.key,u.filter(a=>at(a)===s)):u,bj=!!(V?.isGit&&V.isTopLevel&&A&&bf?.key===V.projectKey),bk=0,bn=an(bi);return 0;}",
    "V.worktrees.length>1&&(0,aj.jsx)(\"span\",{style:{flexShrink:0,color:\"var(--text-dim)\",fontSize:10},children:V.worktrees.length});",
    "function switchWorkspace(a,b,c){bP();let d=R??bI;if(bJ(a),!a)return;let e=c??b??a,f=bK.current??(G?at(G):null);if(bK.current=e,bN.current){bN.current=!1;return}if(d===a&&f!==e||f===e&&(null!==G||d===a))return;let g=\"function\"==typeof crypto.randomUUID?crypto.randomUUID():\"draft\";H(null),f!==e&&(bA([]),bC(null),aB(!1),bQ(e)),n.replace(\"/\",{scroll:!1})}",
  ].join("");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createPackage({ badServer = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-worktree-sessions-"));
  const pkg = path.join(temp, "pkg");
  const backup = path.join(temp, "backup");
  const hash = "aaaaaaaaaaaaaaaa";
  const clientRel = `.next/static/chunks/app/page-${hash}.js`;
  const serverRel = ".next/server/app/page.js";
  const manifestRel = ".next/server/app/page_client-reference-manifest.js";
  for (const relative of [clientRel, serverRel, manifestRel]) {
    fs.mkdirSync(path.dirname(path.join(pkg, relative)), { recursive: true });
  }
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.8.11" }));
  fs.writeFileSync(path.join(pkg, clientRel), pageFixture());
  fs.writeFileSync(path.join(pkg, serverRel), `${badServer ? "drift" : pageFixture()}/*${hash}*/`);
  fs.writeFileSync(path.join(pkg, manifestRel), `self.__RSC_MANIFEST={chunk:\"static/chunks/app/page-${hash}.js\"}`);
  return { temp, pkg, backup, hash, clientRel, serverRel, manifestRel };
}

test("non-main categories contain only their own worktree and descendants", () => {
  assert.deepEqual(
    ids(filterSessionsForWorktree(sessions, state(historyRoot), historyRoot)),
    ["history", "history-child"],
  );
  assert.deepEqual(
    ids(filterSessionsForWorktree(sessions, state(featureRoot), featureRoot.toUpperCase().replaceAll("\\", "/"))),
    ["feature"],
  );
  assert.deepEqual(
    ids(filterSessionsForWorktree(sessions, state(emptyRoot), emptyRoot)),
    [],
    "a newly-created category with no sessions must be exactly empty",
  );
});

test("main keeps uncategorized agent worktrees while excluding visible categories", () => {
  assert.deepEqual(
    ids(filterSessionsForWorktree(sessions, state(projectRoot), projectRoot)),
    ["main", "main-child", "generated", "prefix-collision"],
  );
  assert.deepEqual(
    ids(filterSessionsForWorktree(
      sessions,
      state(projectRoot, generatedRoot),
      generatedRoot,
    )),
    ["main", "main-child", "generated", "prefix-collision"],
    "a hidden active checkout resolves to main without losing its session",
  );
});

test("malformed or unavailable worktree state fails open", () => {
  assert.equal(filterSessionsForWorktree(sessions, null, projectRoot), sessions);
  assert.equal(filterSessionsForWorktree(sessions, { worktrees: [] }, projectRoot), sessions);
});

test("bundle transform scopes families, resets real switches, and shows a zero-capable count", () => {
  const result = applyWorktreeSessionIsolation(pageFixture(), "fixture");
  assert.equal(result.applied, true);
  assert.match(result.out, new RegExp(MARK, "u"));
  assert.match(result.out, /__pwWorktreeSessions=bj\?\(function filterSessionsForWorktree/u);
  assert.match(result.out, /bn=an\(__pwWorktreeSessions\)/u);
  assert.match(result.out, /"data-pw-worktree-session-count":bn\.length/u);
  assert.doesNotMatch(result.out, /children:V\.worktrees\.length/u);
  assert.match(result.out, /if\(d===a\|\|G\?\.cwd===a\)return/u, "session-selection cwd sync remains open");
  assert.match(result.out, /bA\(\[\]\),bC\(null\),aB\(!1\),f!==e&&bQ\(e\),n\.replace/u, "file tabs close for same-project category switches");
  assert.equal(applyWorktreeSessionIsolation(result.out, "again").applied, false);
});

test("bundle transform rejects missing or ambiguous anchors before returning output", () => {
  assert.throws(() => applyWorktreeSessionIsolation("unrelated", "missing"), /anchor matched 0|refusing write/u);
  assert.throws(() => applyWorktreeSessionIsolation(pageFixture() + pageFixture(), "duplicate"), /anchor matched 2|refusing write/u);
});

test("CLI check is read-only; apply is backup-first, cache-safe, and repeatable", () => {
  const fixture = createPackage();
  const tracked = [fixture.clientRel, fixture.serverRel, fixture.manifestRel].map((relative) => path.join(fixture.pkg, relative));
  const before = tracked.map(sha256);

  const check = spawnSync(process.execPath, [script, "--check", "--pkg", fixture.pkg, "--backup", fixture.backup], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(JSON.parse(check.stdout).status, "check-ok");
  assert.deepEqual(tracked.map(sha256), before);
  assert.equal(fs.existsSync(fixture.backup), false, "--check must not create a backup or write files");

  const apply = spawnSync(process.execPath, [script, "--pkg", fixture.pkg, "--backup", fixture.backup], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  const summary = JSON.parse(apply.stdout);
  assert.equal(summary.status, "patched");
  assert.equal(summary.chunk.renamed, true);
  assert.notEqual(summary.chunk.from, summary.chunk.to);
  const newChunk = path.join(fixture.pkg, ".next", "static", "chunks", "app", summary.chunk.to);
  assert.match(fs.readFileSync(newChunk, "utf8"), new RegExp(MARK, "u"));
  assert.match(fs.readFileSync(path.join(fixture.pkg, fixture.serverRel), "utf8"), new RegExp(MARK, "u"));
  assert.match(
    fs.readFileSync(path.join(fixture.pkg, fixture.manifestRel), "utf8"),
    new RegExp(summary.chunk.to.replace(/^page-|\.js$/gu, ""), "u"),
  );
  assert.deepEqual(sha256(path.join(fixture.pkg, fixture.clientRel)), before[0], "old chunk remains byte-identical");
  for (const relative of tracked.map((file) => path.relative(fixture.pkg, file))) {
    assert.equal(fs.existsSync(path.join(fixture.backup, relative)), true, `backup missing: ${relative}`);
  }

  const again = spawnSync(process.execPath, [script, "--pkg", fixture.pkg, "--backup", fixture.backup], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(again.status, 0, again.stderr || again.stdout);
  assert.equal(JSON.parse(again.stdout).status, "already-patched");
});

test("CLI anchor drift leaves package and backup untouched", () => {
  const fixture = createPackage({ badServer: true });
  const tracked = [fixture.clientRel, fixture.serverRel, fixture.manifestRel].map((relative) => path.join(fixture.pkg, relative));
  const before = tracked.map(sha256);
  const result = spawnSync(process.execPath, [script, "--pkg", fixture.pkg, "--backup", fixture.backup], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server-page: sidebar session scope anchor matched 0/u);
  assert.deepEqual(tracked.map(sha256), before);
  assert.equal(fs.existsSync(fixture.backup), false);
});

test("launcher and release keep the worktree patch before conversation nodes", () => {
  const launcher = fs.readFileSync(path.join(root, "src", "launcher.mjs"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const chain = launcher.match(/for \(const patchName of \[(.*?)\]\)/su)?.[1] ?? "";
  const worktreeIndex = chain.indexOf('"patch-piweb-worktree-sessions.mjs"');
  const nodesIndex = chain.indexOf('"patch-piweb-conversation-nodes.mjs"');
  assert.ok(worktreeIndex >= 0, "launcher patch chain is missing worktree session isolation");
  assert.ok(nodesIndex > worktreeIndex, "conversation nodes must remain the final patch");
  assert.match(workflow, /node --test tests\/patch-piweb-worktree-sessions-contract\.mjs/u);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-worktree-sessions\.mjs stage\/tools\/patch-piweb-worktree-sessions\.mjs/u);
  assert.match(workflow, /pi-web worktree-sessions patch missing/u);
});
