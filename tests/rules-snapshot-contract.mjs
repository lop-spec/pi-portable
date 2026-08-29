import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CANONICAL_RULES_LABEL,
  RULES_ASSET_LAYOUT,
  checkRulesSnapshot,
  ruleSnapshotPaths,
  syncRulesSnapshot,
} from "../src/rules-snapshot.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-snapshot-"));
const source = path.join(temp, "canonical", "rules-corpus.jsonl");
const data = path.join(temp, "data");
const fixture = (suffix = "") => [
  JSON.stringify({ id: "always", trigger: "(?!)", text: `core${suffix}`, alwaysOn: ["claude", "codex"] }),
  JSON.stringify({ id: "repair", trigger: "修复|怎么办", text: `root cause first${suffix}` }),
].join("\n") + "\n";

try {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, fixture(), "utf8");

  const first = syncRulesSnapshot({ dataRoot: data, upstreamSource: source });
  const paths = ruleSnapshotPaths(data);
  assert.equal(first.ok, true);
  assert.equal(first.ruleCount, 2);
  assert.equal(first.sourceKind, "upstream");
  assert.equal(first.sourceLabel, CANONICAL_RULES_LABEL);
  assert.equal(fs.readFileSync(paths.managed, "utf8"), fixture());
  assert.equal(fs.readFileSync(paths.target, "utf8"), fixture());
  const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf8"));
  assert.equal(metadata.generated, true);
  assert.equal(metadata.sourceLabel, CANONICAL_RULES_LABEL);
  assert.equal(metadata.sha256, first.sha256);
  assert.equal(metadata.ruleCount, 2);
  assert.equal(checkRulesSnapshot({ dataRoot: data, upstreamSource: source }).ok, true);

  const targetMtime = fs.statSync(paths.target).mtimeMs;
  const second = syncRulesSnapshot({ dataRoot: data, upstreamSource: source });
  assert.equal(second.changed, false);
  const launcherStyle = syncRulesSnapshot({ dataRoot: data });
  assert.equal(launcherStyle.changed, false, "launcher sync without upstream must preserve canonical provenance metadata");
  assert.equal(fs.statSync(paths.target).mtimeMs, targetMtime, "idempotent sync must not rewrite rules.jsonl");

  const beforeInvalid = fs.readFileSync(paths.target);
  fs.writeFileSync(source, "{invalid json\n", "utf8");
  assert.throws(() => syncRulesSnapshot({ dataRoot: data, upstreamSource: source }), /invalid JSON/);
  assert.ok(fs.readFileSync(paths.target).equals(beforeInvalid), "invalid upstream must not alter generated rules");

  fs.writeFileSync(source, fixture("-v2"), "utf8");
  const updated = syncRulesSnapshot({ dataRoot: data, upstreamSource: source });
  assert.equal(updated.changed, true);
  assert.equal(fs.readFileSync(paths.target, "utf8"), fixture("-v2"));

  const bootstrapData = path.join(temp, "bootstrap-data");
  const bootstrapPaths = ruleSnapshotPaths(bootstrapData);
  fs.mkdirSync(path.dirname(bootstrapPaths.bootstrap), { recursive: true });
  fs.writeFileSync(bootstrapPaths.bootstrap, fixture("-bootstrap"), "utf8");
  const seeded = syncRulesSnapshot({ dataRoot: bootstrapData });
  assert.equal(seeded.sourceKind, "bootstrap");
  assert.equal(fs.readFileSync(bootstrapPaths.managed, "utf8"), fixture("-bootstrap"));
  assert.equal(fs.readFileSync(bootstrapPaths.target, "utf8"), fixture("-bootstrap"));
  fs.writeFileSync(bootstrapPaths.bootstrap, fixture("-stale-packaged-asset"), "utf8");
  const afterRestart = syncRulesSnapshot({ dataRoot: bootstrapData });
  assert.equal(afterRestart.sourceKind, "bootstrap");
  assert.equal(fs.readFileSync(bootstrapPaths.target, "utf8"), fixture("-bootstrap"), "stale packaged bootstrap must not overwrite managed rules");

  assert.equal(
    RULES_ASSET_LAYOUT["rules.jsonl"].replaceAll("\\", "/"),
    "registry/bootstrap-rules.jsonl",
    "legacy encrypted assets must become bootstrap input, never overwrite generated rules.jsonl",
  );

  const launcher = fs.readFileSync(path.join(root, "src", "launcher.mjs"), "utf8");
  assert.match(launcher, /syncRulesSnapshot/);
  assert.match(launcher, /RULES_ASSET_LAYOUT/);
  assert.ok(launcher.indexOf("refreshRulesSnapshot(); // 已有实例") < launcher.indexOf("if (await portAlive(PORTS.web))"), "rules must sync before an existing live instance short-circuits startup");
  assert.match(launcher, /PI_HEADLESS === "1"[\s\S]*不打开窗口/);

  const packer = fs.readFileSync(path.join(root, "tools", "pack-my-assets.mjs"), "utf8");
  assert.match(packer, /pack-my-assets 已退役/);
  assert.doesNotMatch(packer, /decision-replay-engine[\\/]data[\\/]rules-corpus\.jsonl/);

  console.log("PASS canonical -> bootstrap/managed -> generated rules snapshot contract");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
