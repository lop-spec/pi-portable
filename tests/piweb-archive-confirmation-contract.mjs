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
  assert.match(source, /document\.addEventListener\("click", immediateActionClick, true\)/u);
  assert.match(source, /function beginOptimisticAction\(button\)/u);
  assert.match(source, /opacity 120ms ease/u, "the row should leave immediately instead of waiting for a full rescan");
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

test("the supervisor refreshes archive UI source without a process restart", () => {
  assert.match(supervisorSource, /fs\.readFileSync\(PIWEB_ARCHIVE_UI_FILE, "utf8"\)/u);
  assert.match(supervisorSource, /piweb-archive-ui-reloaded/u);
  assert.match(supervisorSource, /piweb-archive-ui-reload-failed/u, "reload failures must never be silent");
});
