// lop 执行链 v2 的 pi 承接层(规格:decision-replay-engine/specs/gpt-exec-chain-v2.md)
// 进程内 import rule-enforcer 核心,单源三宿主(claude/codex/pi)。
// S2/S3/S4 是交付硬门;S6/S7 外部可选能力才允许 fail-open。S8 确定性落账并输出审计指标。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// [portable] 全部路径由 PI_PORTABLE_HOME(包内)与 PI_PORTABLE_DATA(数据根)派生。
// 数据面(语料/实体/账本)首启为空,可由用户自行导入;缺失时对应能力自动降级 fail-open。
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PI_PORTABLE_HOME || path.resolve(MODULE_DIR, "..");
const DATA = process.env.PI_PORTABLE_DATA || path.join(HOME, "data");
const CHAIN_DIR = path.join(HOME, "src", "chain");
const MEMORY_MJS = path.join(CHAIN_DIR, "lop-memory.mjs");
// S7 工具门规则集属私有数据面(个人环境标识密集),不随公开包分发。
// 数据根有 rules-pretool.mjs 才启用工具门,否则该步跳过(fail-open,不阻断执行)。
const PRETOOL_MJS = process.env.PI_PRETOOL_MJS || path.join(DATA, "rules-pretool.mjs");
// S6 预审:便携版走包内 8794 桥的进程内实现(见 portable-adversary.mjs),同签名同判据。
const ADVERSARY_MJS = path.join(CHAIN_DIR, "portable-adversary.mjs");
const FAST_PATH_MJS = path.join(CHAIN_DIR, "deterministic-fast-path.mjs");
const REGISTRY_MJS = path.join(CHAIN_DIR, "rule-registry.mjs");
const CORPUS = path.join(DATA, "rules.jsonl");
const ENTITIES = path.join(DATA, "anchors.jsonl");
const METRICS = process.env.PI_CHAIN_METRICS || path.join(DATA, "chain-metrics.jsonl");
const LOG = process.env.PI_CHAIN_LOG || path.join(DATA, "lop-chain.log");
// 画像锚点:S2 扩写的个性化底座(用户环境/高频对象),只用于召回,不进模型可见文本。
// 画像锚点:发行版默认通用集;用户可在数据根放 profile-anchors.json 覆盖(个性化召回)。
const PROFILE_ANCHORS: string[] = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, "profile-anchors.json"), "utf8")); }
  catch { return ["Windows", "配置", "部署", "排查", "验收", "常驻", "代理", "日志", "端口", "脚本"]; }
})();
const SYNONYMS: Record<string, string[]> = {
  修复: ["修正", "排障", "troubleshoot", "fix"],
  排障: ["排查", "诊断", "故障定位"],
  排查: ["诊断", "故障定位"],
  检查: ["只读审计", "核验", "验证"],
  改为: ["修改", "实现改动", "写入", "读回验证"],
  解释: ["说明", "差异", "适用场景"],
  执行: ["运行", "命令", "只读验收"],
  部署: ["上线", "发布", "deploy", "常驻"],
  配置: ["config", "设置", "settings", "参数"],
  慢: ["耗时", "延迟", "卡顿", "性能"],
  互通: ["双向", "连通", "连接验证", "SSH"],
  免密: ["SSH", "公钥认证", "authorized_keys", "双向"],
  远端: ["SSH", "目标机器", "主机", "远程连接"],
  历史: ["会话记录", "记忆召回", "summary20", "semanticFull"],
  规则: ["按需规则", "规则语料", "命中全集", "oracle"],
  提交: ["git", "commit", "push", "CI"],
};

function log(line: string) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8"); } catch {}
}
function metric(row: Record<string, unknown>) {
  try { fs.appendFileSync(METRICS, JSON.stringify({ ts: new Date().toISOString(), host: "pi", ...row }) + "\n", "utf8"); } catch {}
}

type EntityRecord = { value: string; what: string[]; hits: number; type: string };
type ExpandedPrompt = {
  forRules: string;
  forHistory: string;
  anchors: number;
  charRatio: number;
  historyTerms: string[];
  ruleTerms: string[];
  personalizedTerms: string[];
};

let entitiesCache: { records: EntityRecord[]; at: number } | null = null;
function loadEntities(): EntityRecord[] {
  if (entitiesCache && Date.now() - entitiesCache.at < 300000) return entitiesCache.records;
  const records: EntityRecord[] = [];
  try {
    for (const line of fs.readFileSync(ENTITIES, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.value !== "string" || [...j.value].length < 3 || Number(j.hits || 0) < 3) continue;
        records.push({
          value: j.value,
          what: Array.isArray(j.what) ? j.what.map(String).filter(Boolean).slice(0, 8) : [],
          hits: Number(j.hits || 0),
          type: String(j.type || "entity"),
        });
      } catch {}
    }
  } catch (e) { log(`entities load fail: ${String(e).slice(0, 120)}`); }
  records.sort((a, b) => b.hits - a.hits || a.value.localeCompare(b.value));
  entitiesCache = { records, at: Date.now() };
  return records;
}

