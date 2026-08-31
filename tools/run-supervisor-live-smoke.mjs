// Isolated live smoke for Pi Web durable run recovery.
// Uses a one-shot local fault proxy, unique data root and hidden child processes.
// It preserves all evidence under --output-root and never touches the production session tree.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function argsOf(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    result[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
  }
  return result;
}
const args = argsOf(process.argv.slice(2));
const required = (name) => {
  if (!args[name]) throw new Error(`missing --${name}`);
  return path.resolve(args[name]);
};
const sourceRoot = required("source-root");
const templateData = required("template-data");
const webEntry = required("web-entry");
const outputRoot = required("output-root");
const workDir = path.resolve(args["work-dir"] || sourceRoot);
const nodeExe = path.resolve(args.node || process.execPath);
const webPort = Number(args["web-port"] || 31141);
const internalWebPort = Number(args["internal-web-port"] || webPort - 1);
const supervisorPort = Number(args["supervisor-port"] || webPort + 1);
const faultPort = Number(args["fault-port"] || webPort + 2);
const bridgePort = Number(args["bridge-port"] || 8794);
const timeoutMs = Number(args.timeout || 180000);
const startedAt = Date.now();
const runRoot = path.join(outputRoot, new Date().toISOString().replace(/[:.]/gu, "-") + `-${process.pid}`);
const dataRoot = path.join(runRoot, "data");
const agentRoot = path.join(dataRoot, ".pi", "agent");
fs.mkdirSync(path.join(agentRoot, "extensions"), { recursive: true });

const copyIfPresent = (from, to) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  return true;
};
for (const name of ["auth.json", "models-store.json", "service-tier.json"]) {
  copyIfPresent(path.join(templateData, ".pi", "agent", name), path.join(agentRoot, name));
}
copyIfPresent(path.join(templateData, "auth.json"), path.join(dataRoot, "auth.json"));
copyIfPresent(path.join(sourceRoot, "src", "lop-chain.ts"), path.join(agentRoot, "extensions", "lop-chain.ts"));
fs.writeFileSync(path.join(agentRoot, "AGENTS.md"), "# Isolated live recovery smoke\n- Do not call tools.\n- Obey the requested exact marker.\n");
fs.writeFileSync(path.join(agentRoot, "settings.json"), JSON.stringify({
  defaultProvider: "codex-bridge",
  defaultModel: "gpt-5.6-sol",
  defaultThinkingLevel: "low",
  modelThinkingLevels: { "codex-bridge/gpt-5.6-sol": "low" },
  skills: [],
  shellPath: "C:/Program Files/Git/bin/bash.exe",
}, null, 2) + "\n");
const templateModels = JSON.parse(fs.readFileSync(path.join(templateData, ".pi", "agent", "models.json"), "utf8"));
if (!templateModels?.providers?.["codex-bridge"]) throw new Error("codex-bridge provider missing in template models.json");
templateModels.providers["codex-bridge"].baseUrl = `http://127.0.0.1:${faultPort}/v1`;
fs.writeFileSync(path.join(agentRoot, "models.json"), JSON.stringify(templateModels, null, 2) + "\n");

