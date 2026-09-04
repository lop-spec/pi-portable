#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");
const supervisorSource = fs.readFileSync(path.join(root, "src", "run-supervisor.mjs"), "utf8");

test("archive action is a one-click operation with no confirmation state", () => {
  assert.match(source, /function enableImmediateActions\(\)/u);
  assert.match(source, /closest\("button\[data-pi-session-archive-action\]"\)/u);
  assert.match(source, /event\.preventDefault\(\)/u);
  assert.match(source, /event\.stopImmediatePropagation\(\)/u);
  assert.match(source, /shiftKey:\s*true/u, "the native destructive action must be invoked through its existing no-confirmation path");
  assert.match(source, /document\.addEventListener\("pointerdown", immediateActionClick, true\)/u, "a physical press must be captured before the parent row can replace the button");
  assert.match(source, /document\.addEventListener\("click", immediateActionClick, true\)/u, "keyboard activation must remain supported");
  assert.match(source, /function sessionIdFromRow\(row\)/u);
  assert.match(source, /performDirectAction\(pending, sessionId\)/u, "the normal path must not wait for the native delete callback and its page navigation");
  assert.match(source, /pending\.wasSelected.*pending\.nextRow\?\.isConnected.*pending\.nextRow\.click\(\)/u, "archiving the selected row must hand off to an adjacent conversation instead of leaving stale content");
  assert.match(source, /nativeFetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/\$\{action\}`/u);
  assert.match(source, /forwardedActionEvents\.add\(forwarded\)/u, "the guarded native fallback must remain deduplicated");
  assert.doesNotMatch(source, /button\.innerHTML/u, "decorating a React-owned action must not replace its children and break reconciliation");
  assert.doesNotMatch(source, /refresh\.parentElement\.insertBefore/u, "the archive-view control must not become a React-managed sibling");
  assert.doesNotMatch(source, /element\.textContent\s*=/u, "archive decoration must not replace React-owned text nodes");
  assert.match(source, /document\.documentElement\.appendChild\(host\)/u);
  assert.match(source, /function nativeNewSessionButton\(\)/u);
  assert.match(source, /betweenGap\s*>=\s*controlWidth/u, "archive control must choose a measured free gap instead of overlaying native controls");
  assert.match(source, /function beginOptimisticAction\(button\)/u);
  assert.match(source, /row\.animate\(/u, "the removed row height and opacity must animate together so following rows do not jump");
  assert.match(source, /cubic-bezier\(\.4, 0, \.2, 1\)/u);
  assert.match(source, /restoreOptimisticAction\(pendingAction\)/u, "a failed request must restore the optimistic row");
  assert.match(source, /actionArchive:\s*"Archive"/u);
  assert.match(source, /actionArchive:\s*"归档"/u);
  assert.doesNotMatch(source, /actionArchive:\s*"[^"]*Shift|actionArchive:\s*"[^"]*按住/u, "the visible action must not advertise a second interaction");
  assert.doesNotMatch(source, /decorateConfirmations\(\)/u, "archive UI must never enter a confirmation state");
});

test("archive request failures are visible and logged", () => {
  assert.match(source, /console\.error\("\[pi-web archive\]"/u);
  assert.match(source, /showError\(message\)/u);
  assert.match(source, /catch \(error\)/u, "network-level failures must not stay silent");
});

test("the supervisor refreshes archive UI source and logs every mutation failure", () => {
  assert.match(supervisorSource, /fs\.readFileSync\(PIWEB_ARCHIVE_UI_FILE, "utf8"\)/u);
  assert.match(supervisorSource, /piweb-archive-ui-reloaded/u);
  assert.match(supervisorSource, /piweb-archive-ui-reload-failed/u, "reload failures must never be silent");
  assert.match(supervisorSource, /session-archive-request/u);
  assert.match(supervisorSource, /Array\.isArray\(body\.runningSessionIds\).*this\.runningIds = new Set/u, "the rendered list must refresh the local running-session snapshot");
  assert.match(supervisorSource, /runningSessionsForArchive\(maxWaitMs = 120\)/u, "archive may probe fresh running state only behind a hard interactive timeout");
  assert.match(supervisorSource, /session-archive-running-cache/u, "running-state probe fallback must be logged");
  assert.match(supervisorSource, /session-archive-failed/u);
  assert.match(supervisorSource, /session-archive-rejected/u);
});
