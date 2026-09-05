#!/usr/bin/env node
// pi-web 0.8.11 本地补丁：把可见 worktree 当作互相隔离的会话分类。
//
// - 非 main 分类只显示 cwd 位于该 worktree（含子目录）的会话。
// - main 显示项目全集减去显式非 main 分类，因此 Claude/Codex 临时 worktree
//   的历史仍可达。
// - 真正切换分类时卸载旧聊天和旧文件页；点击 main 内未分类 worktree 的会话
//   仍正常打开，不会被 cwd 同步 effect 误关。
// - 选择器尾数显示当前分类的会话族数量，空分类明确显示 0。
//
// 用法: node patch-piweb-worktree-sessions.mjs [--pkg <包目录>] [--backup <备份目录>] [--check|--revert]
// 约束: 仅 0.8.11；client/server 所有锚点先完整校验，任一不符则零写入；
//       page chunk 换指纹名以避开 PWA 旧缓存；旧 chunk 保留。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "__pwWorktreeSessionIsolationV1";
export const PATCH_REVISION = "r1";

const IDENT = "[A-Za-z_$][\\w$]*";
const SIDEBAR_SCOPE_RE = new RegExp(
  `(${IDENT})=(${IDENT})\\?\\((${IDENT})=\\2\\.key,(${IDENT})\\.filter\\((${IDENT})=>(${IDENT})\\(\\5\\)===\\3\\)\\):\\4,`
    + `(${IDENT})=!!\\((${IDENT})\\?\\.isGit&&\\8\\.isTopLevel&&(${IDENT})&&\\2\\?\\.key===\\8\\.projectKey\\)`,
  "gu",
);
const APP_SWITCH_GUARD_RE = new RegExp(
  `if\\((${IDENT})===(${IDENT})&&(${IDENT})!==(${IDENT})\\|\\|\\3===\\4&&\\(null!==(${IDENT})\\|\\|\\1===\\2\\)\\)return;`
    + `let (${IDENT})="function"==typeof crypto\\.randomUUID`,
  "gu",
);

function only(matches, label) {
  if (matches.length !== 1) {
    throw new Error(`${label} anchor matched ${matches.length} times (expected 1); refusing write`);
  }
  return matches[0];
}

