#!/usr/bin/env node
// 只读 canonical 规则的 SSH 单向部署器：本机校验 → 异机临时文件 → 物理备份 → 原子生成 → 哈希复验。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CANONICAL_RULES_LABEL } from "../src/rules-snapshot.mjs";
import { parseRuleRegistry } from "../src/chain/rule-registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_SUFFIX = ["vscodium", "shared", "registry", "data", "rules-corpus.jsonl"];
export const DEFAULT_CANONICAL_SOURCE = path.resolve(HERE, "..", "..", ...CANONICAL_SUFFIX);

function normalizedParts(file) {
  return path.resolve(file).replaceAll("\\", "/").split("/").filter(Boolean).map((part) => part.toLowerCase());
}

export function assertCanonicalSourcePath(file = DEFAULT_CANONICAL_SOURCE) {
  const resolved = path.resolve(file);
  const real = fs.realpathSync(resolved);
  const parts = normalizedParts(real);
  const suffix = CANONICAL_SUFFIX.map((part) => part.toLowerCase());
  if (parts.length < suffix.length || !suffix.every((part, index) => parts[parts.length - suffix.length + index] === part)) {
    throw new Error(`rules source must be vscodium/shared/registry/data/rules-corpus.jsonl, got ${resolved}`);
  }
  return real;
}

export function validateCanonicalRules(file) {
  const parsed = parseRuleRegistry(fs.readFileSync(file, "utf8"), file);
  return { ...parsed, ruleCount: parsed.rules.length };
}

function safeHost(host) {
  const value = String(host || "").trim();
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$/u.test(value) || value.startsWith("-")) {
    throw new Error("--host must use user@host without shell syntax");
  }
  return value;
}

function safeRemoteRoot(remoteRoot) {
  const value = String(remoteRoot || "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!/^[A-Za-z]:\/[A-Za-z0-9_. /-]+$/u.test(value) || /["'\r\n]/u.test(value)) {
    throw new Error("--remote-root must be an absolute Windows path without quotes or control characters");
  }
  return value;
}

function transportArgs({ identity = "", knownHosts = "", quiet = false } = {}) {
  const args = [];
  if (quiet) args.push("-q");
  args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes");
  if (knownHosts) args.push("-o", `UserKnownHostsFile=${path.resolve(knownHosts)}`);
  if (identity) args.push("-i", path.resolve(identity));
  return args;
}

