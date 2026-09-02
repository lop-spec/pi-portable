#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");

test("archive confirmation decorates only the destructive action and preserves Cancel", () => {
  assert.match(source, /nativeConfirmLabels/u, "confirmation action labels must be explicit");
  assert.match(source, /button\.dataset\.piSessionArchiveConfirm/u);
  assert.match(
    source,
    /if \(!button\.dataset\.piSessionArchiveConfirm && !nativeConfirmLabels\.has\(buttonText\)\) continue;/u,
    "sibling Cancel buttons must be rejected before archive decoration",
  );
  const guard = source.indexOf("nativeConfirmLabels.has(buttonText)");
  const mutation = source.indexOf('button.dataset.piSessionArchiveConfirm = "true"');
  assert.ok(guard >= 0 && mutation > guard, "the action-only guard must run before DOM mutation");
  assert.doesNotMatch(source, /nativeConfirmLabels[^;]*(?:Cancel|取消)/u, "Cancel must never be classified as a confirmation action");
});
