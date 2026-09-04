import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { disableTrustGate, MARK } from "../tools/patch-pi-trust-off.mjs";

const proxySource = fs.readFileSync(new URL("../src/piweb-ui-proxy.mjs", import.meta.url), "utf8");

// pi SDK 编译产物里的两种形态：dist/core（未压缩）与 dist/bundle（minified）。
const CORE = `export function hasTrustRequiringProjectResources(cwd) {
  let homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
  return false_placeholder;
}`;
const BUNDLE = `function hasTrustRequiringProjectResources(cwd){let homeDir=canonicalizePath(resolvePath(process.env.HOME||homedir8())),userAgentsSkillsDir=join30(homeDir,".agents","skills");return!0}`;

test("trust gate is short-circuited in both SDK build shapes", () => {
  for (const [label, source] of [["core", CORE], ["bundle", BUNDLE]]) {
    const result = disableTrustGate(source, label);
    assert.equal(result.applied, true, label);
    assert.equal(result.hits, 1, label);
    assert.match(result.out, /hasTrustRequiringProjectResources\(cwd\)\s*\{\/\*__piTrustOffV1\*\/return false;/, label);
    // 原函数体保持字节不变，回滚只需还原备份。
    assert.ok(result.out.includes(source.slice(source.indexOf("{") + 1)), `${label}: original body must be preserved`);
  }
});

test("trust patch is idempotent and fails closed when the anchor is gone", () => {
  const once = disableTrustGate(BUNDLE, "once");
  const twice = disableTrustGate(once.out, "twice");
  assert.equal(twice.applied, false);
  assert.equal(twice.out, once.out);
  assert.ok(once.out.includes(MARK));

  const missing = disableTrustGate("export function somethingElse(){return 1}", "missing");
  assert.equal(missing.applied, false);
  assert.equal(missing.hits, 0);
});

test("UI proxy must pass the client Host through", () => {
  // 改写 Host 会让浏览器的 Origin(:publicWebPort) 与 Host(:webPort) 不同源，
  // pi-web 的 CSRF 防护 (isApiRequestOriginAllowed) 会把所有写类 API 打成 403。
  assert.doesNotMatch(
    proxySource,
    /\.\.\.extra,\s*host: `127\.0\.0\.1:\$\{this\.webPort\}`/,
    "proxyHeaders must not unconditionally overwrite the Host header",
  );
  assert.match(
    proxySource,
    /if \(!result\.host\) result\.host = `127\.0\.0\.1:\$\{this\.webPort\}`/,
    "a Host is still synthesised for non-browser callers that send none",
  );
});