function commandFailure(file, result) {
  if (result?.error) return new Error(`${file} failed: ${result.error.message}`);
  const detail = [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim().split(/\r?\n/u).slice(-12).join("\n");
  return new Error(`${file} exited ${result?.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
}

function executeChecked(execute, file, args, options = {}) {
  const result = execute(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result?.error || result?.status !== 0) throw commandFailure(file, result);
  return result;
}

function parseRemoteResult(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && Object.hasOwn(value, "ok")) return value;
    } catch {}
  }
  throw new Error("remote verifier returned no JSON result");
}

function executeRemoteJson(execute, file, args, options = {}) {
  const result = execute(file, args, {
    encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  if (result?.error) throw commandFailure(file, result);
  let value;
  try { value = parseRemoteResult(result?.stdout); }
  catch (error) {
    if (result?.status !== 0) throw commandFailure(file, result);
    throw error;
  }
  if (result?.status !== 0 && value.ok === true) throw commandFailure(file, result);
  return value;
}

function remoteModule(root) {
  return `${root}/src/rules-snapshot.mjs`;
}

function buildCheckProgram({ root, expectedSha256, expectedRuleCount }) {
  return `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
const dataRoot = path.join(root, "data");
const modulePath = ${JSON.stringify(remoteModule(root))};
const registryPath = path.join(root, "src", "chain", "rule-registry.mjs");
const expectedSha256 = ${JSON.stringify(expectedSha256)};
const expectedRuleCount = ${Number(expectedRuleCount)};
const { checkRulesSnapshot } = await import(pathToFileURL(modulePath).href + "?remote-check=" + Date.now());
const { parseRuleRegistry } = await import(pathToFileURL(registryPath).href + "?remote-check=" + Date.now());
const validateRulesFile = (file) => { const parsed = parseRuleRegistry(fs.readFileSync(file, "utf8"), file); return { ...parsed, ruleCount: parsed.rules.length }; };
const managed = path.join(dataRoot, "registry", "rules-corpus.jsonl");
const generated = path.join(dataRoot, "rules.jsonl");
const state = checkRulesSnapshot({ dataRoot });
let managedState = null;
let generatedState = null;
try { managedState = validateRulesFile(managed); } catch {}
try { generatedState = validateRulesFile(generated); } catch {}
const registryRoot = path.join(dataRoot, "registry");
const incoming = fs.existsSync(registryRoot)
  ? fs.readdirSync(registryRoot).filter((name) => name.includes(".incoming")) : [];
const lockPresent = fs.existsSync(path.join(registryRoot, ".rules-deploy.lock"));
const result = {
  ok: state.ok && managedState?.sha256 === expectedSha256 && generatedState?.sha256 === expectedSha256 &&
    managedState?.ruleCount === expectedRuleCount && generatedState?.ruleCount === expectedRuleCount && incoming.length === 0 && !lockPresent,
  mode: "check",
  changed: false,
  failures: state.failures,
  sha256: generatedState?.sha256 || "",
  managedSha256: managedState?.sha256 || "",
  generatedSha256: generatedState?.sha256 || "",
  ruleCount: generatedState?.ruleCount || 0,
  incomingRemoved: incoming.length === 0,
  incoming,
  lockPresent,
};
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 3;
`;
}

function buildDeployProgram({ root, incoming, expectedSha256, expectedRuleCount }) {
  return `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
const dataRoot = path.join(root, "data");
const incoming = ${JSON.stringify(incoming)};
const expectedSha256 = ${JSON.stringify(expectedSha256)};
const expectedRuleCount = ${Number(expectedRuleCount)};
const modulePath = ${JSON.stringify(remoteModule(root))};
const registryPath = path.join(root, "src", "chain", "rule-registry.mjs");
const { checkRulesSnapshot, ruleSnapshotPaths, syncRulesSnapshot } = await import(pathToFileURL(modulePath).href + "?remote-deploy=" + Date.now());
const { parseRuleRegistry } = await import(pathToFileURL(registryPath).href + "?remote-deploy=" + Date.now());
const validateRulesFile = (file) => { const parsed = parseRuleRegistry(fs.readFileSync(file, "utf8"), file); return { ...parsed, ruleCount: parsed.rules.length }; };
const paths = ruleSnapshotPaths(dataRoot);
const managedSourceMetadata = paths.managedMetadata;
const tracked = [paths.managed, managedSourceMetadata, paths.target, paths.metadata];
const lock = path.join(dataRoot, "registry", ".rules-deploy.lock");
const before = new Map();
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const atomicRestore = (file, bytes) => {
  if (bytes === null) { try { fs.rmSync(file, { force: true }); } catch {} return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".rollback-" + process.pid + "-" + Date.now();
  fs.writeFileSync(temp, bytes, { flag: "wx" });
  try { fs.renameSync(temp, file); } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
};
let backupRoot = "";
let result = null;
let lockHeld = false;
try {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\\n", { flag: "wx" });
    lockHeld = true;
  } catch (error) { if (error?.code === "EEXIST") throw new Error("another rules deployment holds " + lock); throw error; }
  for (const file of tracked) before.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
  const incomingState = validateRulesFile(incoming);
  if (incomingState.sha256 !== expectedSha256 || incomingState.ruleCount !== expectedRuleCount) {
    throw new Error("incoming canonical mismatch");
  }
  const existingManaged = fs.existsSync(paths.managed) ? validateRulesFile(paths.managed) : null;
  const existingGenerated = fs.existsSync(paths.target) ? validateRulesFile(paths.target) : null;
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\\uFEFF/, "")); } catch { return null; } };
  const sourceMetadata = readJson(paths.managedMetadata);
  const snapshotMetadata = readJson(paths.metadata);
  const metadataMatches = sourceMetadata?.sourceLabel === ${JSON.stringify(CANONICAL_RULES_LABEL)} && sourceMetadata?.sourceKind === "upstream" &&
    sourceMetadata?.sha256 === expectedSha256 && sourceMetadata?.ruleCount === expectedRuleCount &&
    snapshotMetadata?.sourceLabel === ${JSON.stringify(CANONICAL_RULES_LABEL)} && snapshotMetadata?.sourceKind === "upstream" &&
    snapshotMetadata?.sha256 === expectedSha256 && snapshotMetadata?.ruleCount === expectedRuleCount;
  const needsChange = existingManaged?.sha256 !== expectedSha256 || existingGenerated?.sha256 !== expectedSha256 ||
    existingManaged?.ruleCount !== expectedRuleCount || existingGenerated?.ruleCount !== expectedRuleCount || !metadataMatches;
  if (needsChange) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
    backupRoot = path.join(dataRoot, "backups", "rules-deploy-" + stamp + "-" + process.pid);
    fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
    fs.mkdirSync(backupRoot, { recursive: false });
    const files = [];
    for (const file of tracked) {
      const bytes = before.get(file);
      if (bytes === null) continue;
      const relative = path.relative(dataRoot, file);
      const backup = path.join(backupRoot, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      files.push({ source: file, backup, bytes: bytes.length, sha256: sha(bytes) });
    }
    fs.writeFileSync(path.join(backupRoot, "manifest.before.json"), JSON.stringify({
      createdAt: new Date().toISOString(), reason: "canonical rules remote deploy", files,
      expectedSha256, expectedRuleCount,
    }, null, 2) + "\\n", { flag: "wx" });
  }
  const synced = syncRulesSnapshot({ dataRoot, upstreamSource: incoming, upstreamLabel: ${JSON.stringify(CANONICAL_RULES_LABEL)} });
  const checked = checkRulesSnapshot({ dataRoot, upstreamSource: incoming });
  const managedState = validateRulesFile(paths.managed);
  const generatedState = validateRulesFile(paths.target);
  result = {
    ok: checked.ok && managedState.sha256 === expectedSha256 && generatedState.sha256 === expectedSha256 &&
      managedState.ruleCount === expectedRuleCount && generatedState.ruleCount === expectedRuleCount,
    mode: "deploy",
    changed: synced.changed,
    failures: checked.failures,
    sha256: generatedState.sha256,
    managedSha256: managedState.sha256,
    generatedSha256: generatedState.sha256,
    ruleCount: generatedState.ruleCount,
    backupRoot,
    incomingRemoved: false,
    lockRemoved: false,
  };
  if (!result.ok) throw new Error("post-deploy rules verification failed: " + JSON.stringify(result));
} catch (error) {
  if (lockHeld) for (const [file, bytes] of before) atomicRestore(file, bytes);
  throw error;
} finally {
  fs.rmSync(incoming, { force: true });
  if (lockHeld) fs.rmSync(lock, { force: true });
}
result.incomingRemoved = !fs.existsSync(incoming);
result.lockRemoved = !fs.existsSync(lock);
if (!result.incomingRemoved || !result.lockRemoved) throw new Error("remote deployment cleanup incomplete");
if (backupRoot) fs.writeFileSync(path.join(backupRoot, "manifest.final.json"), JSON.stringify(result, null, 2) + "\\n");
console.log(JSON.stringify(result));
`;
}

function buildCleanupProgram(incoming) {
  return `import fs from "node:fs"; fs.rmSync(${JSON.stringify(incoming)}, { force: true });`;
}

function assertRemoteMatches(result, local) {
  if (!result?.ok || result.sha256 !== local.sha256 || result.managedSha256 !== local.sha256 ||
      result.generatedSha256 !== local.sha256 || result.ruleCount !== local.ruleCount || result.incomingRemoved !== true ||
      (result.mode === "deploy" && result.lockRemoved !== true)) {
    throw new Error(`remote rules mismatch: ${JSON.stringify(result)}`);
  }
  return result;
}

export function deployRulesRemote({
  source = DEFAULT_CANONICAL_SOURCE,
  host,
  remoteRoot,
  identity = "",
  knownHosts = "",
  check = false,
  ssh = "ssh",
  scp = "scp",
  execute = spawnSync,
} = {}) {
  const canonicalSource = assertCanonicalSourcePath(source);
  const local = validateCanonicalRules(canonicalSource);
  const remoteHost = safeHost(host);
  const root = safeRemoteRoot(remoteRoot);
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const incoming = `${root}/data/registry/.rules-corpus.${local.sha256.slice(0, 12)}.${nonce}.incoming`;
  const sshArgs = transportArgs({ identity, knownHosts });
  const remoteNode = `${root}/runtime/node.exe`.replaceAll("/", "\\");
  const remoteCommand = `"${remoteNode}" --input-type=module -`;

  if (check) {
    const program = buildCheckProgram({ root, expectedSha256: local.sha256, expectedRuleCount: local.ruleCount });
    const result = executeRemoteJson(execute, ssh, [...sshArgs, remoteHost, remoteCommand], { input: program });
    return assertRemoteMatches(result, local);
  }

  executeChecked(execute, scp, [
    ...transportArgs({ identity, knownHosts, quiet: true }),
    canonicalSource,
    `${remoteHost}:${incoming}`,
  ]);
  try {
    const program = buildDeployProgram({ root, incoming, expectedSha256: local.sha256, expectedRuleCount: local.ruleCount });
    const result = executeRemoteJson(execute, ssh, [...sshArgs, remoteHost, remoteCommand], { input: program });
    return assertRemoteMatches(result, local);
  } catch (error) {
    try {
      execute(ssh, [...sshArgs, remoteHost, remoteCommand], {
        input: buildCleanupProgram(incoming), encoding: "utf8", windowsHide: true, timeout: 15000,
      });
    } catch {}
    throw error;
  }
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

function usage() {
  return [
    "Usage:",
    "  node tools/deploy-rules-remote.mjs --host user@host --remote-root D:/path/to/pi-portable [options]",
    "Options:",
    "  --source <vscodium/shared/registry/data/rules-corpus.jsonl>",
    "  --identity <private-key> --known-hosts <known_hosts>",
    "  --check    read-only remote drift check (no SCP, no writes)",
  ].join("\n");
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
  } else {
    try {
      const result = deployRulesRemote({
        source: argument(process.argv, "--source") || DEFAULT_CANONICAL_SOURCE,
        host: argument(process.argv, "--host"),
        remoteRoot: argument(process.argv, "--remote-root"),
        identity: argument(process.argv, "--identity"),
        knownHosts: argument(process.argv, "--known-hosts"),
        check: process.argv.includes("--check"),
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error?.stack || String(error));
      process.exitCode = 1;
    }
  }
}
