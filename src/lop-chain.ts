// lop 执行链 v2 的 pi 承接层(规格:decision-replay-engine/specs/gpt-exec-chain-v2.md)
// 进程内 import rule-enforcer 核心,单源三宿主(claude/codex/pi)。全步骤 fail-open。
// S2 扩写(硬门3) S3 历史召回(硬门1) S4 规则路由(硬门2) S6 对抗预审 S7 工具门 S8 落账+耗时埋点。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// [portable] 全部路径由 PI_PORTABLE_HOME(包内)与 PI_PORTABLE_DATA(数据根)派生。
// 数据面(语料/实体/账本)首启为空,可由用户自行导入;缺失时对应能力自动降级 fail-open。
const HOME = process.env.PI_PORTABLE_HOME || path.dirname(new URL(import.meta.url).pathname.slice(1));
const DATA = process.env.PI_PORTABLE_DATA || path.join(HOME, "data");
const CHAIN_DIR = path.join(HOME, "src", "chain");
const MEMORY_MJS = path.join(CHAIN_DIR, "lop-memory.mjs");
// S7 工具门规则集属私有数据面(个人环境标识密集),不随公开包分发。
// 数据根有 rules-pretool.mjs 才启用工具门,否则该步跳过(fail-open,不阻断执行)。
const PRETOOL_MJS = process.env.PI_PRETOOL_MJS || path.join(DATA, "rules-pretool.mjs");
// S6 预审:便携版走包内 8794 桥的进程内实现(见 portable-adversary.mjs),同签名同判据。
const ADVERSARY_MJS = path.join(CHAIN_DIR, "portable-adversary.mjs");
const REGISTRY_MJS = path.join(CHAIN_DIR, "rule-registry.mjs");
const CORPUS = path.join(DATA, "rules.jsonl");
const ENTITIES = path.join(DATA, "anchors.jsonl");
const METRICS = path.join(DATA, "chain-metrics.jsonl");
const LOG = path.join(DATA, "lop-chain.log");
// 画像锚点:S2 扩写的个性化底座(用户环境/高频对象),只用于召回,不进模型可见文本。
// 画像锚点:发行版默认通用集;用户可在数据根放 profile-anchors.json 覆盖(个性化召回)。
const PROFILE_ANCHORS: string[] = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, "profile-anchors.json"), "utf8")); }
  catch { return ["Windows", "配置", "部署", "排查", "验收", "常驻", "代理", "日志", "端口", "脚本"]; }
})();
const SYNONYMS: Record<string, string[]> = {
  修: ["修复", "排障", "troubleshoot", "fix"],
  查: ["检查", "核实", "验证", "排查"],
  部署: ["上线", "发布", "deploy", "常驻"],
  配置: ["config", "设置", "settings", "参数"],
  慢: ["耗时", "延迟", "卡", "性能"],
};

function log(line: string) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8"); } catch {}
}
function metric(row: Record<string, unknown>) {
  try { fs.appendFileSync(METRICS, JSON.stringify({ ts: new Date().toISOString(), host: "pi", ...row }) + "\n", "utf8"); } catch {}
}

let entitiesCache: { values: string[]; at: number } | null = null;
function loadEntities(): string[] {
  if (entitiesCache && Date.now() - entitiesCache.at < 300000) return entitiesCache.values;
  const values: string[] = [];
  try {
    for (const line of fs.readFileSync(ENTITIES, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.value === "string" && j.value.length >= 3 && (j.hits ?? 0) >= 3) values.push(j.value);
      } catch {}
    }
  } catch (e) { log(`entities load fail: ${String(e).slice(0, 120)}`); }
  entitiesCache = { values, at: Date.now() };
  return values;
}

// S2 个性化联想扩写:字符≥3×、锚点≥3×,纯本地。产物只作检索 query。
// 两个产物:forRules 只含与 prompt 词面相关的实体/同义词(硬门2:画像底座会造成
// 规则过召回,2026-08-28 冒烟实测误命中 7 条,故画像锚点仅供历史 assoc 兜底)。
function expandPrompt(prompt: string): { forRules: string; forHistory: string; anchors: number } {
  const related = new Set<string>();
  const lower = prompt.toLowerCase();
  for (const v of loadEntities()) {
    if (lower.includes(v.toLowerCase())) related.add(v);
    if (related.size >= 24) break;
  }
  for (const [k, alts] of Object.entries(SYNONYMS)) {
    if (prompt.includes(k)) for (const a of alts) related.add(a);
  }
  const forRules = [prompt, ...related].join(" ");
  const historyParts = new Set<string>(related);
  for (const a of PROFILE_ANCHORS) historyParts.add(a);
  let forHistory = [prompt, ...historyParts].join(" ");
  while (forHistory.length < prompt.length * 3) forHistory += " " + prompt; // 字符 3× 兜底
  return { forRules, forHistory, anchors: historyParts.size };
}

