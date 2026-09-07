// Offline integration against the installed native SDK. No provider/model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { upstreamConnectionError } from "../src/bridge/transport-errors.mjs";
const web = process.env.PI_WEB_PKG || path.join(process.env.PI_PORTABLE_HOME || "", "app/node_modules/@agegr/pi-web/package.json");
const require = createRequire(fs.realpathSync(web));
function importEntry(name) {
  const root = require.resolve.paths(name).map(p => path.join(p, name)).find(p => fs.existsSync(path.join(p, "package.json")));
  assert.ok(root, `installed package missing: ${name}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = pkg.exports?.["."]?.import || pkg.main;
  assert.equal(typeof entry, "string", `${name} must expose an official import entry`);
  return path.resolve(root, entry);
}
const sdkEntry = importEntry("@earendil-works/pi-coding-agent");
const aiRoot = path.dirname(importEntry("@earendil-works/pi-ai"));
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime } = await import(pathToFileURL(sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(aiRoot, "utils/event-stream.js")));
const { isRetryableAssistantError } = await import(pathToFileURL(path.join(aiRoot, "utils/retry.js")));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-sdk-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Offline test attempted network access"); };
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
try {
  check(!isRetryableAssistantError({ stopReason: "error", errorMessage: "上游连接失败" }), "baseline loses retry classification");
  const fixed = upstreamConnectionError({ code: "ECONNECT_TIMEOUT", connectAttempts: 3 });
  check(isRetryableAssistantError({ stopReason: "error", errorMessage: fixed.error.message }), "fixed message survives Codex adapter and classifies as retryable");
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(temp, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "offline-test-key");
  const model = modelRuntime.getModels("openai")[0];
  assert.ok(model, "installed SDK must expose a static API-key model for the offline loop fixture");
  const { stream: codexStream } = await import(pathToFileURL(path.join(aiRoot, "api/openai-codex-responses.js")));
  const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64url")}.fixture`;
  const wire = await codexStream(modelRuntime.getModels("openai-codex")[0], { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, {
    apiKey: jwt, transport: "sse", maxRetries: 0,
    fetch: async () => new Response(JSON.stringify(fixed), { status: 502, headers: { "content-type": "application/json" } }),
  }).result();
  check(wire.stopReason === "error", "real Codex adapter preserves transport failure");
  check(isRetryableAssistantError(wire), "real Codex adapter classifies fixed HTTP 502 without a network request");
  const scenarios = [
    { name: "error-then-success", reasons: ["error", "stop"], calls: 2, retries: 1 },
    { name: "bounded-exhaustion", reasons: ["error", "error", "error", "error"], calls: 4, retries: 3 },
    { name: "normal-stop-never-retried", reasons: ["stop"], calls: 1, retries: 0 },
    { name: "user-aborted-never-retried", reasons: ["aborted"], calls: 1, retries: 0 },
    { name: "permission-denied-never-retried", reasons: ["denied"], calls: 1, retries: 0 },
    { name: "completed-tool-not-reexecuted", reasons: ["toolUse", "error", "stop"], calls: 3, retries: 1, tools: 1 },
    { name: "native-reload-at-tool-boundary", reasons: ["toolUse", "stop"], calls: 2, retries: 0, tools: 1, reload: true },
  ];
  for (const scenario of scenarios) {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetries: 0 } } });
    let promptText = "offline initial prompt";
    const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => promptText });
    await loader.reload();
    let tools = 0, calls = 0; const events = [];
    const { session } = await createAgentSession({ cwd: temp, agentDir: temp, model, modelRuntime, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(temp), thinkingLevel: "off", tools: ["test_effect"],
      customTools: [{ name: "test_effect", label: "effect", description: "offline test side effect counter", parameters: { type: "object", properties: {} },
        execute: async () => {
          tools++;
          if (scenario.reload) { promptText = "offline reloaded prompt"; await session.reload(); }
          return { content: [{ type: "text", text: "saved" }], details: {} };
        } }],
    });
    session.agent.streamFunction = () => {
      const reason = scenario.reasons[calls++];
      assert.ok(reason, `${scenario.name}: unexpected extra assistant call`);
      const stream = new AssistantMessageEventStream();
      const stopReason = reason === "denied" ? "error" : reason;
      const message = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(), stopReason,
        content: reason === "toolUse" ? [{ type: "toolCall", id: "effect-once", name: "test_effect", arguments: {} }] : reason === "stop" ? [{ type: "text", text: "done" }] : [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        ...(reason === "error" ? { errorMessage: fixed.error.message } : reason === "denied" ? { errorMessage: "Permission denied" } : reason === "aborted" ? { errorMessage: "Request was aborted" } : {}),
      };
      queueMicrotask(() => {
        if (["error", "aborted"].includes(stopReason)) stream.push({ type: "error", reason: stopReason, error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      });
      return stream;
    };
    session.subscribe(e => events.push(e));
    try {
      await session.prompt("Execute the offline fixture.");
      check(calls === scenario.calls, `${scenario.name}: calls ${calls} != ${scenario.calls}`);
      check(events.filter(e => e.type === "auto_retry_start").length === scenario.retries, `${scenario.name}: bounded retries`);
      check(tools === (scenario.tools || 0), `${scenario.name}: exactly-once completed tools`);
      check(events.some(e => e.type === "agent_end"), `${scenario.name}: lifecycle ends`);
      if (scenario.reload) check(session.agent.state.systemPrompt.includes("offline reloaded prompt"), "native reload takes effect without restarting or dropping the tool result");
      console.log(`PASS ${scenario.name} calls=${calls} retries=${scenario.retries} tools=${tools}`);
    } finally { session.dispose(); }
  }
  console.log(`pi-stop-retry-sdk: ${checks} assertions passed; network/model requests=0`);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}
