// No model or network calls. Real Pi loader -> ExtensionRunner -> agent-core -> native bash.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withSilentWindowsProcessEnv } from "../src/windows-process-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionFile = process.env.PI_PRETOOL_EXTENSION || path.join(root, "src/lop-pretool.ts");
const source = fs.readFileSync(extensionFile, "utf8");
assert.match(source, /pretool-only-v5/);
assert.doesNotMatch(source, /Object\.assign\(event\.input|\.fixup\(|sendUserMessage\(|sendMessage\(|registerTool\(/);
assert.match(source, /structuredClone\(event\.input/);
if (process.argv.includes("--static")) {
  console.log(JSON.stringify({ ok: true, scope: "source-contract-only; real execution runs after SDK installation" }));
  process.exit(0);
}

function sdkRoot() {
  if (process.env.PI_TEST_SDK) return fs.realpathSync(process.env.PI_TEST_SDK);
  for (const base of [path.join(root, "stage/app"), path.join(process.env.PI_PORTABLE_HOME || root, "app/node_modules/@agegr/pi-web"),
    path.join(process.env.APPDATA || root, "npm/node_modules/@agegr/pi-web")]) {
    let dir = base;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "node_modules/@earendil-works/pi-coding-agent");
      if (fs.existsSync(path.join(candidate, "dist/core/tools/bash.js"))) return fs.realpathSync(candidate);
      dir = path.dirname(dir);
    }
  }
  throw new Error("SDK not found: set PI_TEST_SDK; real execution tests must not be silently skipped");
}
const sdk = sdkRoot();
const imp = (rel) => import(pathToFileURL(path.join(sdk, rel)).href);
const { loadExtensions, clearExtensionCache } = await imp("dist/core/extensions/loader.js");
const { ExtensionRunner } = await imp("dist/core/extensions/runner.js");
const { SessionManager } = await imp("dist/core/session-manager.js");
const { createBashTool } = await imp("dist/core/tools/bash.js");
const req = createRequire(path.join(sdk, "package.json"));
const agentPackage = req.resolve("@earendil-works/pi-agent-core/package.json");
const { runAgentLoop } = await import(pathToFileURL(path.join(path.dirname(agentPackage), "dist/agent-loop.js")).href);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pretool-native-"));
const oldEnv = { ...process.env };
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const text = (message) => message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const model = { id: "offline-fixture", provider: "test", api: "test", input: ["text"], reasoning: false };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
try {
  Object.assign(process.env, withSilentWindowsProcessEnv(process.env));
  // Same portable-node environment as launcher.withPortableNode; never edit the system PATH.
  process.env.PATH = [path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter);
  delete process.env.BASH_ENV;
  process.env.PI_PRETOOL_LOG = path.join(temp, "pretool.log");
  const privateRules = process.env.PI_PRETOOL_RULES || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent"), "data/rules-pretool.mjs");
  const fixture = path.join(temp, "rules.mjs");
  fs.writeFileSync(fixture, `export function checkPreTool(ev) {
    if (ev.tool_input.command === "fixture-deny") return [{ id: "fixture", reason: "deny", fixup() { throw new Error("MUST NOT RUN"); } }];
    if (ev.tool_input.command === "fixture-mutate") ev.tool_input.command = "wrong-command";
    if (ev.tool_input.command === "fixture-throw") throw new Error("fixture-failure");
    return null;
  }\n`);
  if (process.env.PI_PRETOOL_RULES && !fs.existsSync(privateRules)) throw new Error("Explicit private rules file is missing");
  const rulesFile = fs.existsSync(privateRules) ? privateRules : fixture;
  console.log(JSON.stringify({ phase: "start", sdk, rules: rulesFile === fixture ? "CI fixture; private rules are not shipped" : "private-runtime", networkCalls: 0 }));

  async function runner(rulesPath, cwd) {
    process.env.PI_PRETOOL_MJS = rulesPath;
    clearExtensionCache();
    const loaded = await loadExtensions([extensionFile], cwd);
    assert.deepEqual(loaded.errors, []);
    check(loaded.extensions.length === 1, "real extension loaded");
    const identity = loaded.extensions[0].commands.get("pretool-status")?.description || "";
    check(identity.includes("rules=loaded"), "rules must actually load, not pass tests through fail-open: " + identity);
    const sm = SessionManager.inMemory(cwd);
    return new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sm, {});
  }
  const a = path.join(temp, "session-A"), b = path.join(temp, "session-B");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const ra = await runner(rulesFile, a), rb = await runner(rulesFile, b);
  async function batch(commands, cwd, gate) {
    const tool = createBashTool(cwd, { exposeSessionEnvironment: false,
      ...(process.platform === "win32" ? { shellPath: process.env.PI_TEST_BASH || [
        path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs/Git/bin/bash.exe"),
      ].find((file) => fs.existsSync(file)) } : {}) });
    const calls = commands.map((command, i) => ({ type: "toolCall", id: `case-${i}`, name: "bash", arguments: { command, timeout: 8 } }));
    const assistant = { role: "assistant", content: calls, api: "test", provider: "test", model: model.id, usage, stopReason: "toolUse", timestamp: Date.now() };
    const seen = [];
    const messages = await runAgentLoop([{ role: "user", content: "offline fixture", timestamp: Date.now() }],
      { systemPrompt: "", messages: [], tools: [tool] },
      { model, convertToLlm: (m) => m, toolExecution: "parallel", shouldStopAfterTurn: () => true,
        beforeToolCall: gate ? async ({ toolCall, args }) => {
          const before = structuredClone(args);
          const result = await gate.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args });
          assert.deepEqual(args, before, "extension must never change real tool arguments");
          seen.push(toolCall.id);
          return result;
        } : undefined }, () => {}, undefined,
      () => ({ async *[Symbol.asyncIterator]() { yield { type: "done", reason: "toolUse", message: assistant }; }, result: async () => assistant }));
    if (gate) assert.equal(seen.length, commands.length);
    return messages.filter((m) => m.role === "toolResult");
  }
  const docs = (s) => `node --input-type=module - <<'NODE'\n${s}\nNODE`;
  let concurrent = 0;
  for (let round = 0; round < 2; round++) {
    const commands = (session) => Array.from({ length: 12 }, (_, i) => {
      const tag = `${session}-${round}-${i}`;
      const body = `import fs from "node:fs"; fs.writeFileSync("${tag}.txt", "${tag}"); console.log("${tag}");`;
      return i % 2 ? `node -e ${quote(body.replace('import fs from "node:fs";', 'const fs=require("node:fs");') + " // 中文")}` : docs(body);
    });
    const [outA, outB] = await Promise.all([batch(commands("A"), a, ra), batch(commands("B"), b, rb)]);
    for (const [session, cwd, out] of [["A", a, outA], ["B", b, outB]]) for (let i = 0; i < 12; i++) {
      const tag = `${session}-${round}-${i}`;
      check(!out[i].isError && text(out[i]).trim() === tag, `isolated result ${tag}: ${text(out[i])}`);
      check(fs.readFileSync(path.join(cwd, tag + ".txt"), "utf8") === tag, "own write preserved");
      check(!fs.existsSync(path.join(cwd === a ? b : a, tag + ".txt")), "no cross-session writes");
      concurrent++;
    }
  }
  console.log(JSON.stringify({ phase: "parallel", calls: concurrent, mismatches: 0 }));
  fs.writeFileSync(path.join(a, "relative.mjs"), 'export default "relative-ok";\n');
  const semantics = [
    ["unicode-argv", `node -e 'console.log(process.argv[1])' '中文 空格'`, "中文 空格"],
    ["stdin", `printf 'stdin-value' | node -e 'process.stdin.on("data", b=>process.stdout.write(b))'`, "stdin-value"],
    ["relative-esm", docs('import value from "./relative.mjs"; console.log(value);'), "relative-ok"],
    ["heredoc-argv", `node --input-type=module - 'arg space' <<'NODE'\nconsole.log(process.argv[2]);\nNODE`, "arg space"],
    ["quoted", docs('console.log("$HOME `literal` \\\"quote\\\"");'), '$HOME `literal` "quote"'],
    ["expanded", `VALUE=expanded; node <<NODE\nconsole.log("$VALUE");\nNODE`, "expanded"],
    ["multi-heredoc", docs('console.log("one");') + "\n" + docs('console.log("two");'), "one\ntwo"],
    ["crlf", docs('console.log("crlf");').replaceAll("\n", "\r\n"), null],
    ["stderr-exit", `node -e 'console.error("expected-stderr"); process.exit(7)'`, null],
  ];
  for (const [name, command, expected] of semantics) {
    const [plain] = await batch([command], a);
    const [gated] = await batch([command], a, ra);
    assert.equal(text(gated), text(plain), name + " output matches native");
    assert.equal(gated.isError, plain.isError, name + " error flag matches native");
    if (expected !== null) assert.equal(text(gated).trim(), expected, name);
    if (name === "stderr-exit") check(gated.isError && /7/.test(text(gated)) && /expected-stderr/.test(text(gated)), "nonzero exit surfaced");
    // CRLF may be rejected by Bash itself; it must never silently execute a different program.
    if (name === "crlf") console.log(JSON.stringify({ phase: "crlf", nativeError: plain.isError, output: text(plain).slice(-160) }));
    assertions += 2;
  }
  const fake = await runner(fixture, a);
  for (const command of ["fixture-deny", "fixture-mutate", "fixture-throw"]) {
    const input = { command };
    const result = await fake.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: command, input });
    assert.deepEqual(input, { command });
    check(command === "fixture-deny" ? result?.block === true : result === undefined, "allow-or-block only");
  }
  check(fs.readFileSync(process.env.PI_PRETOOL_LOG, "utf8").includes("fixture-failure"), "fail-open reason logged");
  fs.writeFileSync(fixture, 'export function checkPreTool() { return [{ id: "new-snapshot", reason: "new snapshot" }]; }\n');
  const reloaded = await runner(fixture, a);
  const probe = { type: "tool_call", toolName: "bash", toolCallId: "reload", input: { command: "printf ok" } };
  check((await reloaded.emitToolCall(probe))?.block, "same-process reload imports changed rules bytes");
  check(await fake.emitToolCall(probe) === undefined, "active old instance keeps its immutable rule snapshot");
  if (rulesFile !== fixture) {
    const rules = await import(pathToFileURL(rulesFile).href);
    check(rules._RULES.every((r) => !r.fixup && !/^D[78]-/.test(r.id)), "private rules have zero fixups and no D7/D8");
    for (const command of ["ssh root@8.137.150.130 id", "powershell -Command 'Start-Process node'", 'mysql -h prod.example -e "DROP TABLE accounts"']) {
      const result = await ra.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "deny", input: { command } });
      check(result?.block, "existing safety restriction retained: " + command);
    }
    check(await ra.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "readonly", input: { command: 'mysql -h prod.example -e "SELECT 1"' } }) === undefined, "read-only SQL remains allowed (not executed)");
    const cfg = path.join(a, ".pi/agent/settings.json"); fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, "{}");
    const event = { type: "tool_call", toolName: "write", toolCallId: "backup", input: { path: cfg, content: "changed" } };
    check((await ra.emitToolCall(event))?.block, "Pi lowercase write requires backup");
    const history = path.join(path.dirname(cfg), "_历史版本"); fs.mkdirSync(history); fs.copyFileSync(cfg, path.join(history, "settings.json.bak-test"));
    check(await ra.emitToolCall(event) === undefined, "matching bak-style backup recognized");
    fs.writeFileSync(cfg, '{"new":true}');
    check((await ra.emitToolCall(event))?.block, "stale backup does not authorize edit");
  }
  console.log(JSON.stringify({ ok: true, assertions, concurrentCalls: concurrent, semanticCases: semantics.length, networkCalls: 0, scope: "real Pi tool pipeline" }));
} catch (error) {
  const logfile = path.join(temp, "pretool.log");
  if (fs.existsSync(logfile)) console.error(fs.readFileSync(logfile, "utf8").split(/\r?\n/).slice(-12).join("\n"));
  throw error;
} finally {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  // Only the absolute mkdtemp-owned fixture directory is disposable.
  fs.rmSync(temp, { recursive: true, force: true });
}