const children = new Set();
function childLog(name) {
  const file = path.join(runRoot, `${name}.log`);
  const fd = fs.openSync(file, "a");
  return { file, fd };
}
function spawnHidden(name, script, env) {
  const log = childLog(name);
  let child;
  try {
    child = spawn(nodeExe, [script, ...(name.startsWith("web") ? ["--no-open"] : [])], {
      cwd: sourceRoot,
      env,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
  } finally { fs.closeSync(log.fd); }
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}
async function waitFor(check, label, limit = timeoutMs, interval = 100) {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < limit) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = String(error?.message || error); }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}
async function jsonFetch(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok || body?.error) throw new Error(`${url} HTTP ${response.status}: ${body?.error || text.slice(0, 300)}`);
  return body;
}
async function waitWeb() {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${internalWebPort}/`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  }, "Pi Web health", 30000, 200);
}
function sessionFile(sessionId) {
  const root = path.join(agentRoot, "sessions");
  if (!fs.existsSync(root)) return "";
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile() && item.name.includes(sessionId) && item.name.endsWith(".jsonl")) return full;
    }
  }
  return "";
}
function sessionEvidence(sessionId, marker) {
  const file = sessionFile(sessionId);
  if (!file) return null;
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const messages = rows.filter((row) => row.type === "message");
  const recoveryIndex = messages.findIndex((row) => row.message?.role === "user" &&
    String(row.message?.content?.find?.((part) => part?.type === "text")?.text || row.message?.content || "").startsWith("[lop-run-supervisor recovery]"));
  const recovery = recoveryIndex >= 0 ? messages[recoveryIndex] : null;
  const terminal = recoveryIndex >= 0 ? messages.slice(recoveryIndex + 1).find((row) => row.message?.role === "assistant" && row.message?.stopReason === "stop") : null;
  const terminalText = terminal?.message?.content?.filter?.((part) => part?.type === "text").map((part) => part.text).join("\n") || "";
  return { file, rows: rows.length, recoveryIndex, recoveryTimestamp: recovery?.timestamp || "", terminal: Boolean(terminal), terminalText, markerSeen: terminalText.includes(marker) };
}

let faultMode = "pass";
let faultHits = 0;
const faultEvents = [];
const faultServer = http.createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.includes("/responses")) {
    response.writeHead(404); response.end(); return;
  }
  if (faultMode === "hang") {
    faultMode = "pass";
    faultHits += 1;
    faultEvents.push({ at: Date.now(), mode: "hang" });
    request.resume();
    const timer = setTimeout(() => { if (!response.destroyed) { response.writeHead(503); response.end("fault timeout"); } }, 60000);
    response.once("close", () => clearTimeout(timer));
    return;
  }
  if (faultMode === "sse-error") {
    faultMode = "pass";
    faultHits += 1;
    faultEvents.push({ at: Date.now(), mode: "sse-error" });
    request.resume();
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.end('data: {"type":"error","code":"run_supervisor_smoke","message":"injected prompt stream failure"}\n\n');
    }, 1200);
    return;
  }
  const upstream = http.request({
    hostname: "127.0.0.1", port: bridgePort, method: request.method, path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${bridgePort}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    if (!response.destroyed) response.end(JSON.stringify({ error: error.message }));
  });
  request.pipe(upstream);
});
await new Promise((resolve, reject) => {
  faultServer.once("error", reject);
  faultServer.listen(faultPort, "127.0.0.1", resolve);
});

const commonEnv = {
  ...process.env,
  PATH: [path.dirname(nodeExe), process.env.PATH || ""].filter(Boolean).join(path.delimiter),
  Path: [path.dirname(nodeExe), process.env.Path || process.env.PATH || ""].filter(Boolean).join(path.delimiter),
  PORT: String(internalWebPort),
  PI_WEB_PORT: String(internalWebPort),
  PI_RUN_SUPERVISOR_PUBLIC_PORT: String(webPort),
  PI_RUN_SUPERVISOR_PORT: String(supervisorPort),
  PI_PORTABLE_DATA: dataRoot,
  PI_PORTABLE_HOME: sourceRoot,
  PI_CODING_AGENT_DIR: agentRoot,
  HOME: dataRoot,
  USERPROFILE: dataRoot,
  NO_PROXY: "localhost,127.0.0.1",
  PI_HEADLESS: "1",
  PI_CHAIN_SKIP_STARTUP_SCAN: "1",
  LOP_MEMORY_DISABLE_PI_DISCOVERY: "1",
};
let web;
let supervisor;
const result = { version: 1, runRoot, webPort, internalWebPort, supervisorPort, faultPort, bridgePort, scenarios: {} };
try {
  web = spawnHidden("web-1", webEntry, commonEnv);
  await waitWeb();
  supervisor = spawnHidden("supervisor", path.join(sourceRoot, "src", "run-supervisor.mjs"), commonEnv);
  await waitFor(async () => (await jsonFetch(`http://127.0.0.1:${supervisorPort}/health`)).webReachable, "supervisor health", 30000, 200);

  async function createIdleSession() {
    const created = await jsonFetch(`http://127.0.0.1:${webPort}/api/agent/new`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workDir, type: "ensure_session", provider: "codex-bridge", modelId: "gpt-5.6-sol", thinkingLevel: "low" }),
    });
    await jsonFetch(`http://127.0.0.1:${webPort}/api/agent/${created.sessionId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "set_auto_retry", enabled: false }),
    });
    return created.sessionId;
  }
  async function sendPrompt(sessionId, marker) {
    return jsonFetch(`http://127.0.0.1:${webPort}/api/agent/${sessionId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", cwd: workDir, message: `这是隔离故障注入问答。答案固定为 ${marker}，不要调用工具。` }),
    });
  }
  async function waitTracked(sessionId) {
    const stateFile = path.join(dataRoot, "run-supervisor", "state.json");
    return waitFor(() => {
      if (!fs.existsSync(stateFile)) return false;
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return state.sessions?.[sessionId] || false;
    }, `tracked run ${sessionId}`, 15000, 100);
  }
  async function waitRecovered(sessionId, marker) {
    return waitFor(() => {
      const stateFile = path.join(dataRoot, "run-supervisor", "state.json");
      let actualSessionId = sessionId;
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const seen = new Set();
        while (state.sessions?.[actualSessionId]?.replacementSessionId && !seen.has(actualSessionId)) {
          seen.add(actualSessionId);
          actualSessionId = state.sessions[actualSessionId].replacementSessionId;
        }
      }
      const evidence = sessionEvidence(actualSessionId, marker);
      return evidence?.terminal && evidence.markerSeen ? { ...evidence, actualSessionId } : false;
    }, `terminal recovery ${sessionId}`, timeoutMs, 250);
  }
  async function waitLogicalStatus(sessionId, expected) {
    const stateFile = path.join(dataRoot, "run-supervisor", "state.json");
    return waitFor(() => {
      if (!fs.existsSync(stateFile)) return false;
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      let actual = sessionId;
      const seen = new Set();
      while (state.sessions?.[actual]?.replacementSessionId && !seen.has(actual)) {
        seen.add(actual);
        actual = state.sessions[actual].replacementSessionId;
      }
      return state.sessions?.[actual]?.status === expected ? { actualSessionId: actual, record: state.sessions[actual] } : false;
    }, `${sessionId} status ${expected}`, 15000, 200);
  }

  // Scenario 1: kill the whole Pi Web tree while the first provider request is held.
  const restartSession = await createIdleSession();
  faultMode = "hang";
  await sendPrompt(restartSession, "LIVE-RESTART-RECOVERY-PASS");
  await waitFor(() => faultEvents.some((event) => event.mode === "hang"), "held provider request", 15000, 50);
  await waitTracked(restartSession);
  const killedAt = Date.now();
  killTree(web);
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${internalWebPort}/`, { signal: AbortSignal.timeout(300) }); return false; } catch { return true; }
  }, "Pi Web process exit", 10000, 100);
  web = spawnHidden("web-2", webEntry, commonEnv);
  await waitWeb();
  const restartEvidence = await waitRecovered(restartSession, "LIVE-RESTART-RECOVERY-PASS");
  await waitLogicalStatus(restartSession, "complete");
  const restartDispatchAt = Date.parse(restartEvidence.recoveryTimestamp || "");
  result.scenarios.processRestart = {
    pass: Number.isFinite(restartDispatchAt) && restartDispatchAt - killedAt <= 15000,
    sessionId: restartSession,
    recoveryMs: restartDispatchAt - killedAt,
    terminalMs: Date.now() - killedAt,
    evidence: restartEvidence,
  };

  // Scenario 2: return a valid HTTP/SSE stream carrying an injected provider error.
  const errorSession = await createIdleSession();
  faultMode = "sse-error";
  const errorStartedAt = Date.now();
  await sendPrompt(errorSession, "LIVE-PROMPT-ERROR-RECOVERY-PASS");
  await waitFor(() => faultEvents.some((event) => event.mode === "sse-error"), "injected SSE error", 15000, 50);
  await waitTracked(errorSession);
  const errorEvidence = await waitRecovered(errorSession, "LIVE-PROMPT-ERROR-RECOVERY-PASS");
  await waitLogicalStatus(errorSession, "complete");
  const errorDispatchAt = Date.parse(errorEvidence.recoveryTimestamp || "");
  const supervisorLog = fs.readFileSync(path.join(dataRoot, "run-supervisor.log"), "utf8");
  result.scenarios.promptError = {
    pass: Number.isFinite(errorDispatchAt) && errorDispatchAt - errorStartedAt <= 15000 && /prompt-error|assistant-error|recovery-dispatched/u.test(supervisorLog),
    sessionId: errorSession,
    recoveryMs: errorDispatchAt - errorStartedAt,
    terminalMs: Date.now() - errorStartedAt,
    durableErrorEvidence: /prompt-error|assistant-error|recovery-dispatched/u.test(supervisorLog),
    evidence: errorEvidence,
  };

  const health = await jsonFetch(`http://127.0.0.1:${supervisorPort}/health`);
  result.health = health;
  result.faultHits = faultHits;
  result.elapsedMs = Date.now() - startedAt;
  result.pass = result.scenarios.processRestart.pass && result.scenarios.promptError.pass && faultHits === 2;
  fs.writeFileSync(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  killTree(web);
  killTree(supervisor);
  await new Promise((resolve) => faultServer.close(() => resolve()));
}
