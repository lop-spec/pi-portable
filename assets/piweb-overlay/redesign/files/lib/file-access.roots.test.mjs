// Allowed roots come from the last complete session catalogue: an access check
// never waits on a catalogue rebuild, yet picks up a newer catalogue at once.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getAllowedFileRoots, normalizeSlashes } = await jiti.import("./file-access.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { resetSessionScanIndexForTests, flushSessionScanIndexPersist } = await jiti.import("./session-list-scanner.ts");

const timestamp = "2026-01-01T00:00:00.000Z";

test("roots follow the latest catalogue without waiting for a rebuild", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-roots-"));
  const sessions = join(root, "sessions", "p");
  fs.mkdirSync(sessions, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  const reset = () => {
    resetSessionScanIndexForTests();
    globalThis.__piSessionListCache = undefined;
    globalThis.__piSessionListPromise = undefined;
    globalThis.__piSessionListPromiseGeneration = undefined;
    globalThis.__piAllowedRootsCache = undefined;
  };
  reset();
  t.after(async () => {
    await flushSessionScanIndexPersist();
    reset();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (id, cwd) => {
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(join(sessions, `${id}.jsonl`), [
      { type: "session", version: 3, id, cwd, timestamp },
      { type: "message", id: `${id}1`, parentId: null, timestamp, message: { role: "user", content: "hi" } },
    ].map((entry) => JSON.stringify(entry) + "\n").join(""));
  };

  const first = join(root, "first");
  write("a", first);
  const roots = await getAllowedFileRoots();
  assert.ok(roots.has(normalizeSlashes(first)));

  // agent_end, model switches and renames invalidate the catalogue; an access
  // check right after must not rebuild it (or wait for one).
  invalidateSessionListCache();
  const catalogue = globalThis.__piSessionListCache;
  assert.equal(await getAllowedFileRoots(), roots);
  assert.equal(globalThis.__piSessionListCache, catalogue, "no rebuild was started by the access check");

  // A session created elsewhere shows up once the catalogue is rebuilt (the
  // sidebar does that), and the next access check sees it immediately.
  const second = join(root, "second");
  write("b", second);
  await listAllSessions();
  assert.ok((await getAllowedFileRoots()).has(normalizeSlashes(second)));
});

test("allowed-roots cache keeps the upstream 5 s lifetime (a longer one kept removed projects allowed for ~60 s)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./file-access.ts", import.meta.url), "utf8");
  const ttl = Number(/const ALLOWED_ROOTS_TTL_MS = ([\d_]+);/.exec(source)?.[1].replaceAll("_", ""));
  assert.ok(ttl > 0 && ttl <= 5000, `ALLOWED_ROOTS_TTL_MS is ${ttl}`);
});