export default function (pi: ExtensionAPI) {
  const sessionId = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lastPrompt = "";
  let lastPhase: Record<string, unknown> = {};
  // S6 打回轮标记:等价 Claude 侧 stop_hook_active,防预审递归打回。
  let advRedelivery = false;
  let advDeliveredTurn = false; // 本轮已投递过预审 context,防每次 tool_call 重复注入

  pi.on("before_agent_start", async (event: any) => {
    const prompt = String(event?.prompt || "");
    if (!prompt) return;
    if (advRedelivery) { log("S6 REDELIVERY TURN skip inject"); return; }
    advDeliveredTurn = false;
    lastPrompt = prompt;
    const contexts: string[] = [];
    const phase: Record<string, unknown> = {};

    // S2 扩写(硬门3)
    let expanded = { forRules: prompt, forHistory: prompt, anchors: 0 };
    const t2 = performance.now();
    try { expanded = expandPrompt(prompt); } catch (e) { log(`S2 FAIL_OPEN ${String(e).slice(0, 120)}`); }
    phase.s2Ms = +(performance.now() - t2).toFixed(1);
    phase.s2Anchors = expanded.anchors;
    phase.s2Chars = expanded.forHistory.length;

    // S4 规则路由(硬门2):原 prompt ∪ 扩写 query,记录扩写增量
    const t4 = performance.now();
    try {
      const reg: any = await import(pathToFileURL(REGISTRY_MJS).href);
      const registry = reg.loadRuleRegistry(CORPUS);
      const base = reg.matchRules(registry.rules, prompt).filter((h: any) => !h.rule.alwaysOn.length);
      const ext = reg.matchRules(registry.rules, expanded.forRules).filter((h: any) => !h.rule.alwaysOn.length);
      const ids = new Set(base.map((h: any) => h.rule.id));
      const extra = ext.filter((h: any) => !ids.has(h.rule.id));
      const all = [...base, ...extra];
      phase.s4Live = all.map((h: any) => h.rule.id);
      phase.s4FromExpansion = extra.map((h: any) => h.rule.id);
      if (all.length) {
        const lines = [
          '<rules-resolved source="rules-corpus" host="pi">',
          "以下是本轮确定性命中的规则;它们是规则而非历史数据。只读取命中项明确指向的Rule/Skill,禁止扩展为全量规则加载。",
          ...all.slice(0, 16).map((h: any) => `- [${h.rule.id}] ${String(h.rule.text || h.rule.summary || "").slice(0, 500)}`),
          "</rules-resolved>",
        ];
        contexts.push(lines.join("\n"));
      }
    } catch (e) { log(`S4 FAIL_OPEN ${String(e).slice(0, 160)}`); }
    phase.s4Ms = +(performance.now() - t4).toFixed(1);

    // S3 历史召回(硬门1):原 prompt 先查(exact 语义),miss 才用扩写 query 兜 assoc。
    // R5 修正:resolveHistory 内部是同步 sqlite,"并行"双查在单线程实际串行,
    // 反让 hit 路白吃扩写查询成本(R1 hit 137ms→R3 337ms 回归实测)。扩写查询惰性化。
    const t3 = performance.now();
    try {
      const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
      const opts = { sessionId, turnId: "", refresh: false, maxFullChars: 800 };
      const r1 = await mem.resolveHistory(prompt, opts);
      let resolved = r1;
      let viaExpansion = false;
      if (!r1?.hit && expanded.forHistory !== prompt) {
        const r2 = await mem.resolveHistory(expanded.forHistory, opts).catch(() => null);
        if (r2?.hit) { resolved = r2; viaExpansion = true; }
      }
      phase.s3Hit = Boolean(resolved?.hit);
      phase.s3Mode = resolved?.mode || "-";
      phase.s3Reason = resolved?.reason || "-";
      phase.s3ViaExpansion = viaExpansion;
      phase.s3Token = resolved?.usageToken || "";
      const context = mem.renderResolvedHistory(resolved);
      if (context) contexts.push(context);
    } catch (e) { log(`S3 FAIL_OPEN ${String(e).slice(0, 160)}`); }
    phase.s3Ms = +(performance.now() - t3).toFixed(1);

    // S6 后台对抗预审起审:detached 子进程(windowsHide),agent_end 消费,fail-open
    const t6 = performance.now();
    try {
      const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
      const started = adv.startBackgroundReview({ session_id: sessionId, prompt });
      phase.s6Start = started?.status || "-";
    } catch (e) { log(`S6 FAIL_OPEN ${String(e).slice(0, 120)}`); }
    phase.s6Ms = +(performance.now() - t6).toFixed(1);

    lastPhase = phase;
    log(`INJECT s2=${phase.s2Ms}ms s3=${phase.s3Ms}ms(hit=${phase.s3Hit},exp=${phase.s3ViaExpansion}) s4=${phase.s4Ms}ms(rules=${(phase.s4Live as string[])?.length || 0}+${(phase.s4FromExpansion as string[])?.length || 0}exp) bytes=${Buffer.byteLength(contexts.join("\n\n"))}`);
    if (!contexts.length) return;
    return {
      message: { customType: "lop-chain", content: contexts.join("\n\n"), display: false },
    };
  });

  // S7 工具红线:复用 rules-pretool;S6 预审就绪则执行阶段早投递(防长任务超 TTL)
  pi.on("tool_call", async (event: any) => {
    if (!advRedelivery && !advDeliveredTurn) {
      try {
        const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
        const claimed = adv.claimBackgroundReview({ session_id: sessionId });
        if (claimed?.status === "ready" && claimed.context) {
          advDeliveredTurn = true;
          pi.sendMessage(
            { customType: "lop-adversary", content: claimed.context, display: false },
            { deliverAs: "steer", triggerTurn: false },
          );
          log("S6 DELIVERED pretool");
        }
      } catch (e) { log(`S6 CLAIM FAIL_OPEN ${String(e).slice(0, 120)}`); }
    }
    try {
      const pre: any = await import(pathToFileURL(PRETOOL_MJS).href);
      const result = pre.checkPreTool({
        session_id: sessionId,
        tool_name: String(event?.toolName || ""),
        tool_input: event?.input ?? {},
      });
      const hits = Array.isArray(result) ? result : result?.hits || [];
      if (hits.length) {
        log(`S7 BLOCK tool=${event?.toolName} hits=${hits.map((h: any) => h.id || h.rule || "?").join(",")}`);
        return { block: true, reason: `lop 规则红线:${hits.map((h: any) => h.reason || h.id || "blocked").join("; ").slice(0, 300)}` };
      }
    } catch (e) { log(`S7 FAIL_OPEN ${String(e).slice(0, 120)}`); }
  });

  // S8 完成态落账 + 全链耗时落 metrics;S6 预审消费在落账前(block 则打回一轮,不落账)
  pi.on("agent_end", async (event: any) => {
    if (advRedelivery) {
      // 打回轮收尾:重置标记,顺带 consume 触发 envelope cleanup(已投递态返回 pass)
      advRedelivery = false;
      try {
        const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
        adv.consumeBackgroundReview({ session_id: sessionId });
      } catch {}
    } else {
      try {
        const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
        const review = adv.consumeBackgroundReview({ session_id: sessionId });
        if (review?.status === "block") {
          advRedelivery = true;
          log(`S6 BLOCK ${String(review.reason || "").slice(0, 160)}`);
          metric({ sessionId, prompt: lastPrompt.slice(0, 160), ...lastPhase, s6Block: true });
          pi.sendUserMessage(
            `Stop hook feedback:\n${review.reason}\n\n${review.body || ""}`,
            { deliverAs: "followUp" },
          );
          return;
        }
        if (review?.status && review.status !== "skip") log(`S6 ${review.status} ${String(review.reason || "").slice(0, 120)}`);
      } catch (e) { log(`S6 FAIL_OPEN ${String(e).slice(0, 120)}`); }
    }
    const t8 = performance.now();
    try {
      const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
      const lastAssistant = [...msgs].reverse().find((m) => m?.role === "assistant");
      const text = Array.isArray(lastAssistant?.content)
        ? lastAssistant.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
        : String(lastAssistant?.content || "");
      if (lastPrompt && text) {
        const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
        const saved = await mem.recordStop({
          session_id: sessionId,
          turn_id: "",
          prompt: lastPrompt,
          last_assistant_message: text,
          transcript_path: "",
        });
        log(`S8 STOP ${saved?.added ? "ADDED" : saved?.skipped ? "SKIP:" + (saved?.reason || "") : "UPDATED"}`);
      }
    } catch (e) { log(`S8 FAIL_OPEN ${String(e).slice(0, 160)}`); }
    metric({ sessionId, prompt: lastPrompt.slice(0, 160), ...lastPhase, s8Ms: +(performance.now() - t8).toFixed(1) });
    lastPhase = {};
  });
}