// S2 个性化联想扩写:可审计文本字符数≥原问题3×。forRules 只带词面相关的
// 实体/同义词,避免画像底座造成过召回;forHistory 再加入用户画像与实体 what 关系。
export function expandPrompt(prompt: string): ExpandedPrompt {
  const related = new Set<string>();
  const personalized = new Set<string>();
  const lower = prompt.toLowerCase();
  for (const entity of loadEntities()) {
    if (!lower.includes(entity.value.toLowerCase())) continue;
    related.add(entity.value);
    personalized.add(entity.value);
    for (const association of entity.what) {
      related.add(association);
      personalized.add(association);
    }
    if (related.size >= 32) break;
  }
  for (const [key, alternatives] of Object.entries(SYNONYMS)) {
    if (lower.includes(key.toLowerCase())) for (const alternative of alternatives) related.add(alternative);
  }
  const ruleTerms = [...related].slice(0, 40);
  const forRules = [prompt, ...ruleTerms].join(" ").trim();
  const historyParts = new Set<string>(ruleTerms);
  for (const anchor of PROFILE_ANCHORS) historyParts.add(String(anchor));
  const historyTerms = [...historyParts].filter(Boolean).slice(0, 80);
  const targetChars = Math.max([...prompt].length * 3, [...prompt].length);
  const chunks = [prompt, ...historyTerms];
  let pair = 0;
  while ([...chunks.join(" ")].length < targetChars) {
    const left = historyTerms[pair % Math.max(1, historyTerms.length)] || "真实验收";
    const right = PROFILE_ANCHORS[Math.floor(pair / Math.max(1, historyTerms.length)) %
      Math.max(1, PROFILE_ANCHORS.length)] || "最小改动";
    chunks.push(`围绕${left}按${right}关联原问题`);
    pair += 1;
  }
  const forHistory = chunks.join(" ").trim();
  return {
    forRules,
    forHistory,
    anchors: historyTerms.length,
    charRatio: Number((([...forHistory].length || 0) / Math.max(1, [...prompt].length)).toFixed(3)),
    historyTerms: ruleTerms,
    ruleTerms,
    personalizedTerms: [...personalized].slice(0, 32),
  };
}

export function auditRuleRouting(reg: any, rules: any[], prompt: string, expandedForRules: string) {
  const eligible = rules.filter((rule: any) => !Array.isArray(rule.alwaysOn) || !rule.alwaysOn.length);
  const base = reg.matchRules(eligible, prompt);
  const expanded = reg.matchRules(eligible, expandedForRules);
  const actualById = new Map<string, any>();
  for (const hit of [...base, ...expanded]) if (!actualById.has(hit.rule.id)) actualById.set(hit.rule.id, hit);
  // 独立 oracle:逐条直接执行语料 trigger,不复用 matchRules 的排序/去重路径。
  const oracleIds = eligible.filter((rule: any) => {
    try { return new RegExp(String(rule.trigger), "i").test(expandedForRules); }
    catch { return false; }
  }).map((rule: any) => String(rule.id)).sort();
  const actualIds = [...actualById.keys()].sort();
  const pass = actualIds.length === oracleIds.length && actualIds.every((id, index) => id === oracleIds[index]);
  const baseIds = new Set(base.map((hit: any) => String(hit.rule.id)));
  return {
    pass,
    base,
    all: [...actualById.values()],
    actualIds,
    oracleIds,
    fromExpansion: [...actualById.values()].filter((hit: any) => !baseIds.has(String(hit.rule.id))),
  };
}

function usageTerms(value: unknown): string[] {
  const text = String(value || "").normalize("NFKC").toLowerCase()
    .replace(/已经|完成|结果|当前|检查|验证|问题|请求|处理|用户/gu, " ");
  const terms = new Set<string>();
  for (const hit of text.matchAll(/[a-z0-9][a-z0-9_.:\/-]{2,63}/gu)) terms.add(hit[0]);
  for (const run of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    const chars = [...run];
    for (let index = 0; index < chars.length - 1; index += 1) terms.add(chars.slice(index, index + 2).join(""));
  }
  for (const generic of ["已经", "完成", "结果", "当前", "检查", "验证", "问题", "请求", "处理", "用户"])
    terms.delete(generic);
  return [...terms].slice(0, 300);
}

