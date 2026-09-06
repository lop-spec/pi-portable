// Read back actual SDK state and loaded extension identity; never prompt a model.
// --session <existing-id> --restore may cold-restore that session using get_state only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { NEW_DOC_RULES } from "./patch-pi-native-policy.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalize = (text) => text.replace(/\r\n/g, "\n").trim();

export function evaluateRuntime(state, commands, expected) {
  const prompt = normalize(state.systemPrompt || "");
  const identity = commands.filter((c) => c.source === "extension" && /^pretool-status(?::\d+)?$/.test(c.name));
  const description = identity.length === 1 ? identity[0].description || "" : "";
  const checks = {
    documentPolicy: NEW_DOC_RULES.every((s) => prompt.includes(s)) && !prompt.includes("Always read pi .md files completely"),
    pretoolVersion: description.includes(`version=${expected.version} policy=allow-or-block`),
    rulesHash: description.includes(`rulesSha256=${expected.rulesSha256} rules=loaded`),
    agentsText: prompt.includes(normalize(expected.agents)),
  };
  const reasons = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  return { ok: reasons.length === 0, status: reasons.length ? "pending-runtime-activation" : "verified", checks, reasons, modelCalls: 0 };
}
export async function checkRuntime({ base = process.env.PIWEB_BASE || "http://127.0.0.1:30140", sessionId, restore = false,
  agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.PI_PORTABLE_DATA || ".", ".pi/agent") } = {}) {
  async function api(route, body) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(10000), ...(body ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {}) });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    const json = await response.json();
    if (json.error || json.success === false) throw new Error(`${route}: ${json.error || "failed"}`);
    return json;
  }
  if (!sessionId) sessionId = (await api("/api/agent/running")).runningSessionIds?.[0];
  if (!sessionId) return { ok: false, status: "unverified", reasons: ["no-loaded-session; first session logs runtime policy; rerun with --session <id> --restore"], modelCalls: 0 };
  let state = (await api(`/api/agent/${encodeURIComponent(sessionId)}`)).state;
  if (!state && restore) state = (await api(`/api/agent/${encodeURIComponent(sessionId)}`, { type: "get_state" })).data;
  if (!state) return { ok: false, status: "unverified", sessionId, reasons: ["session-not-loaded; use --restore explicitly"], modelCalls: 0 };
  const reply = await api(`/api/agent/${encodeURIComponent(sessionId)}`, { type: "get_commands" });
  const commands = reply.data?.commands || [];
  const source = fs.readFileSync(path.join(root, "src/lop-pretool.ts"), "utf8");
  const version = source.match(/LOP_PRETOOL_RUNTIME_VERSION\s*=\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error("Expected extension version missing in deployment source");
  const expected = { version, rulesSha256: sha(fs.readFileSync(path.join(agentDir, "data/rules-pretool.mjs"))), agents: fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8") };
  return { ...evaluateRuntime(state, commands, expected), sessionId, version, rulesSha256: expected.rulesSha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--session");
  try {
    const result = await checkRuntime({ sessionId: at >= 0 ? process.argv[at + 1] : process.env.PI_SESSION_ID, restore: process.argv.includes("--restore") });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, status: "unverified", reason: error.message, modelCalls: 0 })); process.exitCode = 1; }
}