function countOf(source, needle) {
  return source.split(needle).length - 1;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Return the sessions belonging to the selected visible worktree category.
 * Main deliberately keeps uncategorized/agent-generated worktrees reachable.
 */
export function filterSessionsForWorktree(sessions, worktreeState, selectedCwd) {
  const source = Array.isArray(sessions) ? sessions : [];
  const worktrees = Array.isArray(worktreeState?.worktrees) ? worktreeState.worktrees : [];
  const pathKey = (value) => String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
  const selectedKey = pathKey(selectedCwd);
  if (!selectedKey || worktrees.length === 0) return source;

  let current = worktrees.find((worktree) => pathKey(worktree?.path) === selectedKey);
  if (!current && pathKey(worktreeState?.forCwd) === selectedKey && worktreeState?.currentWorktreePath) {
    const resolvedKey = pathKey(worktreeState.currentWorktreePath);
    current = worktrees.find((worktree) => pathKey(worktree?.path) === resolvedKey);
  }
  current ??= worktrees.find((worktree) => worktree?.isMain === true);
  const currentRoot = pathKey(current?.path);
  if (!currentRoot) return source;

  const isWithin = (candidate, root) => {
    const candidateKey = pathKey(candidate);
    const rootKey = pathKey(root);
    return Boolean(candidateKey && rootKey)
      && (candidateKey === rootKey || candidateKey.startsWith(`${rootKey}/`));
  };
  if (current?.isMain === true) {
    const categoryRoots = worktrees
      .filter((worktree) => worktree?.isMain !== true && pathKey(worktree?.path))
      .map((worktree) => worktree.path);
    return source.filter((session) => !categoryRoots.some((root) => isWithin(session?.cwd, root)));
  }
  return source.filter((session) => isWithin(session?.cwd, current.path));
}

export function applyWorktreeSessionIsolation(source, label = "bundle") {
  if (source.includes(MARK)) return { out: source, applied: false };
  if (source.includes("__pwWorktreeSessions") || source.includes("__pwBranchSessions")) {
    throw new Error(`${label}: reserved worktree patch identifiers already exist; refusing write`);
  }

  const scope = only([...source.matchAll(SIDEBAR_SCOPE_RE)], `${label}: sidebar session scope`);
  const [
    scopeText,
    projectSessions,
    selectedProject,
    projectKey,
    allSessions,
    sessionItem,
    workspaceKey,
    showSwitcher,
    worktreeState,
    selectedCwd,
  ] = scope;
  if (!scopeText || !projectSessions || !selectedProject || !projectKey || !allSessions
    || !sessionItem || !workspaceKey || !showSwitcher || !worktreeState || !selectedCwd) {
    throw new Error(`${label}: sidebar capture cross-check failed; refusing write`);
  }

  const afterScope = source.slice(scope.index + scope[0].length);
  const familyRe = new RegExp(`,(${IDENT})=(${IDENT})\\(${regexEscape(projectSessions)}\\);return`, "gu");
  const familyRelative = only([...afterScope.matchAll(familyRe)], `${label}: session family list`);
  const familyIndex = scope.index + scope[0].length + familyRelative.index;
  const familyList = familyRelative[1];
  const familyBuilder = familyRelative[2];

  const countRe = new RegExp(
    `${regexEscape(worktreeState)}\\.worktrees\\.length>1&&\\(0,(${IDENT})\\.jsx\\)\\("span",`
      + `\\{style:\\{flexShrink:0,color:"var\\(--text-dim\\)",fontSize:10\\},children:`
      + `${regexEscape(worktreeState)}\\.worktrees\\.length\\}\\)`,
    "gu",
  );
  const count = only([...source.matchAll(countRe)], `${label}: worktree selector count`);
  const jsx = count[1];

  const guard = only([...source.matchAll(APP_SWITCH_GUARD_RE)], `${label}: workspace switch guard`);
  const [
    guardText,
    currentFreshCwd,
    nextCwd,
    currentProject,
    nextProject,
    selectedSession,
    draftId,
  ] = guard;
  if (!guardText || !currentFreshCwd || !nextCwd || !currentProject || !nextProject || !selectedSession || !draftId) {
    throw new Error(`${label}: workspace guard capture cross-check failed; refusing write`);
  }

  const tabsRe = new RegExp(
    `${regexEscape(currentProject)}!==${regexEscape(nextProject)}&&\\(`
      + `(${IDENT})\\(\\[\\]\\),(${IDENT})\\(null\\),(${IDENT})\\(!1\\),(${IDENT})\\(${regexEscape(nextProject)}\\)\\),`
      + `(${IDENT})\\.replace\\("/",\\{scroll:!1\\}\\)`,
    "gu",
  );
  const tabs = only([...source.matchAll(tabsRe)], `${label}: workspace file reset`);
  const [, setFileTabs, setActiveFileTab, setRightPanel, restoreWorkspace, router] = tabs;
  if (tabs.index < guard.index || tabs.index - guard.index > 2500) {
    throw new Error(`${label}: workspace reset is outside the guarded callback; refusing write`);
  }

  const filterSource = filterSessionsForWorktree.toString();
  const scopedReplacement = scope[0]
    + `,__pwWorktreeSessions=${showSwitcher}?(${filterSource})(${projectSessions},${worktreeState},${selectedCwd}):${projectSessions}`
    + `/*${MARK}*/`;
  const familyReplacement = `,${familyList}=${familyBuilder}(__pwWorktreeSessions);return`;
  const countReplacement = `(0,${jsx}.jsx)("span",{"data-pw-worktree-session-count":${familyList}.length,`
    + `style:{flexShrink:0,color:"var(--text-dim)",fontSize:10},children:${familyList}.length})`;
  const guardReplacement = `if(${currentFreshCwd}===${nextCwd}||${selectedSession}?.cwd===${nextCwd})return;`
    + `let ${draftId}="function"==typeof crypto.randomUUID`;
  const tabsReplacement = `${setFileTabs}([]),${setActiveFileTab}(null),${setRightPanel}(!1),`
    + `${currentProject}!==${nextProject}&&${restoreWorkspace}(${nextProject}),${router}.replace("/",{scroll:!1})`;

  const edits = [
    { start: scope.index, end: scope.index + scope[0].length, text: scopedReplacement, name: "session-scope" },
    { start: familyIndex, end: familyIndex + familyRelative[0].length, text: familyReplacement, name: "session-families" },
    { start: count.index, end: count.index + count[0].length, text: countReplacement, name: "session-count" },
    { start: guard.index, end: guard.index + guard[0].length, text: guardReplacement, name: "switch-guard" },
    { start: tabs.index, end: tabs.index + tabs[0].length, text: tabsReplacement, name: "file-reset" },
  ].sort((left, right) => right.start - left.start);

  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) {
      throw new Error(`${label}: overlapping edits ${edits[index - 1].name}/${edits[index].name}; refusing write`);
    }
  }
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);

  if (countOf(out, MARK) !== 1
    || countOf(out, "data-pw-worktree-session-count") !== 1
    || !out.includes(`${selectedSession}?.cwd===${nextCwd}`)
    || out.includes(`${worktreeState}.worktrees.length>1&&(0,${jsx}.jsx)("span"`)
    || !out.includes(`${currentProject}!==${nextProject}&&${restoreWorkspace}(${nextProject})`)) {
    throw new Error(`${label}: post-patch invariant failed; refusing write`);
  }
  return {
    out,
    applied: true,
    idents: {
      projectSessions,
      selectedProject,
      allSessions,
      showSwitcher,
      worktreeState,
      selectedCwd,
      familyList,
      selectedSession,
      currentFreshCwd,
      nextCwd,
      currentProject,
      nextProject,
    },
  };
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ensureBackup(packageRoot, backupRoot, file) {
  const relative = path.relative(packageRoot, file);
  const destination = path.join(backupRoot, relative);
  if (fs.existsSync(destination)) {
    if (sha256File(destination) !== sha256File(file)) {
      throw new Error(`backup already exists with different bytes: ${destination}`);
    }
    return destination;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  if (sha256File(destination) !== sha256File(file)) {
    throw new Error(`backup verification failed: ${destination}`);
  }
  return destination;
}

function main() {
  const args = process.argv.slice(2);
  const argValue = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const check = args.includes("--check");
  const packageRoot = path.resolve(argValue(
    "--pkg",
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"),
  ));
  const portablePackage = packageRoot.toLowerCase().includes(`${path.sep}portable${path.sep}app${path.sep}`);
  const backupRoot = path.resolve(argValue(
    "--backup",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "pi-web",
      `backup-0.8.11-pre-worktree-session-isolation${portablePackage ? "" : "-global"}`,
    ),
  ));
  const die = (message) => {
    console.error(`[ABORT] ${message}`);
    process.exit(1);
  };

  const packageFile = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageFile)) die(`package directory missing: ${packageRoot}`);
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (packageJson.version !== "0.8.11") {
    die(`package version ${packageJson.version} != 0.8.11; refusing write`);
  }

  if (args.includes("--revert")) {
    if (!fs.existsSync(backupRoot)) die(`backup directory missing: ${backupRoot}`);
    const restored = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(source);
          continue;
        }
        const relative = path.relative(backupRoot, source);
        const target = path.join(packageRoot, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        if (sha256File(source) !== sha256File(target)) throw new Error(`restore verification failed: ${relative}`);
        restored.push(relative);
      }
    })(backupRoot);
    console.log(JSON.stringify({
      status: "reverted",
      pkg: packageRoot,
      restored,
      note: "new chunk remains as an unreferenced rollback-safe asset; restart pi-web",
    }, null, 1));
    return;
  }

  const manifest = path.join(packageRoot, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("page_client-reference-manifest.js missing");
  const hashes = [...new Set(
    [...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/gu)]
      .map((match) => match[1]),
  )];
  if (hashes.length !== 1) die(`page chunk reference parse failure: ${JSON.stringify(hashes)}`);
  const currentHash = hashes[0];
  if (currentHash.length < 8) die(`page chunk hash too short: ${currentHash}`);

  const chunkDirectory = path.join(packageRoot, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDirectory, `page-${currentHash}.js`);
  const serverPage = path.join(packageRoot, ".next", "server", "app", "page.js");
  if (!fs.existsSync(currentChunk) || !fs.existsSync(serverPage)) die("client or server page bundle missing");
  const clientSource = fs.readFileSync(currentChunk, "utf8");
  const serverSource = fs.readFileSync(serverPage, "utf8");
  const clientMarked = clientSource.includes(MARK);
  const serverMarked = serverSource.includes(MARK);
  if (clientMarked && serverMarked) {
    console.log(JSON.stringify({ status: "already-patched", pkg: packageRoot, chunk: path.basename(currentChunk) }));
    return;
  }
  if (clientMarked !== serverMarked) die("partial prior patch detected; revert from backup before retrying");

  let client;
  let server;
  try {
    client = applyWorktreeSessionIsolation(clientSource, "client");
    server = applyWorktreeSessionIsolation(serverSource, "server-page");
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const fingerprint = crypto.createHash("sha1")
    .update(currentHash).update(":")
    .update(PATCH_REVISION).update(":")
    .update(filterSessionsForWorktree.toString()).update(":")
    .update(applyWorktreeSessionIsolation.toString())
    .digest("hex");
  const nextHash = client.applied ? (`pwb${fingerprint}`).slice(0, currentHash.length) : currentHash;
  const nextChunk = path.join(chunkDirectory, `page-${nextHash}.js`);
  if (currentHash !== nextHash && fs.existsSync(nextChunk)) {
    const existing = fs.readFileSync(nextChunk, "utf8");
    if (existing !== client.out) die(`target chunk exists with different bytes: ${nextChunk}`);
  }

  const referenceEdits = [];
  if (currentHash !== nextHash) {
    const candidates = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(candidate);
        else candidates.push(candidate);
      }
    })(path.join(packageRoot, ".next", "server", "app"));
    for (const name of ["build-manifest.json", "app-build-manifest.json", "react-loadable-manifest.json"]) {
      const candidate = path.join(packageRoot, ".next", name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
    for (const file of candidates) {
      const source = path.resolve(file) === path.resolve(serverPage)
        ? server.out
        : fs.readFileSync(file, "utf8");
      const count = countOf(source, currentHash);
      if (count > 0) referenceEdits.push({ file, count, out: source.replaceAll(currentHash, nextHash) });
    }
    if (referenceEdits.reduce((sum, edit) => sum + edit.count, 0) < 1) {
      die("page chunk references missing; refusing rename");
    }
  }
  if (server.applied && !referenceEdits.some((edit) => path.resolve(edit.file) === path.resolve(serverPage))) {
    referenceEdits.push({ file: serverPage, count: 0, out: server.out });
  }

  const summary = {
    status: check ? "check-ok" : "patched",
    pkg: packageRoot,
    version: packageJson.version,
    chunk: {
      from: `page-${currentHash}.js`,
      to: `page-${nextHash}.js`,
      renamed: currentHash !== nextHash,
    },
    applied: { client: client.applied, serverPage: server.applied },
    behavior: {
      nonMainSessionScope: "selected-worktree-and-descendants",
      mainSessionScope: "project-minus-visible-non-main-categories",
      switchClosesChat: true,
      switchClosesFileTabs: true,
      badge: "current-session-family-count",
    },
    backup: backupRoot,
  };
  if (check) {
    console.log(JSON.stringify(summary, null, 1));
    return;
  }

  const backupTargets = new Set([currentChunk, serverPage, ...referenceEdits.map((edit) => edit.file)]);
  try {
    for (const file of backupTargets) ensureBackup(packageRoot, backupRoot, file);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  if (client.applied && !fs.existsSync(nextChunk)) fs.writeFileSync(nextChunk, client.out, { flag: "wx" });
  if (sha256File(nextChunk) !== crypto.createHash("sha256").update(client.out).digest("hex")) {
    die(`new client chunk verification failed: ${nextChunk}`);
  }
  for (const edit of referenceEdits) fs.writeFileSync(edit.file, edit.out);
  for (const edit of referenceEdits) {
    if (fs.readFileSync(edit.file, "utf8") !== edit.out) die(`reference write verification failed: ${edit.file}`);
  }
  console.log(JSON.stringify(summary, null, 1));
}

const realPathOf = (candidate) => {
  try { return fs.realpathSync(candidate); }
  catch { return path.resolve(candidate); }
};
if (
  process.argv[1]
  && realPathOf(process.argv[1]).toLowerCase() === realPathOf(fileURLToPath(import.meta.url)).toLowerCase()
) {
  main();
}
