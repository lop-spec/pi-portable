#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "./piweb-archive-virtual-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");
const proxySource = fs.readFileSync(path.join(root, "src", "piweb-ui-proxy.mjs"), "utf8");

test("archive action is a one-click operation with no confirmation state", () => {
  const immediateSource = source.slice(source.indexOf("function immediateActionClick"), source.indexOf("function enableImmediateActions"));
  assert.match(source, /function enableImmediateActions\(\)/u);
  assert.match(source, /closest\("button\[data-pi-session-archive-action\]"\)/u);
  assert.match(source, /event\.preventDefault\(\)/u);
  assert.match(source, /event\.stopImmediatePropagation\(\)/u);
  assert.match(source, /shiftKey:\s*true/u, "the native destructive action must be invoked through its existing no-confirmation path");
  assert.match(source, /document\.addEventListener\("pointerdown", immediateActionClick, true\)/u, "a physical press must be captured before the parent row can replace the button");
  assert.match(source, /document\.addEventListener\("click", immediateActionClick, true\)/u, "keyboard activation must remain supported");
  assert.match(source, /function sessionIdFromRow\(row\)/u);
  assert.match(source, /performDirectAction\(pending, sessionId\)/u, "the normal path must not wait for the native delete callback and its page navigation");
  assert.match(source, /function handOffSelectedConversation\(pending\)[\s\S]*nextRow\.click\(\)/u, "archiving the selected row must hand off to an adjacent conversation instead of leaving stale content");
  assert.ok(immediateSource.indexOf("handOffSelectedConversation(pending)") < immediateSource.indexOf("void performDirectAction"), "selected-session handoff must happen before waiting for the archive request");
  assert.match(source, /data-pi-session-archive-handoff='true'/u, "the adjacent row must show the new selection in the same frame as the pointer press");
  assert.match(source, /history\.replaceState\(history\.state, "", `\$\{nextUrl\.pathname\}/u, "the adjacent route must update immediately without waiting for Next.js navigation");
  assert.match(source, /if \(pending\.handedOff\) scheduleHandoffRefresh\(\)/u, "list refresh must be scheduled after starting the selected-session handoff");
  assert.match(source, /adjacent session id unavailable for immediate route handoff/u, "a missing adjacent route id must never fail silently");
  assert.match(source, /pending\.handedOff.*queueMicrotask\(\(\) => pending\.row\?\.click\(\)\)/u, "a rejected optimistic archive must return to the original selected conversation");
  assert.match(source, /nativeFetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/\$\{action\}`/u);
  assert.match(source, /forwardedActionEvents\.add\(forwarded\)/u, "the guarded native fallback must remain deduplicated");
  assert.doesNotMatch(source, /button\.innerHTML/u, "decorating a React-owned action must not replace its children and break reconciliation");
  // No per-row shortcut (lop 2026-09-15, 4c3c575): the row ⋯ menu dispatches pi-web:archive-session,
  // which reuses the same one-click optimistic path; leftovers from older builds are removed from the slot.
  assert.match(source, /window\.addEventListener\('pi-web:archive-session'/u, "the row menu is the archive entry");
  assert.match(source, /\[data-pi-session-row\] \[data-pi-row-slot\] > \[data-pi-session-archive-action\]"\)\) action\.remove\(\)/u);
  assert.doesNotMatch(source, /slot\.appendChild\(action\)/u, "rows are not decorated with an archive shortcut");
  assert.doesNotMatch(source, /\[data-pi-session-archive-action\][^{]*\{display:none/u, "no display:none rules that would hide keyboard-reachable actions");
  assert.doesNotMatch(source, /oldDeleteTitles|style\.height === "54px"/u, "rows are recognised by data-pi-session-row only");
  assert.doesNotMatch(source, /refresh\.parentElement\.insertBefore/u, "the archive-view control must not become a React-managed sibling");
  assert.doesNotMatch(source, /element\.textContent\s*=/u, "archive decoration must not replace React-owned text nodes");
  assert.doesNotMatch(source, /document\.documentElement\.(appendChild|append)\(/u, "no injected control hangs off <html>: DOM order must match visual order");
  assert.match(source, /register\(\{ name: "archive", slot: "archive"/u, "the list-head control is appended into [data-pi-archive-slot]");
  assert.match(source, /className = "pw-btn pw-btn--ghost pw-btn--sm"/u);
  assert.match(source, /archivedConversations: \(count\) => `\$\{count\} 个对话`/u, "the archived view reads 「N 个对话 · 返回」");
  assert.match(source, /slot-missing-\$\{name\}/u, "a missing slot falls back to a fixed host and is logged");
  assert.match(source, /function beginOptimisticAction\(button, explicitRow = null\)/u);
  assert.match(source, /const row = explicitRow \|\| sessionRow\(button\)/u, 'context actions and standalone buttons must share the same optimistic implementation');
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

test("the UI proxy refreshes archive source and logs every mutation failure", () => {
  assert.match(proxySource, /fs\.promises\.readFile\(PIWEB_ARCHIVE_UI_FILE, "utf8"\)/u, "edits to the script still apply without a restart (async re-read)");
  assert.match(proxySource, /piweb-archive-ui-reloaded/u);
  assert.match(proxySource, /piweb-archive-ui-reload-failed/u, "reload failures must never be silent");
  assert.match(proxySource, /session-archive-request/u);
  assert.match(proxySource, /Array\.isArray\(body\.runningSessionIds\).*this\.runningIds = new Set/u, "the rendered list must refresh the local running-session snapshot");
  assert.match(proxySource, /runningSessionsForArchive\(maxWaitMs = 120\)/u, "archive may probe fresh running state only behind a hard interactive timeout");
  assert.match(proxySource, /session-archive-running-cache/u, "running-state probe fallback must be logged");
  assert.match(proxySource, /session-archive-failed/u);
  assert.match(proxySource, /session-archive-rejected/u);
});
