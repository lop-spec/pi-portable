// Pi 工具前安全检查：只允许或拒绝，不改写参数、不生成脚本、不代做备份。
// 普通执行走 Pi 原生工具；不注入消息、不调用模型、不改变结果、Stop、retry 或 compaction。
// 私有规则的单一真值在 agent/data；沿用缺失/异常时 fail-open，并无条件记录原因。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOP_PRETOOL_RUNTIME_VERSION = "pretool-only-v4";
const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULE_DATA = path.join(AGENT_DIR, "data");
const PRETOOL_MJS = process.env.PI_PRETOOL_MJS || path.join(RULE_DATA, "rules-pretool.mjs");
const LOG = process.env.PI_PRETOOL_LOG || path.join(process.env.PI_PORTABLE_DATA || RULE_DATA, "lop-pretool.log");
const oneLine = (value: unknown) => String(value).replace(/[\r\n]/g, " ").slice(0, 200);

function log(line: string) {
  try {
    let bytes = 0;
    try { bytes = fs.statSync(LOG).size; } catch {}
    if (bytes > 10 * 1024 * 1024) {
      fs.rmSync(`${LOG}.3`, { force: true });
      if (fs.existsSync(`${LOG}.2`)) fs.renameSync(`${LOG}.2`, `${LOG}.3`);
      if (fs.existsSync(`${LOG}.1`)) fs.renameSync(`${LOG}.1`, `${LOG}.2`);
      fs.renameSync(LOG, `${LOG}.1`);
    }
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch (error) {
    console.error(`[lop-pretool-log] ${oneLine(error)}`);
  }
}

export default async function (pi: ExtensionAPI) {
  let pre: any;
  let rulesSha256 = "unavailable";
  let unavailable = "";
  try {
    rulesSha256 = crypto.createHash("sha256").update(fs.readFileSync(PRETOOL_MJS)).digest("hex");
    // Reload sees the new module without reusing an old ESM cache entry; unchanged bytes share one import.
    pre = await import(`${pathToFileURL(PRETOOL_MJS).href}?sha256=${rulesSha256}`);
    if (typeof pre.checkPreTool !== "function") throw new Error("rules-module-missing-checkPreTool");
  } catch (error) {
    unavailable = oneLine(error);
    log(`S7 FAIL_OPEN rules-unavailable reason=${unavailable}`);
  }
  const identity = `version=${LOP_PRETOOL_RUNTIME_VERSION} policy=allow-or-block rulesSha256=${rulesSha256} rules=${unavailable ? "unavailable" : "loaded"}`;
  log(`PRETOOL_ONLY loaded ${identity}`);
  // get_commands exposes the loaded identity without a model request, a new tool, or per-turn polling.
  pi.registerCommand("pretool-status", {
    description: identity,
    handler: async (_args, ctx) => { ctx.ui.notify(identity, unavailable ? "warning" : "info"); },
  });

  pi.on("session_start", (_event, ctx) => {
    const prompt = ctx.getSystemPrompt();
    const pending = prompt.includes("Always read pi .md files completely") || !prompt.includes("Full-file reading and exhaustive link traversal are not required");
    log(`RUNTIME_POLICY session=${oneLine(ctx.sessionManager.getSessionId())} ${identity} prompt=${pending ? "pending-activation-or-custom-prompt" : "on-demand"} promptSha256=${crypto.createHash("sha256").update(prompt).digest("hex")}`);
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const call = `session=${oneLine(ctx.sessionManager.getSessionId() || "ephemeral")} call=${oneLine(event.toolCallId || "unknown")} tool=${oneLine(event.toolName)}`;
    if (unavailable) { log(`S7 FAIL_OPEN ${call} reason=${unavailable}`); return; }
    try {
      const hits = pre.checkPreTool({
        session_id: ctx.sessionManager.getSessionId() || "",
        transcript_path: ctx.sessionManager.getSessionFile() || "",
        tool_name: event.toolName,
        // Rule predicates must not be able to mutate the real execution arguments.
        tool_input: structuredClone(event.input ?? {}),
      });
      if (hits === null || (Array.isArray(hits) && hits.length === 0)) return;
      if (!Array.isArray(hits)) throw new Error("invalid-rule-result");
      log(`S7 BLOCK ${call} hits=${hits.map((h: any) => oneLine(h.id)).join(",")}`);
      return {
        block: true,
        reason: `lop 安全检查拒绝执行（未改写命令）:${hits.map((h: any) => `${h.reason || h.id}${h.fix ? `;${h.fix}` : ""}`).join(" | ").slice(0, 700)}`,
      };
    } catch (error) {
      log(`S7 FAIL_OPEN ${call} reason=${oneLine(error)}`);
    }
  });
}
