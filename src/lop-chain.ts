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

const COMPLETION_GUARD_TYPE = "lop-completion-guard";
const TURN_SCOPED_CUSTOM_TYPES = new Set(["lop-chain", COMPLETION_GUARD_TYPE]);
const INDEPENDENT_HISTORY_ANCHOR = /(?:[A-Za-z]:[\\/]|https?:\/\/|\b\d{2,}\b|\b[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|jsonl?|toml|ya?ml|md|sql|py|ps1|exe|dll)\b)/iu;
const CONTEXT_ONLY_PROMPT = /^(?:继续(?:吧|做|处理|执行|下去|做下去)?|确认(?:一下)?|好(?:的)?|可以|行|是(?:的)?|对|没问题|开始|照办|重试|再试(?:一次)?|(?:按|照)(?:这个|上面|前面|刚才的?)(?:做|处理|执行|修改)?|(?:具体)?(?:怎么|如何)改(?:[，,\s]*(?:说明白|说清楚))?|说明白|说清楚|再说一遍|什么意思|(?:其余|剩下)(?:的)?都做)$/u;
const CONTEXT_REFERENCE = /(?:这个|那个|这些|那些|上面|前面|刚才|其余|剩下|第\s*\d+\s*项|不做\s*\d+)/u;
const EXECUTION_ACTION = /(?:看下|看一下|查下|查一下|检查|查看|排查|定位|修复|修改|改|执行|运行|部署|安装|更新|提交|推送|上传|下载|验证|测试|创建|删除|迁移|接入|配置|重启|停止|启动|处理|完成|落地|做)/u;
const EXPLANATION_REQUEST = /(?:怎么|如何|为什么|是什么|有什么|有哪些|有没有|能否|是否|可不可以|推荐|说明|解释|原理|方案|区别)/u;
const DIRECT_EXECUTION = /(?:直接|帮我|请你|给我|都做|做完|改好|修好|落地|执行|运行|部署|上传|提交|推送)/u;
const FUTURE_ACTION_COMMITMENT = /(?:接下来|下一步|然后|随后|现在)?\s*(?:我会|我将|我先|我接着|我继续|将会)\s*(?:直接|先|继续)?[\s\S]{0,24}(?:读取|检查|查看|排查|定位|修复|修改|执行|运行|验证|测试|部署|安装|提交|推送|上传|连接|打开|搜索|处理)/u;
const EXPLICIT_BLOCKER = /(?:需要你|请(?:你)?(?:提供|确认|回复|授权|登录|打开|选择)|等待(?:你|用户)|缺少(?:权限|凭据|信息|参数)|无法(?:安全)?(?:继续|访问|连接|执行|读取|写入|调用)|被阻塞|需要授权|未提供(?:权限|凭据|信息|参数)|(?:工具|调用|执行)(?:通道|层)?(?:异常|不可用|被拦截)|(?:当前会话|本轮).{0,24}(?:没有|未暴露|缺少).{0,24}(?:工具|通道|权限))/u;
const COMPLETION_EVIDENCE = /(?:已(?:完成|修复|修改|执行|运行|验证|部署|安装|提交|推送|上传|处理|落地)|(?:测试|验证)(?:已经)?通过|结果如下|修改如下|代码如下)/u;

export function isContextDependentHistoryPrompt(value: unknown): boolean {
  const text = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim()
    .replace(/[。！!？?；;，,\s]+$/gu, "");
  if (!text || INDEPENDENT_HISTORY_ANCHOR.test(text)) return false;
  if (CONTEXT_ONLY_PROMPT.test(text) || /^(?:继续|确认)/u.test(text)) return true;
  return [...text].length <= 48 && CONTEXT_REFERENCE.test(text);
}

function stripTurnScopedBlocks(value: unknown): string {
  return String(value || "")
    .replace(/<(history-resolved|rules-resolved)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<\/?(?:history-resolved|rules-resolved)\b[^>]*>/giu, "")
    .trim();
}

export function scopeLopChainContext(messages: any[]): any[] {
  const source = Array.isArray(messages) ? messages : [];
  let latestUser = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index]?.role === "user") latestUser = index;
  }
  if (latestUser < 0) return source;
  const scoped = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (index < latestUser && message?.role === "custom" &&
        TURN_SCOPED_CUSTOM_TYPES.has(String(message?.customType || ""))) continue;
    if (index < latestUser && ["compactionSummary", "branchSummary"].includes(message?.role)) {
      const summary = stripTurnScopedBlocks(message?.summary);
      scoped.push(summary === String(message?.summary || "") ? message : { ...message, summary });
    } else {
      scoped.push(message);
    }
  }
  return scoped;
}

