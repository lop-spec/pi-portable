import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendLineRotating } from "../src/log-rotate.mjs";

test("log append rotates automatically and keeps a bounded generation set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-log-rotate-"));
  const file = path.join(root, "service.log");
  try {
    for (let index = 0; index < 20; index += 1) {
      const result = appendLineRotating(file, `${index}:${"x".repeat(30)}`, { maxBytes: 80, keep: 3 });
      assert.equal(result.ok, true);
    }
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.1`), true);
    assert.equal(fs.existsSync(`${file}.3`), true);
    assert.equal(fs.existsSync(`${file}.4`), false);
    for (const candidate of [file, `${file}.1`, `${file}.2`, `${file}.3`]) {
      assert.ok(fs.statSync(candidate).size <= 100, candidate);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("log failures return a result instead of changing caller control flow", () => {
  const result = appendLineRotating("\0invalid", "line", { maxBytes: 10, keep: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
