import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyHideAgentToolCalls } from "../tools/patch-piweb-fold.mjs";

const patchSource = fs.readFileSync(new URL("../tools/patch-piweb-fold.mjs", import.meta.url), "utf8");

const cases = [
  {
    label: "client minifier symbols",
    source: "before;.map((block,i)=>({block,originalIndex:i})).filter(({block:e})=>!ef(e,{isStreaming:t}));after;text-render;thinking-render",
    expected: ".filter(({block:e})=>!ef(e,{isStreaming:t})&&\"toolCall\"!==e.type)",
  },
  {
    label: "server minifier symbols",
    source: "before;.map((block,i)=>({block,originalIndex:i})).filter(({block:a})=>!be(a,{isStreaming:b}));after;text-render;thinking-render",
    expected: ".filter(({block:a})=>!be(a,{isStreaming:b})&&\"toolCall\"!==a.type)",
  },
];

test("agent tool calls are filtered only from AssistantMessageView block items", () => {
  for (const fixture of cases) {
    const result = applyHideAgentToolCalls(fixture.source, fixture.label);
    assert.equal(result.applied, true, fixture.label);
    assert.match(result.out, new RegExp(fixture.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.out, /text-render;thinking-render$/, "text/thinking paths must remain byte-for-byte present");
    assert.equal(result.out.replace(/&&"toolCall"!==[\w$]+\.type/, ""), fixture.source, "only the toolCall exclusion may be added");
  }
});

test("tool-call visibility patch is idempotent", () => {
  const once = applyHideAgentToolCalls(cases[0].source, "once");
  const twice = applyHideAgentToolCalls(once.out, "twice");
  assert.equal(twice.applied, false);
  assert.equal(twice.out, once.out);
});

test("tool-call visibility patch fails closed on missing or ambiguous anchors", () => {
  assert.throws(() => applyHideAgentToolCalls("no assistant block filter", "missing"), /original=0 patched=0/);
  assert.throws(
    () => applyHideAgentToolCalls(`${cases[0].source}\n${cases[1].source}`, "ambiguous"),
    /original=2 patched=0/,
  );
});

test("old page and layout chunks are retained and old page hashes receive the same visibility filter", () => {
  assert.doesNotMatch(patchSource, /fs\.unlinkSync\((?:stage\.file|pageClientOld|layoutOld)\)/);
  assert.match(patchSource, /previousPageRetained: needsRename/);
  assert.match(patchSource, /legacyPageWrites\.push\(\{ file, out: legacy\.out \}\)/);
  assert.match(patchSource, /for \(const item of legacyPageWrites\) fs\.writeFileSync\(item\.file, item\.out\)/);
});
