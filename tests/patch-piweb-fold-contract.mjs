import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyShowAgentToolCalls } from "../tools/patch-piweb-fold.mjs";

const patchSource = fs.readFileSync(new URL("../tools/patch-piweb-fold.mjs", import.meta.url), "utf8");

const cases = [
  {
    label: "client minifier symbols",
    visible: "before;.filter(({block:e})=>!ef(e,{isStreaming:t}));after;text-render;thinking-render",
    hidden: "before;.filter(({block:e})=>!ef(e,{isStreaming:t})&&\"toolCall\"!==e.type);after;text-render;thinking-render",
  },
  {
    label: "server minifier symbols",
    visible: "before;.filter(({block:a})=>!be(a,{isStreaming:b}));after;text-render;thinking-render",
    hidden: "before;.filter(({block:a})=>!be(a,{isStreaming:b})&&\"toolCall\"!==a.type);after;text-render;thinking-render",
  },
];

test("agent tool calls are restored to the official visible block filter", () => {
  for (const fixture of cases) {
    const result = applyShowAgentToolCalls(fixture.hidden, fixture.label);
    assert.equal(result.applied, true, fixture.label);
    assert.equal(result.out, fixture.visible);
    assert.match(result.out, /text-render;thinking-render$/, "text/thinking paths remain byte-for-byte present");
  }
});

test("visible tool-call semantics are idempotent", () => {
  const result = applyShowAgentToolCalls(cases[0].visible, "visible");
  assert.equal(result.applied, false);
  assert.equal(result.out, cases[0].visible);
});

test("tool-call visibility restoration fails closed on missing or ambiguous anchors", () => {
  assert.throws(() => applyShowAgentToolCalls("no assistant block filter", "missing"), /visible=0 hidden=0/);
  assert.throws(
    () => applyShowAgentToolCalls(`${cases[0].visible}\n${cases[1].visible}`, "ambiguous"),
    /visible=2 hidden=0/,
  );
});

test("old page and layout chunks are retained while known page hashes are made visible", () => {
  assert.doesNotMatch(patchSource, /fs\.unlinkSync\((?:stage\.file|pageClientOld|layoutOld)\)/);
  assert.match(patchSource, /previousPageRetained: needsRename/);
  assert.match(patchSource, /legacyPageWrites\.push\(\{ file, out: legacy\.out \}\)/);
  assert.match(patchSource, /for \(const item of legacyPageWrites\) fs\.writeFileSync\(item\.file, item\.out\)/);
  assert.doesNotMatch(patchSource, /hideAgentToolCalls/);
});