function isExecutionRequest(value: unknown): boolean {
  const text = String(value || "").normalize("NFKC");
  return EXECUTION_ACTION.test(text) && (!EXPLANATION_REQUEST.test(text) || DIRECT_EXECUTION.test(text));
}

export function completionGuardDecision(input: {
  prompt?: unknown;
  assistantText?: unknown;
  stopReason?: unknown;
  runHadTool?: boolean;
  pendingMessages?: boolean;
  alreadyQueued?: boolean;
}): { trigger: boolean; reason: string } {
  const prompt = String(input?.prompt || "");
  const assistantText = String(input?.assistantText || "");
  if (input?.stopReason !== "stop") return { trigger: false, reason: "not-stop" };
  if (input?.runHadTool) return { trigger: false, reason: "tool-used" };
  if (input?.pendingMessages) return { trigger: false, reason: "pending-messages" };
  if (input?.alreadyQueued) return { trigger: false, reason: "already-queued" };
  if (!isExecutionRequest(prompt)) return { trigger: false, reason: "not-execution-request" };
  if (!FUTURE_ACTION_COMMITMENT.test(assistantText)) return { trigger: false, reason: "no-future-commitment" };
  if (EXPLICIT_BLOCKER.test(assistantText)) return { trigger: false, reason: "explicit-blocker" };
  if (COMPLETION_EVIDENCE.test(assistantText)) return { trigger: false, reason: "completion-evidence" };
  return { trigger: true, reason: "future-commitment-without-execution" };
}

export function completionGuardAlreadyQueued(entries: any[]): boolean {
  const branch = Array.isArray(entries) ? entries : [];
  let latestUser = -1;
  for (let index = 0; index < branch.length; index += 1) {
    if (branch[index]?.type === "message" && branch[index]?.message?.role === "user") latestUser = index;
  }
  if (latestUser < 0) return false;
  return branch.slice(latestUser + 1).some((entry) =>
    (entry?.type === "custom_message" && entry?.customType === COMPLETION_GUARD_TYPE) ||
    (entry?.type === "message" && entry?.message?.role === "custom" &&
      entry?.message?.customType === COMPLETION_GUARD_TYPE)
  );
}

function latestUserTurn(entries: any[]): { id: string; text: string } {
  const branch = Array.isArray(entries) ? entries : [];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry?.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
      : String(content || "");
    return { id: String(entry.id || ""), text };
  }
  return { id: "", text: "" };
}

function assistantText(message: any): string {
  return Array.isArray(message?.content)
    ? message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
    : String(message?.content || "");
}

