import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execute = promisify(execFile);
import { OLD_DOC_RULES, NEW_DOC_RULES, patchPrompt, patchInstalledPrompt, resolveSdk } from "../tools/patch-pi-native-policy.mjs";
import { checkRuntime, evaluateRuntime } from "../tools/piweb-rules-live-check.mjs";
const version = fs.readFileSync(new URL("../src/lop-pretool.ts", import.meta.url), "utf8").match(/LOP_PRETOOL_RUNTIME_VERSION\s*=\s*"([^"]+)"/)[1];
const expected = { version, rulesSha256: "fixture-sha", agents: "fixture agents" };
const state = { systemPrompt: NEW_DOC_RULES.join("\n") + "\nfixture agents" };
const commands = [{ name: "pretool-status", source: "extension", description: `version=${version} policy=allow-or-block rulesSha256=fixture-sha rules=loaded` }];
const old = "prefix\n" + OLD_DOC_RULES.join("\n") + "\nsuffix";

test("narrow patch preserves surrounding prompt and is idempotent", () => {
  const patched = patchPrompt(old);
  assert.equal(patched, "prefix\n" + NEW_DOC_RULES.join("\n") + "\nsuffix");
  assert.equal(patchPrompt(patched), patched);
});
test("unknown, duplicated and partially patched upstream anchors fail visibly", () => {
  for (const s of ["unknown upstream", old + OLD_DOC_RULES[0], old.replace(OLD_DOC_RULES[0], NEW_DOC_RULES[0])]) assert.throws(() => patchPrompt(s), /anchor mismatch/);
});
test("disk patch backs up, validates all targets before writing, supports hoisted SDK", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-policy-"));
  try {
    const pkg = path.join(temp, "node_modules/@agegr/pi-web"), sdk = path.join(temp, "node_modules/@earendil-works/pi-coding-agent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(sdk, "dist/core"), { recursive: true });
    fs.mkdirSync(path.join(sdk, "dist/bundle/chunks"), { recursive: true });
    const core = path.join(sdk, "dist/core/system-prompt.js"), chunk = path.join(sdk, "dist/bundle/chunks/prompt.js");
    fs.writeFileSync(core, old); fs.writeFileSync(chunk, OLD_DOC_RULES[1]);
    assert.equal(resolveSdk(pkg), fs.realpathSync(sdk));
    assert.throws(() => patchInstalledPrompt(sdk), /anchor mismatch/);
    assert.equal(fs.readFileSync(core, "utf8"), old);
    fs.writeFileSync(chunk, old);
    assert.equal(patchInstalledPrompt(sdk, { check: true }).status, "pending");
    assert.equal(fs.readFileSync(core, "utf8"), old);
    const applied = patchInstalledPrompt(sdk);
    assert.equal(applied.changed, 2); assert.equal(applied.runtime, "not-verified");
    for (const file of [core, chunk]) {
      assert.equal(fs.readFileSync(file, "utf8"), patchPrompt(old));
      const backups = fs.readdirSync(path.join(path.dirname(file), "_历史版本"));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(path.dirname(file), "_历史版本", backups[0]), "utf8"), old);
    }
    assert.equal(patchInstalledPrompt(sdk).status, "already-patched");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test("runtime verification cannot be satisfied by updated disk alone", () => {
  assert.equal(evaluateRuntime(state, commands, expected).ok, true);
  assert.equal(evaluateRuntime({ systemPrompt: old + expected.agents }, commands, expected).ok, false);
  assert.equal(evaluateRuntime(state, [], expected).ok, false);
  assert.equal(evaluateRuntime(state, [...commands, ...commands], expected).ok, false);
  assert.equal(evaluateRuntime(state, [{ ...commands[0], source: "prompt" }], expected).ok, false);
  assert.equal(evaluateRuntime(state, commands, { ...expected, rulesSha256: "new-rules" }).ok, false);
  assert.equal(evaluateRuntime(state, commands, { ...expected, agents: "changed rules" }).ok, false);
  assert.equal(evaluateRuntime(state, commands, { ...expected, version: "new-version" }).ok, false);
});
test("CLI entrypoints run through portable directory junctions and cannot silently exit zero", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-junction-"));
  const linked = path.join(temp, "portable");
  const sdk = path.join(temp, "sdk");
  const core = path.join(sdk, "dist/core/system-prompt.js");
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ running: false }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    fs.symlinkSync(fileURLToPath(new URL("../", import.meta.url)), linked, process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(path.dirname(core), { recursive: true });
    fs.writeFileSync(core, old);
    async function cli(name, args) {
      try {
        const result = await execute(process.execPath, [path.join(linked, "tools", name), ...args], {
          windowsHide: true, timeout: 10000, env: { ...process.env, PIWEB_BASE: `http://127.0.0.1:${server.address().port}` },
        });
        return { ...result, code: 0 };
      } catch (error) {
        if (typeof error.code !== "number") throw error;
        return error;
      }
    }
    const pending = await cli("patch-pi-native-policy.mjs", ["--sdk", sdk, "--check"]);
    assert.equal(pending.code, 1, "junction --check must not silently skip pending patch");
    assert.equal(JSON.parse(pending.stdout).status, "pending");
    assert.equal(fs.readFileSync(core, "utf8"), old);
    const applied = await cli("patch-pi-native-policy.mjs", ["--sdk", sdk]);
    assert.equal(applied.code, 0);
    assert.equal(JSON.parse(applied.stdout).status, "patched");
    assert.equal(fs.readFileSync(core, "utf8"), patchPrompt(old));
    const unloaded = await cli("piweb-rules-live-check.mjs", ["--session", "fixture"]);
    assert.equal(unloaded.code, 1, "junction live check must not silently report success");
    assert.equal(JSON.parse(unloaded.stdout).status, "unverified");
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("live checker uses read-only commands, no prompt/new-session/model calls", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-policy-"));
  const requests = [];
  fs.mkdirSync(path.join(temp, "data")); fs.writeFileSync(path.join(temp, "data/rules-pretool.mjs"), "fixture"); fs.writeFileSync(path.join(temp, "AGENTS.md"), expected.agents);
  const hash = crypto.createHash("sha256").update("fixture").digest("hex");
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: req.url, type: body?.type });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/agent/running") return res.end(JSON.stringify({ runningSessionIds: [] }));
    if (req.method === "GET") return res.end(JSON.stringify({ running: false }));
    if (body?.type === "get_state") return res.end(JSON.stringify({ success: true, data: state }));
    if (body?.type === "get_commands") return res.end(JSON.stringify({ success: true, data: { commands: [{ ...commands[0], description: commands[0].description.replace("fixture-sha", hash) }] } }));
    res.statusCode = 400; res.end('{"error":"unexpected mutating request"}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await checkRuntime({ base, agentDir: temp })).status, "unverified");
    assert.equal((await checkRuntime({ base, agentDir: temp, sessionId: "fixture" })).status, "unverified");
    assert.equal((await checkRuntime({ base, agentDir: temp, sessionId: "fixture", restore: true })).ok, true);
    assert.ok(requests.every((r) => !r.type || ["get_state", "get_commands"].includes(r.type)));
    assert.ok(requests.every((r) => !r.url.includes("/new")));
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
