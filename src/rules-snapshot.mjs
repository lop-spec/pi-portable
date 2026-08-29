// 单向规则快照：唯一真值/打包 bootstrap -> data/registry/rules-corpus.jsonl -> data/rules.jsonl。
// data/rules.jsonl 是生成物；运行时从不把它写回上游，也不会让旧 assets.enc 覆盖 managed source。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseRuleRegistry } from "./chain/rule-registry.mjs";

export const CANONICAL_RULES_LABEL = "vscodium/shared/registry/data/rules-corpus.jsonl";
export const RULES_ASSET_LAYOUT = Object.freeze({
  // 兼容旧 assets.enc：旧键只作为 bootstrap，禁止直接覆盖生成目标 data/rules.jsonl。
  "rules.jsonl": path.join("registry", "bootstrap-rules.jsonl"),
});

export function ruleSnapshotPaths(dataRoot) {
  return {
    bootstrap: path.join(dataRoot, "registry", "bootstrap-rules.jsonl"),
    managed: path.join(dataRoot, "registry", "rules-corpus.jsonl"),
    managedMetadata: path.join(dataRoot, "registry", "rules-corpus.source.json"),
    target: path.join(dataRoot, "rules.jsonl"),
    metadata: path.join(dataRoot, "rules.snapshot.json"),
  };
}

function readOptional(file, encoding = null) {
  try { return fs.readFileSync(file, encoding || undefined); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeAtomicIfChanged(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const current = readOptional(file);
  if (current?.equals(bytes)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, bytes, { flag: "wx" });
  try {
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  return true;
}

function seedIfMissing(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, bytes, { flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function validatedSnapshot(file) {
  const raw = fs.readFileSync(file, "utf8");
  return parseRuleRegistry(raw, file);
}

function readManagedMetadata(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function syncRulesSnapshot({
  dataRoot,
  upstreamSource = null,
  upstreamLabel = CANONICAL_RULES_LABEL,
} = {}) {
  if (!dataRoot) throw new Error("dataRoot is required");
  const paths = ruleSnapshotPaths(path.resolve(dataRoot));
  let sourceKind = "managed";
  let sourceLabel = upstreamLabel;
  let managedChanged = false;
  let sourceMetadataChanged = false;

  if (upstreamSource) {
    const upstream = validatedSnapshot(path.resolve(upstreamSource));
    managedChanged = writeAtomicIfChanged(paths.managed, upstream.raw);
    sourceKind = "upstream";
    sourceMetadataChanged = writeAtomicIfChanged(paths.managedMetadata, JSON.stringify({
      schema: 1,
      generated: true,
      sourceLabel: upstreamLabel,
      sourceKind: "upstream",
      sha256: upstream.sha256,
      ruleCount: upstream.rules.length,
    }, null, 2) + "\n");
  } else if (!fs.existsSync(paths.managed) && fs.existsSync(paths.bootstrap)) {
    const bootstrap = validatedSnapshot(paths.bootstrap);
    managedChanged = seedIfMissing(paths.managed, bootstrap.raw);
    sourceKind = managedChanged ? "bootstrap" : "managed";
    if (managedChanged) {
      sourceMetadataChanged = writeAtomicIfChanged(paths.managedMetadata, JSON.stringify({
        schema: 1,
        generated: true,
        sourceLabel: CANONICAL_RULES_LABEL,
        sourceKind: "bootstrap",
        sha256: bootstrap.sha256,
        ruleCount: bootstrap.rules.length,
      }, null, 2) + "\n");
    }
  } else if (!fs.existsSync(paths.managed)) {
    // base 版或旧数据目录可继续使用已有生成目标；有 managed/bootstrap 后自动收敛。
    if (!fs.existsSync(paths.target)) {
      return { ok: true, skipped: true, reason: "rules-source-unavailable", changed: false, paths };
    }
    const legacy = validatedSnapshot(paths.target);
    return {
      ok: true,
      skipped: true,
      reason: "managed-source-unavailable-existing-target-valid",
      changed: false,
      sourceKind: "existing-target",
      sourceLabel: "data/rules.jsonl (legacy compatibility)",
      sha256: legacy.sha256,
      ruleCount: legacy.rules.length,
      paths,
    };
  }

  const managed = validatedSnapshot(paths.managed);
  const managedMetadata = readManagedMetadata(paths.managedMetadata);
  if (!upstreamSource) {
    sourceLabel = managedMetadata?.sourceLabel || CANONICAL_RULES_LABEL;
    sourceKind = managedMetadata?.sourceKind || sourceKind;
  }
  const targetChanged = writeAtomicIfChanged(paths.target, managed.raw);
  const snapshotMetadata = JSON.stringify({
    schema: 1,
    generated: true,
    sourceLabel,
    sourceKind,
    sha256: managed.sha256,
    ruleCount: managed.rules.length,
  }, null, 2) + "\n";
  const metadataChanged = writeAtomicIfChanged(paths.metadata, snapshotMetadata);

  return {
    ok: true,
    skipped: false,
    changed: managedChanged || sourceMetadataChanged || targetChanged || metadataChanged,
    managedChanged,
    targetChanged,
    metadataChanged,
    sourceKind,
    sourceLabel,
    sha256: managed.sha256,
    ruleCount: managed.rules.length,
    paths,
  };
}

export function checkRulesSnapshot({ dataRoot, upstreamSource = null } = {}) {
  if (!dataRoot) throw new Error("dataRoot is required");
  const paths = ruleSnapshotPaths(path.resolve(dataRoot));
  const failures = [];
  let target = null;
  let managed = null;
  let upstream = null;
  try { target = validatedSnapshot(paths.target); }
  catch (error) { failures.push(`generated target invalid: ${error.message}`); }
  try { managed = validatedSnapshot(paths.managed); }
  catch (error) { failures.push(`managed source invalid: ${error.message}`); }
  if (upstreamSource) {
    try { upstream = validatedSnapshot(path.resolve(upstreamSource)); }
    catch (error) { failures.push(`upstream source invalid: ${error.message}`); }
  }
  if (target && managed && target.sha256 !== managed.sha256) failures.push("generated target differs from managed source");
  if (upstream && managed && upstream.sha256 !== managed.sha256) failures.push("managed source differs from canonical upstream");
  const metadata = readManagedMetadata(paths.metadata);
  if (!metadata) failures.push("snapshot metadata missing or invalid");
  else if (target && (metadata.sha256 !== target.sha256 || metadata.ruleCount !== target.rules.length)) {
    failures.push("snapshot metadata differs from generated target");
  }
  return {
    ok: failures.length === 0,
    failures,
    sha256: target?.sha256 || "",
    ruleCount: target?.rules.length || 0,
    paths,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const dataRoot = path.resolve(argument("--data-root") || process.env.PI_PORTABLE_DATA || path.join(moduleRoot, "..", "data"));
  const upstreamSource = argument("--source");
  const upstreamLabel = argument("--source-label") || CANONICAL_RULES_LABEL;
  try {
    const result = process.argv.includes("--check")
      ? checkRulesSnapshot({ dataRoot, upstreamSource })
      : syncRulesSnapshot({ dataRoot, upstreamSource, upstreamLabel });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