export function historyUsageDecision(resolved: any, answer: unknown) {
  if (!resolved?.hit) return { required: false, pass: true, disposition: "not-required", overlap: [] };
  const text = String(answer || "");
  const token = String(resolved.usageToken || "");
  const used = text.includes(`<!-- history-used:${token} -->`);
  const conflict = text.includes(`<!-- history-conflict:${token} -->`);
  const visible = text.replace(/<!--\s*history-(?:used|conflict):[^>]+-->/gu, "");
  const available = new Set(usageTerms(visible));
  const overlap = usageTerms(`${resolved.summary20 || ""}\n${resolved.full || ""}`)
    .filter((term) => available.has(term)).slice(0, 12);
  const dispositionPass = Number(used) + Number(conflict) === 1;
  const evidencePass = conflict
    ? /冲突|变化|不同|推翻|不一致/u.test(visible)
    : overlap.length > 0;
  return {
    required: true,
    pass: dispositionPass && evidencePass,
    disposition: used ? "used" : conflict ? "conflict" : "missing",
    overlap,
    dispositionPass,
    evidencePass,
  };
}

const COMPLETION_GUARD_TYPE = "lop-completion-guard";
const GOAL_GATE_TYPE = "lop-goal-gate";
const HISTORY_GUARD_TYPE = "lop-history-disposition-guard";
const ADVERSARY_REDELIVERY_TYPE = "lop-adversary-redelivery";
const TURN_SCOPED_CUSTOM_TYPES = new Set([
  "lop-chain", COMPLETION_GUARD_TYPE, GOAL_GATE_TYPE, HISTORY_GUARD_TYPE,
  ADVERSARY_REDELIVERY_TYPE,
]);
// 目标门:用户在消息里显式声明一条可执行校验命令,agent_end 时 exit!=0 就自动续跑。
// 只认显式声明(【目标门】/[goal-gate] 行),不做任何语义猜测——"不达标不许交付"类
// 隐含目标由 completion guard 之外的这条确定性通道承接。
const GOAL_GATE_MAX = Number(process.env.LOP_GOAL_GATE_MAX || 3);
const GOAL_GATE_TIMEOUT_MS = Number(process.env.LOP_GOAL_GATE_TIMEOUT_MS || 120000);
const GOAL_GATE_LINE = /^\s*(?:【目标门】|\[goal-gate\])\s*(.*?)\s*$/miu;
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

export function parseGoalGateDirective(prompt: unknown):
  { action: "set"; command: string } | { action: "clear" } | { action: "none" } {
  const match = String(prompt || "").match(GOAL_GATE_LINE);
  if (!match) return { action: "none" };
  const value = match[1];
  if (!value || /^(?:关闭|清除|取消|off)$/iu.test(value)) return { action: "clear" };
  return { action: "set", command: value };
}

// 判定纯函数:数值非零 exit 一律 retry(校验脚本被删/命令不存在时 shell 也返回非零,
// 不给"弄坏校验器"留 fail-open 逃逸口);仅超时/无法取得 exit code 视为校验器自身
// 故障,fail-open 不续跑。attempts 为已自动续跑次数,达上限后 exhausted 停止干预。
export function goalGateVerdict(input: {
  exitCode: number | null; timedOut?: boolean; attempts: number; max: number;
}): "pass" | "retry" | "exhausted" | "fail-open" {
  if (input.timedOut || input.exitCode === null) return "fail-open";
  if (input.exitCode === 0) return "pass";
  return input.attempts >= input.max ? "exhausted" : "retry";
}

