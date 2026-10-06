import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

// The reasoning control moved into the composer's right group (redesign §3.4), on phones too,
// so its menu grows leftwards from the trigger's right edge instead of overflowing the screen.
test("anchors the reasoning menu to its trigger's right edge", () => {
  assert.match(
    source,
    /thinkingDropdownOpen[\s\S]*?bottom: "calc\(100% \+ 6px\)", right: 0 \}/,
  );
});