export default function (pi: ExtensionAPI) {
  const sessionId = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lastPrompt = "";
  let lastPhase: Record<string, unknown> = {};
  let runHadTool = false;
  // S6 打回轮标记:等价 Claude 侧 stop_hook_active,防预审递归打回。
  let advRedelivery = false;
  let advDeliveredTurn = false; // 本轮已投递过预审 context,防每次 tool_call 重复注入

  pi.on("context", (event: any, ctx: any) => {
    const original = Array.isArray(event?.messages) ? event.messages : [];
    let messages = scopeLopChainContext(original);
    const removed = original.length - messages.length;
    const sanitized = messages.filter((message) =>
      ["compactionSummary", "branchSummary"].includes(message?.role) && !original.includes(message)
    ).length;
    if (removed || sanitized) log(`CONTEXT removed=${removed} sanitizedSummary=${sanitized}`);
    try {
      if (!trimActive) {
        const tokens = ctx?.getContextUsage?.()?.tokens;
        if (typeof tokens === "number" && tokens > COMPACT_TRIGGER_TOKENS) {
          trimActive = true;
          log(`COMPACT_GUARD activate tokens=${tokens} threshold=${COMPACT_TRIGGER_TOKENS}`);
        }
      }
      if (trimActive) {
        const r = microcompact(messages);
        if (r.trimmed) messages = r.messages;
        if (r.trimmed !== lastTrimCount) {
          lastTrimCount = r.trimmed;
          log(`COMPACT_GUARD trim n=${r.trimmed} tok≈${r.beforeTok}->${r.afterTok} keep=${TRIM_KEEP_RECENT_TOKENS}`);
          metric({ sessionId, compactGuard: true, trimCount: r.trimmed, trimBeforeTok: r.beforeTok, trimAfterTok: r.afterTok });
        }
      }
    } catch (e) { log(`COMPACT_GUARD FAIL_OPEN ${String(e).slice(0, 120)}`); }
    return { messages };
  });

  pi.on("agent_start", () => { runHadTool = false; });
  pi.on("tool_execution_start", () => { runHadTool = true; });

  // 循环内上下文水位门(microcompact):pi 原生阈值压缩只在 run 结束/新 prompt 前检查
  // (_checkCompaction 仅两个调用点),单条消息的长工具循环里上下文无界膨胀(2026-08-29 实测
  // 超调至 45.1 万 tok,≥20万 tok 时每轮 TTFB/流时长 2-3×);而 ctx.compact() 的 manual 路
  // 首行 await this.abort() 会掐死在途 run,不可用于循环内。故采用 Claude 壳 microcompact 同款:
  // 真实用量超水位后,仅对发往上游的载荷把"尾部保留预算之外的旧工具结果"替换为占位符——
  // 会话文件不动、不 abort、无额外 LLM 调用;裁剪单调(旧的永远保持裁剪态)保上游前缀缓存;
  // 粘性开关防"裁→用量回落→停裁→再膨胀"振荡,原生压缩(session_compact)发生时复位。fail-open。
  const COMPACT_TRIGGER_TOKENS = Number(process.env.LOP_COMPACT_TRIGGER_TOKENS || 250000);
  const TRIM_KEEP_RECENT_TOKENS = Number(process.env.LOP_TRIM_KEEP_TOKENS || 50000);
  const TRIM_MIN_CHARS = 600;
  const TRIM_MARK = "[lop-compact-guard 已裁剪";
  let trimActive = false;
  let lastTrimCount = -1;

  function estimateContentChars(content: any): number {
    if (typeof content === "string") return content.length;
    if (!Array.isArray(content)) return 0;
    let chars = 0;
    for (const b of content) {
      if (b?.type === "text") chars += String(b.text || "").length;
      else if (b?.type === "image") chars += 4800;
    }
    return chars;
  }
  function estimateMessageTokens(m: any): number {
    if (!m) return 0;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      let chars = 0;
      for (const b of m.content) {
        if (b?.type === "text") chars += String(b.text || "").length;
        else if (b?.type === "thinking") chars += String(b.thinking || "").length;
        else if (b?.type === "toolCall") chars += String(b.name || "").length + JSON.stringify(b.arguments ?? {}).length;
      }
      return Math.ceil(chars / 4);
    }
    if (m.role === "bashExecution") return Math.ceil((String(m.command || "").length + String(m.output || "").length) / 4);
    if (m.role === "branchSummary" || m.role === "compactionSummary") return Math.ceil(String(m.summary || "").length / 4);
    return Math.ceil(estimateContentChars(m.content) / 4);
  }
  function isTrimmedResult(content: any): boolean {
    if (typeof content === "string") return content.startsWith(TRIM_MARK);
    return Array.isArray(content) && content.length === 1 && content[0]?.type === "text" &&
      String(content[0].text || "").startsWith(TRIM_MARK);
  }
  function microcompact(messages: any[]): { messages: any[]; trimmed: number; beforeTok: number; afterTok: number } {
    const est = messages.map(estimateMessageTokens);
    const beforeTok = est.reduce((a, b) => a + b, 0);
    let keepFrom = messages.length;
    let acc = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      acc += est[i];
      keepFrom = i;
      if (acc >= TRIM_KEEP_RECENT_TOKENS) break;
    }
    let trimmed = 0;
    let saved = 0;
    const out = messages.slice();
    for (let i = 0; i < keepFrom; i += 1) {
      const m = out[i];
      if (m?.role !== "toolResult" || isTrimmedResult(m.content)) continue;
      const chars = estimateContentChars(m.content);
      if (chars < TRIM_MIN_CHARS) continue;
      const text = `${TRIM_MARK} ~${chars} 字符的工具结果:上下文超水位。若仍需要该内容,用工具重新获取。]`;
      out[i] = { ...m, content: typeof m.content === "string" ? text : [{ type: "text", text }] };
      trimmed += 1;
      saved += est[i];
    }
    return { messages: out, trimmed, beforeTok, afterTok: beforeTok - saved };
  }
  pi.on("session_compact", () => { trimActive = false; lastTrimCount = -1; });

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
    if (isContextDependentHistoryPrompt(prompt)) {
      phase.s3Hit = false;
      phase.s3Mode = "-";
      phase.s3Reason = "context-dependent-prompt";
      phase.s3ViaExpansion = false;
      phase.s3Token = "";
    } else {
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
    }
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
    log(`INJECT s2=${phase.s2Ms}ms s3=${phase.s3Ms}ms(hit=${phase.s3Hit},exp=${phase.s3ViaExpansion},reason=${phase.s3Reason}) s4=${phase.s4Ms}ms(rules=${(phase.s4Live as string[])?.length || 0}+${(phase.s4FromExpansion as string[])?.length || 0}exp) bytes=${Buffer.byteLength(contexts.join("\n\n"))}`);
    if (!contexts.length) return;
    return {
      message: { customType: "lop-chain", content: contexts.join("\n\n"), display: false },
    };
  });

  // S7 工具红线:复用 rules-pretool;S6 预审就绪则执行阶段早投递(防长任务超 TTL)
  pi.on("tool_call", async (event: any) => {
    runHadTool = true;
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
        // 与 Claude 侧 index.mjs 同语义:全部可 fixup → 链式改写后放行(pi API 约定 event.input 原地可变);
        // 任一 fixup 改不动 → 放行原样(fail-open,同 Claude);存在不可修 hit → block。
        // 2026-08-29 前这里无 fixup 路——pi 侧 heredoc 自伤因此全部漏网(62 错复盘)。
        const allFixable = hits.every((h: any) => typeof h.fixup === "function");
        if (allFixable) {
          let input = { ...(event?.input ?? {}) };
          let ok = true;
          const notes: string[] = [];
          for (const h of hits) {
            try {
              const r = h.fixup(input);
              if (!r?.input) { ok = false; break; }
              input = r.input;
              notes.push(`${h.id} → ${r.note}`);
            } catch (e) { log(`S7 FIXUP_FAIL ${h.id} ${String(e).slice(0, 120)}`); ok = false; break; }
          }
          if (ok) {
            Object.assign(event.input, input);
            log(`S7 FIXUP tool=${event?.toolName} ${notes.join("; ").slice(0, 200)}`);
          }
          return;
        }
        log(`S7 BLOCK tool=${event?.toolName} hits=${hits.map((h: any) => h.id || h.rule || "?").join(",")}`);
        return { block: true, reason: `lop 规则红线:${hits.map((h: any) => `${h.reason || h.id || "blocked"}${h.fix ? `;正确形态:${h.fix}` : ""}`).join(" | ").slice(0, 500)}` };
      }
    } catch (e) { log(`S7 FAIL_OPEN ${String(e).slice(0, 120)}`); }
  });

  // S8 完成态落账 + 全链耗时落 metrics;S6 预审消费在落账前(block 则打回一轮,不落账)
  pi.on("agent_end", async (event: any, ctx: any) => {
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
    const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const lastAssistant = [...msgs].reverse().find((message) => message?.role === "assistant");
    const text = assistantText(lastAssistant);
    let branch: any[] = [];
    try { branch = ctx?.sessionManager?.getBranch?.() || []; } catch {}
    const userTurn = latestUserTurn(branch);
    const prompt = lastPrompt || userTurn.text;
    const guard = completionGuardDecision({
      prompt,
      assistantText: text,
      stopReason: lastAssistant?.stopReason,
      runHadTool,
      pendingMessages: Boolean(ctx?.hasPendingMessages?.()),
      alreadyQueued: completionGuardAlreadyQueued(branch),
    });
    if (guard.trigger) {
      lastPhase = { ...lastPhase, completionGuard: true };
      log(`COMPLETION_GUARD retry=1/1 userEntry=${userTurn.id || "-"} reason=${guard.reason}`);
      metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase });
      try {
        pi.sendMessage({
          customType: COMPLETION_GUARD_TYPE,
          content: "上一条回复只承诺了后续动作，但尚无工具调用或完成证据。不要再复述计划；立即调用必要工具完成原始用户任务。若确实无法继续，只报告可验证的阻塞原因和缺少的信息。",
          display: false,
          details: { userEntryId: userTurn.id, reason: guard.reason, retry: 1 },
        }, { deliverAs: "followUp", triggerTurn: true });
      } catch (e) {
        log(`COMPLETION_GUARD FAIL_OPEN ${String(e).slice(0, 160)}`);
        lastPhase = {};
      }
      return;
    }

    const t8 = performance.now();
    try {
      if (prompt && text) {
        const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
        const saved = await mem.recordStop({
          session_id: sessionId,
          turn_id: "",
          prompt,
          last_assistant_message: text,
          transcript_path: "",
        });
        log(`S8 STOP ${saved?.added ? "ADDED" : saved?.skipped ? "SKIP:" + (saved?.reason || "") : "UPDATED"}`);
      }
    } catch (e) { log(`S8 FAIL_OPEN ${String(e).slice(0, 160)}`); }
    metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, s8Ms: +(performance.now() - t8).toFixed(1) });
    lastPhase = {};
  });
}
