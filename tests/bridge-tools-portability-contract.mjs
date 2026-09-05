import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandReferencesPath, readBridgeEgress, resolveBridgeRuntime } from "../tools/bridge-runtime-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("便携根优先自动发现 data/homes，兼容异机盘符", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peer-root-"));
  const data = path.join(root, "data");
  const homes = path.join(data, "homes");
  fs.mkdirSync(homes, { recursive: true });
  const runtime = resolveBridgeRuntime(pathToFileURL(path.join(root, "tools", "probe.mjs")).href, { PI_PORTABLE_HOME: root });
  assert.equal(runtime.portableRoot, path.resolve(root));
  assert.equal(runtime.data, path.resolve(data));
  assert.equal(runtime.accountHomes, path.resolve(homes));
  fs.rmSync(root, { recursive: true, force: true });
});

test("显式环境优先且 active-egress 可归一为代理出口", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-explicit-root-"));
  const data = path.join(root, "state");
  const homes = path.join(root, "slots");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(homes, { recursive: true });
  fs.writeFileSync(path.join(data, "active-egress.json"), JSON.stringify({ key: "peer", port: 18799 }));
  const runtime = resolveBridgeRuntime(import.meta.url, { PI_PORTABLE_HOME: root, PI_PORTABLE_DATA: data, CODEX_ACCOUNT_HOMES: homes });
  assert.equal(runtime.data, path.resolve(data));
  assert.equal(runtime.accountHomes, path.resolve(homes));
  assert.deepEqual(readBridgeEgress(data), { key: "peer", port: 18799, mode: "proxy", host: "127.0.0.1" });
  assert.equal(commandReferencesPath('node.exe D:\\Downloads\\pi-protable\\src\\bridge\\codex-responses-proxy.mjs', 'D:/Downloads/pi-protable/src/bridge/codex-responses-proxy.mjs'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("三个运维工具不再写死本机 C 盘默认路径", () => {
  for (const name of ["bridge-e2e-probe.mjs", "refresh-homes-auth.mjs", "restart-bridge-standalone.mjs"]) {
    const source = fs.readFileSync(path.join(repoRoot, "tools", name), "utf8");
    assert.doesNotMatch(source, /C:\/Users\/lop/u, name);
    assert.match(source, /resolveBridgeRuntime/u, name);
  }
});
