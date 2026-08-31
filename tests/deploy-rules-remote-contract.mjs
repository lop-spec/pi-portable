import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertCanonicalSourcePath,
  deployRulesRemote,
  validateCanonicalRules,
} from "../tools/deploy-rules-remote.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-remote-deploy-"));
const source = path.join(temp, "vscodium", "shared", "registry", "data", "rules-corpus.jsonl");
const invalidPath = path.join(temp, "decision-replay-engine", "data", "rules-corpus.jsonl");
const fixture = [
  JSON.stringify({ id: "always", trigger: "(?!)", text: "core", alwaysOn: ["claude", "codex"] }),
  JSON.stringify({ id: "repair", trigger: "修复|怎么办", text: "root cause first" }),
].join("\n") + "\n";

try {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(source, fixture, "utf8");
  fs.writeFileSync(invalidPath, fixture, "utf8");
  const before = fs.readFileSync(source);
  const expected = validateCanonicalRules(source);

  assert.equal(assertCanonicalSourcePath(source), path.resolve(source));
  assert.throws(() => assertCanonicalSourcePath(invalidPath), /vscodium[\\/]shared[\\/]registry/);

  const calls = [];
  const execute = (file, args, options = {}) => {
    calls.push({ file, args: [...args], input: String(options.input || "") });
    if (file === "scp") return { status: 0, signal: null, stdout: "", stderr: "" };
    if (file === "ssh") {
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          ok: true,
          mode: options.input.includes("syncRulesSnapshot") ? "deploy" : "check",
          changed: true,
          ruleCount: expected.ruleCount,
          sha256: expected.sha256,
          managedSha256: expected.sha256,
          generatedSha256: expected.sha256,
          backupRoot: "D:/Downloads/pi-protable/data/backups/rules-deploy-test",
          incomingRemoved: true,
          lockRemoved: true,
        }) + "\n",
        stderr: "",
      };
    }
    throw new Error(`unexpected executable ${file}`);
  };

  const common = {
    source,
    host: "user@100.64.0.10",
    remoteRoot: "D:/portable/pi-portable",
    identity: "C:/keys/id_ed25519",
    knownHosts: "C:/keys/known_hosts",
    execute,
  };
  const deployed = deployRulesRemote(common);
  assert.equal(deployed.ok, true);
  assert.equal(deployed.sha256, expected.sha256);
  assert.equal(deployed.ruleCount, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, "scp");
  assert.equal(calls[1].file, "ssh");
  assert.ok(calls[0].args.includes("StrictHostKeyChecking=yes"));
  assert.ok(calls[0].args.includes(source));
  assert.match(calls[0].args.at(-1), /^user@100\.64\.0\.10:D:\/portable\/pi-portable\/data\/registry\/\.rules-corpus\.[a-f0-9]{12}\.\d+-\d+-[a-f0-9]{8}\.incoming$/);
  assert.match(calls[1].input, /syncRulesSnapshot/);
  assert.match(calls[1].input, /rules-deploy-/);
  assert.match(calls[1].input, /mkdirSync\(path\.dirname\(backupRoot\), \{ recursive: true \}\)/);
  assert.match(calls[1].input, /\.rules-deploy\.lock/);
  assert.match(calls[1].input, /metadataMatches/);
  assert.match(calls[1].input, /catch \(error\)[\s\S]*if \(lockHeld\) for \(const \[file, bytes\] of before\) atomicRestore/);
  assert.match(calls[1].input, /finally[\s\S]*if \(lockHeld\) fs\.rmSync/);
  assert.match(calls[1].input, /result\.incomingRemoved = !fs\.existsSync\(incoming\)/);
  assert.match(calls[1].input, /manifest\.final\.json[\s\S]*console\.log/);
  assert.ok(fs.readFileSync(source).equals(before), "deployment must never mutate canonical source");

  calls.length = 0;
  const checked = deployRulesRemote({ ...common, check: true });
  assert.equal(checked.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ssh");
  assert.doesNotMatch(calls[0].input, /syncRulesSnapshot/);

  const lockedRemote = (_file, _args, _options = {}) => ({
    status: 3,
    signal: null,
    stdout: JSON.stringify({
      ok: false,
      mode: "check",
      sha256: expected.sha256,
      managedSha256: expected.sha256,
      generatedSha256: expected.sha256,
      ruleCount: expected.ruleCount,
      incomingRemoved: true,
      incoming: [],
      lockPresent: true,
    }) + "\n",
    stderr: "ssh transport warning\n",
  });
  assert.throws(
    () => deployRulesRemote({ ...common, check: true, execute: lockedRemote }),
    /remote rules mismatch:[\s\S]*"lockPresent":true/,
    "domain JSON must survive a non-zero SSH exit so stale locks remain diagnosable",
  );

  let touchedNetwork = false;
  assert.throws(() => deployRulesRemote({ ...common, source: invalidPath, execute: () => { touchedNetwork = true; } }), /vscodium[\\/]shared[\\/]registry/);
  assert.equal(touchedNetwork, false, "non-canonical paths must fail before network access");

  fs.writeFileSync(source, "{invalid json\n", "utf8");
  assert.throws(() => deployRulesRemote({ ...common, execute: () => { touchedNetwork = true; } }), /invalid JSON/);
  assert.equal(touchedNetwork, false, "invalid canonical data must fail before network access");

  const workflow = fs.readFileSync(path.join(repo, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /node tests\/deploy-rules-remote-contract\.mjs/);
  assert.match(workflow, /Copy-Item tools\/deploy-rules-remote\.mjs stage\/tools\/deploy-rules-remote\.mjs/);
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  assert.match(readme, /deploy-rules-remote\.mjs[\s\S]*--check/);
  assert.doesNotMatch(readme, /decision-replay-engine[\\/]data[\\/]rules-corpus\.jsonl/);

  console.log(`PASS canonical-only remote deploy contract ${expected.ruleCount} rules ${expected.sha256.slice(0, 12)}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
