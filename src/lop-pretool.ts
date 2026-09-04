// Pi 工具前确定性兼容与安全层。只在 tool_call 前运行 rules-pretool.mjs：
// 可机械修复的 Windows/Git Bash 形态原地改写；不可修复或修复失败时阻断并返回正确形态。
// 不注入提示、不调用模型、不读写目标/验收状态，也不改变 retry、compaction 或 Stop。
// 私有规则单一真值固定在本扩展同级 agent/data；缺失时 fail-open 并留一行日志。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOP_PRETOOL_RUNTIME_VERSION = "pretool-only-v2";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(MODULE_DIR, "..");
const RULE_DATA = path.join(AGENT_DIR, "data");
const RUNTIME_DATA = process.env.PI_PORTABLE_DATA || RULE_DATA;
const PRETOOL_MJS = process.env.PI_PRETOOL_MJS || path.join(RULE_DATA, "rules-pretool.mjs");
const LOG = process.env.PI_CHAIN_LOG || path.join(RUNTIME_DATA, "lop-chain.log");

function log(line: string) {
  try {
    const rendered = `[${new Date().toISOString()}] ${line}\n`;
    let bytes = 0;
    try { bytes = fs.statSync(LOG).size; } catch {}
    if (bytes > 10 * 1024 * 1024) {
      fs.rmSync(`${LOG}.3`, { force: true });
      if (fs.existsSync(`${LOG}.2`)) fs.renameSync(`${LOG}.2`, `${LOG}.3`);
      if (fs.existsSync(`${LOG}.1`)) fs.renameSync(`${LOG}.1`, `${LOG}.2`);
      fs.renameSync(LOG, `${LOG}.1`);
    }
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, rendered, "utf8");
  } catch (error) {
    console.error(`[lop-pretool-log] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default function (pi: ExtensionAPI) {
  log(`PRETOOL_ONLY loaded version=${LOP_PRETOOL_RUNTIME_VERSION} rules=${fs.existsSync(PRETOOL_MJS) ? "present" : "absent"}`);

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!fs.existsSync(PRETOOL_MJS)) {
      log(`S7 FAIL_OPEN rules-missing path=${PRETOOL_MJS}`);
      return;
    }
    try {
      const pre: any = await import(pathToFileURL(PRETOOL_MJS).href);
      const result = pre.checkPreTool({
        session_id: String(ctx?.sessionManager?.getSessionId?.() || ""),
        transcript_path: String(ctx?.sessionManager?.getSessionFile?.() || ""),
        tool_name: String(event?.toolName || ""),
        tool_input: event?.input ?? {},
      });
      const hits = Array.isArray(result) ? result : result?.hits || [];
      if (!hits.length) return;

      const allFixable = hits.every((h: any) => typeof h.fixup === "function");
      if (allFixable) {
        let input = { ...(event?.input ?? {}) };
        let failure = "";
        const notes: string[] = [];
        for (const h of hits) {
          try {
            const r = h.fixup(input);
            if (!r?.input) { failure = `${h.id}:修复器未返回输入`; break; }
            input = r.input;
            notes.push(`${h.id} → ${r.note}`);
          } catch (e) {
            failure = `${h.id}:${String(e).slice(0, 120)}`;
            break;
          }
        }
        if (failure) {
          log(`S7 FIXUP_BLOCK tool=${event?.toolName} ${failure}`);
          return { block: true, reason: `lop 工具兼容修复失败，已阻止原始错误命令执行：${failure}` };
        }
        Object.assign(event.input, input);
        log(`S7 FIXUP tool=${event?.toolName} ${notes.join("; ").slice(0, 200)}`);
        return;
      }

      log(`S7 BLOCK tool=${event?.toolName} hits=${hits.map((h: any) => h.id || h.rule || "?").join(",")}`);
      return {
        block: true,
        reason: `lop 规则红线:${hits.map((h: any) => `${h.reason || h.id || "blocked"}${h.fix ? `;正确形态:${h.fix}` : ""}`).join(" | ").slice(0, 500)}`,
      };
    } catch (e) {
      // 失败路径必留痕:门本身坏掉不得挡住用户执行。
      log(`S7 FAIL_OPEN ${String(e).slice(0, 120)}`);
    }
  });
}