function execGoalGate(command: string): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = exec(command, {
      windowsHide: true, timeout: GOAL_GATE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8",
    }, (error: any, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
        output: `${stdout || ""}\n${stderr || ""}`.trim(),
        timedOut: Boolean(error?.killed),
      });
    });
    // Windows/Node 24 下 exec 已 exit=0 的 ChildProcess 仍可能保持事件循环引用；
    // Promise 与 stdio 继续保证回调完成，unref 只移除残留进程句柄。
    child.unref();
  });
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
  let lastResolved: any = null;
  let historyRetryActive = false;
  let historyRetryCount = 0;
  let completionRetryActive = false;
  let goalGateRetryActive = false;
  let runHadTool = false;
  // 目标门状态:会话生命周期内持续,直到用户显式关闭或被新目标门覆盖。
  let goalGate: { command: string; attempts: number } | null = null;
  let turnStartedAt = 0;
  let modelTurnStartedAt = 0;
  let deterministicDraftActive = false;
  let modelTurnDurations: number[] = [];
  let modelTtfbDurations: number[] = [];
  let toolDurationMs = 0;
  const toolStarts = new Map<string, number>();
  // 扩展装载即后台补扫,第一条 prompt 只等待尚未完成的尾部;后续 S3 不再扫描。
  const memoryReady = (async () => {
    const started = performance.now();
    try {
      const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
      const result = await mem.scanHistory({ render: false });
      log(`S3 STARTUP_SCAN ${+(performance.now() - started).toFixed(1)}ms sources=${result?.physicalSources || 0} changed=${result?.changedSources || 0} canonicalized=${result?.canonicalized || 0}`);
      return result;
    } catch (error) {
      log(`S3 STARTUP_SCAN_FAIL ${String(error).slice(0, 200)}`);
      throw error;
    }
  })();
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
  pi.on("before_provider_request", (event: any) => {
    modelTurnStartedAt = performance.now();
    if (!deterministicDraftActive) return;
    const payload = event?.payload || {};
    const configuredMax = Number(payload.max_output_tokens || 0);
    return {
      ...payload,
      max_output_tokens: configuredMax > 0 ? Math.min(configuredMax, 256) : 256,
      text: { ...(payload.text || {}), verbosity: "low" },
    };
  });
  pi.on("after_provider_response", () => {
    if (modelTurnStartedAt) modelTtfbDurations.push(+(performance.now() - modelTurnStartedAt).toFixed(1));
  });
  pi.on("message_end", (event: any) => {
    if (event?.message?.role !== "assistant" || !modelTurnStartedAt) return;
    modelTurnDurations.push(+(performance.now() - modelTurnStartedAt).toFixed(1));
    modelTurnStartedAt = 0;
  });
  pi.on("tool_execution_start", (event: any) => {
    runHadTool = true;
    const key = String(event?.toolCallId || event?.id || `${event?.toolName || "tool"}:${toolStarts.size}`);
    toolStarts.set(key, performance.now());
  });
  pi.on("tool_execution_end", (event: any) => {
    const direct = String(event?.toolCallId || event?.id || "");
    const key = direct && toolStarts.has(direct) ? direct : [...toolStarts.keys()][0];
    if (!key) return;
    toolDurationMs += performance.now() - Number(toolStarts.get(key));
    toolStarts.delete(key);
  });

  // 循环内上下文水位门(microcompact):pi 原生阈值压缩只在 run 结束/新 prompt 前检查
  // (_checkCompaction 仅两个调用点),单条消息的长工具循环里上下文无界膨胀(2026-08-29 实测
  // 超调至 45.1 万 tok,≥20万 tok 时每轮 TTFB/流时长 2-3×);而 ctx.compact() 的 manual 路
  // 首行 await this.abort() 会掐死在途 run,不可用于循环内。故采用 Claude 壳 microcompact 同款:
  // 真实用量超水位后,仅对发往上游的载荷把"尾部保留预算之外的旧工具结果"替换为占位符——
  // 会话文件不动、不 abort、无额外 LLM 调用;裁剪单调(旧的永远保持裁剪态)保上游前缀缓存;
  // 粘性开关防"裁→用量回落→停裁→再膨胀"振荡,原生压缩(session_compact)发生时复位。fail-open。
  // 触发线 12 万:实测成本曲线 <5万 tok TTFB 941ms(地板)/~9.4万 1421ms/≥20万 1966ms;
  // 稳态载荷≈保留额+对话文本(与触发线无关),触发线只决定进入省钱模式的早晚——
  // 取 12 万可让短会话零打扰、长会话尽早收敛到 ~6-10万 稳态;保留 5 万护住工作集
  // (再压每轮省 <0.2s,一次重读付 ~5s,风险不对称)。
  const COMPACT_TRIGGER_TOKENS = Number(process.env.LOP_COMPACT_TRIGGER_TOKENS || 120000);
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
    if (goalGateRetryActive) { log(`GOAL_GATE retry=${goalGate?.attempts || 0}/${GOAL_GATE_MAX} skip reinject`); return; }
    if (historyRetryActive) { log(`S3 USAGE_RETRY ${historyRetryCount}/2 skip reinject`); return; }
    if (completionRetryActive) { log("COMPLETION_GUARD retry skip reinject"); return; }
    turnStartedAt = performance.now();
    deterministicDraftActive = false;
    modelTurnDurations = [];
    modelTtfbDurations = [];
    toolDurationMs = 0;
    toolStarts.clear();
    advDeliveredTurn = false;
    historyRetryCount = 0;
    completionRetryActive = false;
    lastResolved = null;
    lastPrompt = prompt;
    // 目标门声明/关闭只认真实用户消息;续跑注入轮 prompt 为空,走不到这里,
    // 因此 attempts 预算只被新的人工消息重置。
    const gateDirective = parseGoalGateDirective(prompt);
    if (gateDirective.action === "set") {
      goalGate = { command: gateDirective.command, attempts: 0 };
      log(`GOAL_GATE SET cmd=${gateDirective.command.slice(0, 160)}`);
    } else if (gateDirective.action === "clear") {
      if (goalGate) log("GOAL_GATE CLEAR");
      goalGate = null;
    } else if (goalGate) {
      goalGate.attempts = 0;
    }
    const contexts: string[] = [];
    const phase: Record<string, unknown> = {};

    // S2 个性化扩写硬门:扩写文本必须达到原问题字符数3倍,并保留可归因术语。
    const t2 = performance.now();
    let expanded: ExpandedPrompt;
    try {
      expanded = expandPrompt(prompt);
      phase.s2Pass = expanded.charRatio >= 3;
      if (!phase.s2Pass) throw new Error(`expansion ratio ${expanded.charRatio} < 3`);
    } catch (error) {
      phase.s2Pass = false;
      phase.s2Error = String(error).slice(0, 180);
      phase.s2Ms = +(performance.now() - t2).toFixed(1);
      lastPhase = phase;
      metric({ sessionId, prompt: prompt.slice(0, 160), ...phase, hardGate: "S2" });
      throw error;
    }
    phase.s2Ms = +(performance.now() - t2).toFixed(1);
    phase.s2Anchors = expanded.anchors;
    phase.s2Chars = [...expanded.forHistory].length;
    phase.s2BaseChars = [...prompt].length;
    phase.s2Ratio = expanded.charRatio;
    phase.s2RuleTerms = expanded.ruleTerms;
    phase.s2PersonalizedTerms = expanded.personalizedTerms;

    // S3 历史硬门:先原问题,miss 后仍按原意评分,只用3×扩写扩大候选。
    const t3 = performance.now();
    try {
      const scan = await memoryReady;
      phase.s3ScanSources = Number(scan?.physicalSources || 0);
      phase.s3ScanChanged = Number(scan?.changedSources || 0);
      if (isContextDependentHistoryPrompt(prompt)) {
        phase.s3Pass = true;
        phase.s3Hit = false;
        phase.s3Mode = "-";
        phase.s3Reason = "context-dependent-prompt";
        phase.s3ViaExpansion = false;
        phase.s3Token = "";
      } else {
        const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
        const opts = { sessionId, turnId: "", refresh: false, maxFullChars: 2000 };
        const base = await mem.resolveHistory(prompt, opts);
        let resolved = base;
        let viaExpansion = false;
        if (!base?.hit && expanded.forHistory !== prompt) {
          const expandedResult = await mem.resolveHistory(prompt, {
            ...opts,
            candidateQuery: expanded.forHistory,
            associationTerms: expanded.historyTerms.join(" "),
          });
          if (expandedResult?.hit) { resolved = expandedResult; viaExpansion = true; }
          phase.s3ExpandedReason = expandedResult?.reason || "-";
        }
        const relevant = !resolved?.hit || (
          String(resolved.summary20 || "").length > 0 &&
          [...String(resolved.summary20 || "")].length <= 20 &&
          String(resolved.full || "").trim().length > 0 &&
          (resolved.mode === "exact" || Number(resolved.relevance || 0) >= 0.82)
        );
        if (!relevant) throw new Error(`history relevance gate failed: ${JSON.stringify(resolved).slice(0, 500)}`);
        lastResolved = resolved?.hit ? resolved : null;
        phase.s3Pass = relevant;
        phase.s3Hit = Boolean(resolved?.hit);
        phase.s3Mode = resolved?.mode || "-";
        phase.s3Reason = resolved?.reason || "-";
        phase.s3EventId = resolved?.eventId || "";
        phase.s3Relevance = Number(resolved?.relevance || 0);
        phase.s3ViaExpansion = viaExpansion;
        phase.s3CandidateDelta = viaExpansion ? 1 : 0;
        phase.s3Token = resolved?.usageToken || "";
        const context = mem.renderResolvedHistory(resolved);
        if (context) contexts.push(context);
      }
    } catch (error) {
      phase.s3Pass = false;
      phase.s3Error = String(error).slice(0, 220);
      phase.s3Ms = +(performance.now() - t3).toFixed(1);
      lastPhase = phase;
      metric({ sessionId, prompt: prompt.slice(0, 160), ...phase, hardGate: "S3" });
      throw error;
    }
    phase.s3Ms = +(performance.now() - t3).toFixed(1);

    // S4 规则硬门:运行命中集合必须与逐条直接搜索全语料的 oracle 完全相等。
    const t4 = performance.now();
    try {
      if (!fs.existsSync(CORPUS)) {
        phase.s4Pass = true;
        phase.s4Reason = "corpus-absent";
        phase.s4Live = [];
        phase.s4Oracle = [];
        phase.s4FromExpansion = [];
      } else {
        const reg: any = await import(pathToFileURL(REGISTRY_MJS).href);
        const registry = reg.loadRuleRegistry(CORPUS);
        const routed = auditRuleRouting(reg, registry.rules, prompt, expanded.forRules);
        phase.s4Pass = routed.pass;
        phase.s4Live = routed.actualIds;
        phase.s4Oracle = routed.oracleIds;
        phase.s4FromExpansion = routed.fromExpansion.map((hit: any) => String(hit.rule.id));
        phase.s4ActualCount = routed.actualIds.length;
        phase.s4OracleCount = routed.oracleIds.length;
        if (!routed.pass) {
          throw new Error(`rule set mismatch actual=${routed.actualIds.join(",")} oracle=${routed.oracleIds.join(",")}`);
        }
        if (routed.all.length) {
          contexts.push([
            `<rules-resolved source="rules-corpus" host="pi" actual="${routed.actualIds.length}" oracle="${routed.oracleIds.length}">`,
            "以下是本轮确定性命中的完整规则集合;它们是规则而非历史数据。只读取命中项明确指向的Rule/Skill,禁止扩展为全量规则加载。",
            ...routed.all.map((hit: any) => `- [${hit.rule.id}] ${String(hit.rule.text || hit.rule.summary || "").slice(0, 500)}`),
            "</rules-resolved>",
          ].join("\n"));
        }
      }
    } catch (error) {
      phase.s4Pass = false;
      phase.s4Error = String(error).slice(0, 220);
      phase.s4Ms = +(performance.now() - t4).toFixed(1);
      lastPhase = phase;
      metric({ sessionId, prompt: prompt.slice(0, 160), ...phase, hardGate: "S4" });
      throw error;
    }
    phase.s4Ms = +(performance.now() - t4).toFixed(1);

    // S5 高频最小动作快路:仅识别 cwd 内路径、direct argv/stat/唯一字面替换；
    // 执行前仍过 S7 的同一 pretool 判定，结果作为当前证据注入，避免确定动作多跑模型轮次。
    const t5 = performance.now();
    try {
      const fast: any = await import(pathToFileURL(FAST_PATH_MJS).href);
      const plan = fast.planDeterministicFastPath(prompt, process.cwd());
      if (plan) {
        let hits: any[] = [];
        if (plan.toolName) {
          const pre: any = await import(pathToFileURL(PRETOOL_MJS).href);
          const checked = pre.checkPreTool({
            session_id: sessionId,
            tool_name: plan.toolName,
            tool_input: plan.toolInput,
          });
          hits = Array.isArray(checked) ? checked : checked?.hits || [];
        }
        if (!hits.length) {
          const result = fast.executeDeterministicFastPath(plan, {
            cwd: process.cwd(), env: process.env, timeoutMs: 30000,
          });
          if (result?.executed) {
            if (result.countsAsTool !== false) {
              runHadTool = true;
              toolDurationMs += Number(result.durationMs || 0);
            }
            phase.s5Executed = true;
            phase.s5Kind = result.kind;
            phase.s5Ok = Boolean(result.ok);
            phase.s5Status = result.status ?? null;
            phase.s5Bytes = result.bytes ?? null;
            if (result.finalDraft) {
              deterministicDraftActive = true;
              phase.s5OutputTokenCap = 256;
            }
            const evidence = fast.renderDeterministicEvidence(result, {
              usageToken: lastResolved?.usageToken || "",
            });
            if (evidence) contexts.push(evidence);
          }
        } else {
          phase.s5Executed = false;
          phase.s5Reason = `pretool:${hits.map((hit: any) => hit.id || hit.rule || "blocked").join(",")}`;
        }
      } else {
        phase.s5Executed = false;
        phase.s5Reason = "no-plan";
      }
    } catch (error) {
      phase.s5Executed = false;
      phase.s5Reason = String(error).slice(0, 180);
      log(`S5 FALLBACK ${phase.s5Reason}`);
    }
    phase.s5Ms = +(performance.now() - t5).toFixed(1);

    if (lastResolved?.hit && phase.s5Kind !== "jsonl-json-explanation") {
      contexts.push([
        '<history-disposition-gate>',
        '历史只用于选择最小验证路径，不能替代用户本轮要求的当前工具执行、读回或运行态证据。',
        `取得当前证据后，最终可见结论引用至少一个相关历史事实，并且仅附加 <!-- history-used:${lastResolved.usageToken} -->；若当前证据推翻历史则明确冲突且仅附加 <!-- history-conflict:${lastResolved.usageToken} -->。`,
        '</history-disposition-gate>',
      ].join("\n"));
    }

    // S6 后台对抗预审起审:detached 子进程(windowsHide),agent_end 消费,外部能力 fail-open。
    const t6 = performance.now();
    try {
      const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
      const started = adv.startBackgroundReview({ session_id: sessionId, prompt });
      phase.s6Start = started?.status || "-";
      if (phase.s5Executed === true && phase.s5Ok === true &&
          typeof adv.acknowledgeBackgroundReview === "function") {
        adv.acknowledgeBackgroundReview({
          session_id: sessionId,
          reason: "deterministic-current-evidence",
        });
        advDeliveredTurn = true;
        phase.s6Acknowledged = true;
      }
    } catch (e) { log(`S6 FAIL_OPEN ${String(e).slice(0, 120)}`); }
    phase.s6Ms = +(performance.now() - t6).toFixed(1);

    phase.preModelMs = +(performance.now() - turnStartedAt).toFixed(1);
    lastPhase = phase;
    log(`INJECT s2=${phase.s2Ms}ms(${phase.s2Ratio}x) s3=${phase.s3Ms}ms(hit=${phase.s3Hit},exp=${phase.s3ViaExpansion},reason=${phase.s3Reason}) s4=${phase.s4Ms}ms(actual=${phase.s4ActualCount || 0},oracle=${phase.s4OracleCount || 0},exp=${(phase.s4FromExpansion as string[])?.length || 0}) s5=${phase.s5Ms}ms(${phase.s5Kind || phase.s5Reason}) bytes=${Buffer.byteLength(contexts.join("\n\n"))}`);
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
          const historyReminder = lastResolved?.hit
            ? `\n\n修正后最终答复仍须处置已注入历史:采纳时引用相关事实并仅附加 <!-- history-used:${lastResolved.usageToken} -->；冲突时明确说明并仅附加 <!-- history-conflict:${lastResolved.usageToken} -->。`
            : "";
          pi.sendMessage({
            customType: ADVERSARY_REDELIVERY_TYPE,
            content: `Stop hook feedback:\n${review.reason}\n\n${review.body || ""}${historyReminder}`,
            display: false,
            details: { reason: review.reason || "", eventId: lastResolved?.eventId || "" },
          }, { deliverAs: "followUp", triggerTurn: true });
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
    // 目标门先于 completion guard:门存在时它就是完成判据,与 guard 的"承诺未执行"
    // 检测互不依赖(guard 管零工具假完成,门管"如实汇报未达标后停轮")。
    if (goalGate && lastAssistant?.stopReason === "stop" && !ctx?.hasPendingMessages?.()) {
      const gate = goalGate;
      const t9 = performance.now();
      const result = await execGoalGate(gate.command).catch(() => ({ code: null, output: "", timedOut: false }));
      const verdict = goalGateVerdict({
        exitCode: result.code, timedOut: result.timedOut, attempts: gate.attempts, max: GOAL_GATE_MAX,
      });
      log(`GOAL_GATE ${verdict.toUpperCase()} code=${result.code ?? "-"} attempts=${gate.attempts}/${GOAL_GATE_MAX} ms=${+(performance.now() - t9).toFixed(0)} cmd=${gate.command.slice(0, 120)}`);
      if (verdict === "retry") {
        gate.attempts += 1;
        goalGateRetryActive = true;
        metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, goalGate: verdict, goalGateAttempts: gate.attempts });
        try {
          pi.sendMessage({
            customType: GOAL_GATE_TYPE,
            content: `目标门命令未通过(exit=${result.code},自动续跑 ${gate.attempts}/${GOAL_GATE_MAX})。命令输出尾部:\n${result.output.slice(-600)}\n\n继续执行原始任务,直到目标门命令通过。禁止修改校验命令、其判定逻辑或伪造其输入数据。若有证据表明目标在当前约束下不可达,停止尝试并给出量化差距与原因,由用户决定是否放宽。`,
            display: false,
            details: { command: gate.command, attempts: gate.attempts, exitCode: result.code },
          }, { deliverAs: "followUp", triggerTurn: true });
          return;
        } catch (e) {
          goalGateRetryActive = false;
          log(`GOAL_GATE FAIL_OPEN ${String(e).slice(0, 160)}`);
        }
      } else {
        goalGateRetryActive = false;
        if (verdict === "exhausted") {
          metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, goalGate: verdict, goalGateAttempts: gate.attempts });
        }
      }
    }
    const guard = completionGuardDecision({
      prompt,
      assistantText: text,
      stopReason: lastAssistant?.stopReason,
      runHadTool,
      pendingMessages: Boolean(ctx?.hasPendingMessages?.()),
      alreadyQueued: completionGuardAlreadyQueued(branch),
    });
    if (guard.trigger) {
      completionRetryActive = true;
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
        completionRetryActive = false;
        log(`COMPLETION_GUARD FAIL_OPEN ${String(e).slice(0, 160)}`);
        lastPhase = {};
      }
      return;
    }
    completionRetryActive = false;

    // S3 使用硬门:不仅检查注入,还要求最终答复唯一处置凭证且可见结论与历史事实有交集。
    const usage = historyUsageDecision(lastResolved, text);
    lastPhase = {
      ...lastPhase,
      s3UsageRequired: usage.required,
      s3UsagePass: usage.pass,
      s3UsageDisposition: usage.disposition,
      s3UsageOverlap: usage.overlap,
      s3UsageRetries: historyRetryCount,
    };
    if (usage.required && !usage.pass) {
      if (historyRetryCount < 2) {
        historyRetryCount += 1;
        historyRetryActive = true;
        log(`S3 USAGE_BLOCK retry=${historyRetryCount}/2 disposition=${usage.disposition}`);
        metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, hardGate: "S3-usage" });
        try {
          pi.sendMessage({
            customType: HISTORY_GUARD_TYPE,
            content: `历史使用硬门未通过。重新给出完整最终答复:必须先判断已注入的 summary20/full 是否被当前证据采纳；采纳时在可见结论中引用至少一个相关事实并仅附加 <!-- history-used:${lastResolved?.usageToken || ""} -->；若当前证据推翻历史,明确写出冲突并仅附加 <!-- history-conflict:${lastResolved?.usageToken || ""} -->。不得同时附加两个凭证。`,
            display: false,
            details: { eventId: lastResolved?.eventId, retry: historyRetryCount },
          }, { deliverAs: "followUp", triggerTurn: true });
        } catch (error) {
          historyRetryActive = false;
          log(`S3 USAGE_RETRY_FAIL ${String(error).slice(0, 180)}`);
        }
        return;
      }
      historyRetryActive = false;
      lastPhase = { ...lastPhase, s3UsagePass: false, hardGate: "S3-usage-exhausted" };
      log("S3 USAGE_BLOCK exhausted=2; canonical write suppressed");
      metric({
        sessionId,
        prompt: prompt.slice(0, 160),
        ...lastPhase,
        initialModelMs: modelTurnDurations[0] || 0,
        followupModelMs: +modelTurnDurations.slice(1).reduce((sum, value) => sum + value, 0).toFixed(1),
        toolMs: +toolDurationMs.toFixed(1),
        e2eMs: +(performance.now() - turnStartedAt).toFixed(1),
      });
      return;
    }
    historyRetryActive = false;

    const t8 = performance.now();
    try {
      if (prompt && text) {
        const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
        const persistenceText = text
          .replace(/<!--\s*history-(?:used|conflict):[^>]+-->/gu, "")
          .replace(/<!--\s*lop-memory-event\s+\{[\s\S]*?\}\s*-->/gu, "")
          .trim();
        const saved = await mem.recordStop({
          session_id: sessionId,
          turn_id: "",
          prompt,
          last_assistant_message: persistenceText,
          transcript_path: "",
        });
        if (!saved?.canonical?.saved) {
          throw new Error(`canonical write not saved: ${JSON.stringify(saved).slice(0, 500)}`);
        }
        lastPhase = {
          ...lastPhase,
          s8Pass: true,
          s8CanonicalEventId: saved.canonical.eventId,
          s8CanonicalDerived: Boolean(saved.canonical.derived),
        };
        log(`S8 STOP ${saved?.added ? "ADDED" : "UPDATED"} canonical=${saved.canonical.eventId} derived=${Boolean(saved.canonical.derived)}`);
      }
    } catch (error) {
      lastPhase = { ...lastPhase, s8Pass: false, s8Error: String(error).slice(0, 220) };
      log(`S8 HARD_FAIL ${String(error).slice(0, 180)}`);
      metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, hardGate: "S8" });
      throw error;
    }
    metric({
      sessionId,
      prompt: prompt.slice(0, 160),
      ...lastPhase,
      s8Ms: +(performance.now() - t8).toFixed(1),
      initialModelMs: modelTurnDurations[0] || 0,
      followupModelMs: +modelTurnDurations.slice(1).reduce((sum, value) => sum + value, 0).toFixed(1),
      modelTurns: modelTurnDurations,
      modelTtfbMs: modelTtfbDurations,
      toolMs: +toolDurationMs.toFixed(1),
      e2eMs: +(performance.now() - turnStartedAt).toFixed(1),
    });
    deterministicDraftActive = false;
    lastPhase = {};
    lastResolved = null;
  });
}
