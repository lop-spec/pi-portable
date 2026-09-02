// lop 执行链 v2 的 pi 承接层(规格:decision-replay-engine/specs/gpt-exec-chain-v2.md)
// 进程内 import rule-enforcer 核心,单源三宿主(claude/codex/pi)。
// S2/S3/S4 是交付硬门;S6/S7 外部可选能力才允许 fail-open。S8 确定性落账并输出审计指标。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOP_CHAIN_RUNTIME_VERSION = "s9-memory-direction-frontier-v21-sidecar-marker";
const MODULE_FILE = fileURLToPath(import.meta.url);

// [portable] 全部路径由 PI_PORTABLE_HOME(包内)与 PI_PORTABLE_DATA(数据根)派生。
// 数据面(语料/实体/账本)首启为空,可由用户自行导入;缺失时对应能力自动降级 fail-open。
const MODULE_DIR = path.dirname(MODULE_FILE);
const HOME = process.env.PI_PORTABLE_HOME || path.resolve(MODULE_DIR, "..");
const DATA = process.env.PI_PORTABLE_DATA || path.join(HOME, "data");
const CHAIN_DIR = path.join(HOME, "src", "chain");
const MEMORY_MJS = path.join(CHAIN_DIR, "lop-memory.mjs");
// S7 工具门规则集属私有数据面(个人环境标识密集),不随公开包分发。
// 数据根有 rules-pretool.mjs 才启用工具门,否则该步跳过(fail-open,不阻断执行)。
const PRETOOL_MJS = process.env.PI_PRETOOL_MJS || path.join(DATA, "rules-pretool.mjs");
// S6 预审:便携版走包内 8794 桥的进程内实现(见 portable-adversary.mjs),同签名同判据。
const ADVERSARY_MJS = path.join(CHAIN_DIR, "portable-adversary.mjs");
// 验收命令自动生成(双红纪律)与 Best-of-N 多候选并行(goal-gate 筛选),均 fail-open。
const AUTO_GATE_MJS = path.join(CHAIN_DIR, "auto-gate.mjs");
const BEST_OF_N_MJS = path.join(CHAIN_DIR, "best-of-n.mjs");
// 目标门换向器:同路无进展时强制换方向而不是停跑(证据轮/禁忌换路/耗尽落账本)。
const REDIRECTOR_MJS = path.join(CHAIN_DIR, "goal-redirector.mjs");
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

export function runtimeVersionFromSource(value: unknown): string {
  return String(value || "").match(/LOP_CHAIN_RUNTIME_VERSION\s*=\s*["']([^"']+)["']/u)?.[1] || "";
}

export function stripAcceptanceChecklist(value: unknown): string {
  const source = String(value || "");
  const block = firstAcceptanceChecklistBlock(source);
  const withoutBlock = block ? `${source.slice(0, block.start)}\n${source.slice(block.end)}` : source;
  const collapsed = collapsedAcceptanceChecklist(withoutBlock);
  if (!collapsed) return withoutBlock.trim();
  return `${withoutBlock.slice(0, collapsed.start)}\n${withoutBlock.slice(collapsed.end)}`.trim();
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
const CHECKLIST_GATE_TYPE = "lop-checklist-gate";
const CHECKLIST_STATE_TYPE = "lop-checklist-goal-state";
const RUN_CONTROL_TYPE = "lop-run-control";
const BEST_OF_N_TYPE = "lop-best-of-n";
const RUN_SUPERVISOR_RECOVERY_PREFIX = "[lop-run-supervisor recovery]";
// 记忆标记状态差门(写入侧 v3):本轮有状态变更且最终回复缺 lop-memory-event 标记时追一轮补标记。
const MEMORY_GATE_TYPE = "lop-memory-gate";
const MEMORY_MUTATING_TOOL = /^(?:write|edit|multi_edit|multiedit|notebook_edit|notebookedit|apply_patch|write_file|edit_file|create_file)$/iu;
const MEMORY_MUTATING_COMMAND = /(?:^|[\s;&|(])(?:rm|mv|cp|mkdir|rmdir|del|erase|move|copy|xcopy|robocopy|touch|tee|truncate|chmod|chown|sed\s+-i|git\s+(?:commit|push|add|checkout|reset|merge|rebase|tag|rm|mv|stash|apply|cherry-pick|worktree)|npm\s+(?:install|i|ci|uninstall|publish|link)|pip\s+install|pnpm\s+(?:add|install)|schtasks|scp|sftp|new-item|set-content|add-content|out-file|remove-item|copy-item|move-item|rename-item|mklink|reg\s+add|wget|dd)\b|(?:^|[^<>|])>{1,2}\s*(?!&|\/dev\/null|nul\b)[^&|\s]/iu;
const TURN_SCOPED_CUSTOM_TYPES = new Set([
  "lop-chain", COMPLETION_GUARD_TYPE, GOAL_GATE_TYPE, HISTORY_GUARD_TYPE,
  ADVERSARY_REDELIVERY_TYPE, CHECKLIST_GATE_TYPE, RUN_CONTROL_TYPE, BEST_OF_N_TYPE, MEMORY_GATE_TYPE,
]);
// 目标门:用户在消息里显式声明一条可执行校验命令,agent_end 时 exit!=0 就自动续跑。
// 只认显式声明(【目标门】/[goal-gate] 行),不做任何语义猜测——"不达标不许交付"类
// 隐含目标由 completion guard 之外的这条确定性通道承接。
const GOAL_GATE_MAX = Number(process.env.LOP_GOAL_GATE_MAX || 3);
const GOAL_GATE_TIMEOUT_MS = Number(process.env.LOP_GOAL_GATE_TIMEOUT_MS || 120000);
const GOAL_GATE_LINE = /^\s*(?:【目标门】|\[goal-gate\])\s*(.*?)\s*$/miu;
// 两态验收目标:桥 persistence 注入要求模型对执行型任务自列【验收清单】。
// 首份清单冻结为会话分支上的持久合同;只有 [ ](未完成) 与 [x](已验证完成),任何
// 第三状态、删项、改名、漏清单都保持 active；合法未完成项不设固定续跑上限。
// 格式违规诊断与合同项分离；重复诊断只作计数与普通文本反馈，不得变成固定重试耗尽。
// 合同保持 active 并继续 follow-up；显式目标门始终拥有更高完成优先级。
const CHECKLIST_BLOCKER_TURNS = Math.max(1, Number(process.env.LOP_CHECKLIST_BLOCKER_TURNS || 3));
const CHECKLIST_VIOLATION_TURNS = Math.max(1, Number(process.env.LOP_CHECKLIST_VIOLATION_TURNS || 3));
const CHECKLIST_HEADER = "【验收清单】";
const positiveSeconds = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const FOREGROUND_BASH_MAX_SECONDS = positiveSeconds(process.env.LOP_FOREGROUND_BASH_MAX_SECONDS, 1800);
const WALL_CLOCK_WAIT_MAX_SECONDS = Math.min(FOREGROUND_BASH_MAX_SECONDS, positiveSeconds(process.env.LOP_WALL_CLOCK_WAIT_MAX_SECONDS, 300));
const NEXT_ACTION_STALE_GRACE_MS = positiveSeconds(process.env.LOP_NEXT_ACTION_STALE_GRACE_SECONDS, 300) * 1000;
const INDEPENDENT_HISTORY_ANCHOR = /(?:[A-Za-z]:[\\/]|https?:\/\/|\b\d{2,}\b|\b[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|jsonl?|toml|ya?ml|md|sql|py|ps1|exe|dll)\b)/iu;
const CONTEXT_ONLY_PROMPT = /^(?:继续(?:吧|做|处理|执行|下去|做下去)?|确认(?:一下)?|好(?:的)?|可以|行|是(?:的)?|对|没问题|开始|照办|重试|再试(?:一次)?|(?:按|照)(?:这个|上面|前面|刚才的?)(?:做|处理|执行|修改)?|(?:具体)?(?:怎么|如何)改(?:[，,\s]*(?:说明白|说清楚))?|说明白|说清楚|再说一遍|什么意思|(?:其余|剩下)(?:的)?都做)$/u;
const CONTEXT_REFERENCE = /(?:这个|那个|这些|那些|上面|前面|刚才|其余|剩下|第\s*\d+\s*项|不做\s*\d+)/u;
const EXECUTION_ACTION = /(?:看下|看一下|查下|查一下|检查|查看|排查|定位|修复|修改|改|执行|运行|部署|安装|添加|加上|授权|更新|提交|推送|上传|下载|验证|测试|创建|删除|迁移|接入|配置|重启|停止|启动|继续|接着|处理|完成|落地|做)/u;
const EXPLANATION_REQUEST = /(?:怎么|如何|为什么|是什么|有什么|有哪些|有没有|能否|是否|可不可以|推荐|说明|解释|原理|方案|区别)/u;
const DIRECT_EXECUTION = /(?:直接|帮我|请你|给我|都做|做完|改好|修好|落地|执行|运行|部署|上传|提交|推送)/u;
const FUTURE_ACTION_COMMITMENT = /(?:接下来|下一步|然后|随后|现在)?\s*(?:我会|我将|我先|我接着|我继续|将会)\s*(?:直接|先|继续)?[\s\S]{0,24}(?:读取|检查|查看|排查|定位|修复|修改|执行|运行|验证|测试|部署|安装|提交|推送|上传|连接|打开|搜索|处理)/u;
const EXPLICIT_BLOCKER = /(?:需要你|请(?:你)?(?:提供|确认|回复|授权|登录|打开|选择)|等待(?:你|用户)|缺少(?:权限|凭据|信息|参数)|无法(?:安全)?(?:继续|访问|连接|执行|读取|写入|调用)|被阻塞|需要授权|未提供(?:权限|凭据|信息|参数)|(?:工具|调用|执行)(?:通道|层)?(?:异常|不可用|被拦截)|(?:当前会话|本轮).{0,24}(?:没有|未暴露|缺少).{0,24}(?:工具|通道|权限)|(?:需要|必须|只能|只有)(?:等待|积累|收集).{0,48}(?:数据|样本|交易日|工作日|天|日)|当前.{0,24}(?:数据|样本).{0,24}(?:不足|不够))/u;
const FAILURE_REPORT = /(?:没用|无效|不起作用|不生效|仍然|依然|还是).{0,32}(?:停止|停了|停住|失败|报错|问题|没用|无效)/u;
const COMPLETION_EVIDENCE = /(?:已(?:完成|修复|修改|执行|运行|验证|部署|安装|提交|推送|上传|处理|落地)|(?:测试|验证)(?:已经)?通过|结果如下|修改如下|代码如下)/u;
const WALL_CLOCK_WAIT_PATTERN = /(?:\b(?:sleep|start-sleep)\b|\btimeout(?:\.exe)?\s+\/t\b|\bwait_(?:started|heartbeat|complete)\b|\btarget\s*=\s*\$?\(?\s*date\b|while[\s\S]{0,600}\bdate\s+\+%s|(?:等待|睡眠).{0,24}(?:直到|至|小时|分钟))/iu;

export type ForegroundBashDecision = {
  action: "allow" | "cap" | "block";
  timeoutSeconds: number;
  requestedTimeoutSeconds: number | null;
  wallClockWait: boolean;
  reason: string;
};

export function foregroundBashDecision(input: any, maxSeconds = FOREGROUND_BASH_MAX_SECONDS, wallClockMaxSeconds = WALL_CLOCK_WAIT_MAX_SECONDS): ForegroundBashDecision {
  const command = String(input?.command || "");
  const rawTimeout = Number(input?.timeout);
  const requested = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : null;
  const max = positiveSeconds(maxSeconds, 1800);
  const wallMax = Math.min(max, positiveSeconds(wallClockMaxSeconds, 300));
  const wallClockWait = WALL_CLOCK_WAIT_PATTERN.test(command);
  if (requested !== null && requested > max) return { action: "block", timeoutSeconds: max, requestedTimeoutSeconds: requested, wallClockWait, reason: `foreground timeout ${requested}s exceeds host limit ${max}s` };
  if (wallClockWait && (requested === null || requested > wallMax)) return { action: "block", timeoutSeconds: wallMax, requestedTimeoutSeconds: requested, wallClockWait, reason: `wall-clock wait exceeds foreground limit ${wallMax}s` };
  if (requested === null) return { action: "cap", timeoutSeconds: max, requestedTimeoutSeconds: null, wallClockWait, reason: `host deadline injected at ${max}s` };
  return { action: "allow", timeoutSeconds: requested, requestedTimeoutSeconds: requested, wallClockWait, reason: "within-limit" };
}

function collectInspectionText(value: any, out: string[] = [], depth = 0): string[] {
  if (out.join("\n").length >= 500000 || depth > 8 || value === null || value === undefined) return out;
  if (typeof value === "string") { out.push(value.slice(-100000)); return out; }
  if (Array.isArray(value)) { for (const item of value.slice(-160)) collectInspectionText(item, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  for (const key of ["text", "content", "output", "message", "arguments", "data", "details", "nextAction"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (key === "nextAction") out.push(`nextAction:${String(value[key] || "")}`);
    else collectInspectionText(value[key], out, depth + 1);
  }
  return out;
}

export function staleNextActionDecision(value: unknown, nowMs = Date.now()): { found: boolean; stale: boolean; timestamp: string; directive: string } {
  const source = collectInspectionText(value).join("\n");
  const pattern = /(?:["']?nextAction["']?\s*[:=]|下一步\s*[:：]|下一动作\s*[:：])[\s\S]{0,800}?(20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/giu;
  let timestamp = "";
  for (const match of source.matchAll(pattern)) timestamp = match[1];
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  const stale = Number.isFinite(at) && at + NEXT_ACTION_STALE_GRACE_MS < Number(nowMs);
  return { found: Number.isFinite(at), stale, timestamp, directive: stale ? `检测到过期 nextAction(${timestamp})，该动作立即失效；禁止平移日期或前台等待。先按硬边界生成至少 2 条相互独立、尚未实测的合法方向 frontier，说明与旧路径的本质差异，并立即执行信息增益/成本最高的一条。` : "" };
}

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

function isGoalContinuationPrompt(value: unknown): boolean {
  const text = String(value || "").normalize("NFKC").trim();
  return /^(?:继续|重试|再试|接着做|继续做|继续执行)/u.test(text);
}

export function isGoalCancellationPrompt(value: unknown): boolean {
  const text = String(value || "").normalize("NFKC").trim();
  return /^(?:\/lop-goal-cancel|取消(?:当前)?目标|放弃(?:当前)?目标|停止自动续跑|不要再继续(?:这个|该)?任务)[。.!！\s]*$/u.test(text);
}

function isExecutionRequest(value: unknown): boolean {
  const text = String(value || "").normalize("NFKC");
  return FAILURE_REPORT.test(text) || Boolean(persistentOutcomeDirective(text)) || (
    EXECUTION_ACTION.test(text) && (!EXPLANATION_REQUEST.test(text) || DIRECT_EXECUTION.test(text))
  );
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

// 修法四(2026-08-31,db 案实录):预审若在本轮工具窗口内未能投递(有工具轮却从没见过
// 执行轨迹),其 block 属盲判——实录:模型已 read 目标文件仍被"未读取便猜测"打回,
// 冤枉重跑 ~20s(占该任务耗时一半)。此类降级为日志;无工具轮时投递窗口本不存在,
// 保留打回权(那正是"没执行就猜"的合法抓捕面)。
export function s6BlockDisposition(input: {
  status?: unknown;
  runHadTool?: boolean;
  delivered?: boolean;
}): "redeliver" | "missed-window" | "none" {
  if (input?.status !== "block") return "none";
  if (input.runHadTool && !input.delivered) return "missed-window";
  return "redeliver";
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
export type AcceptanceChecklistItem = {
  text: string;
  key: string;
  marker: string;
  state: "open" | "done" | "invalid";
};
export type AcceptanceChecklist = {
  items: AcceptanceChecklistItem[];
  open: string[];
  done: number;
  invalid: string[];
  duplicates: string[];
};
export type ChecklistGoalState = {
  version: 1;
  status: "inactive" | "active" | "complete" | "blocked";
  objective: string;
  taskUserEntryId: string;
  // done 由 host 持久记账(v13 增量协议):模型只声明状态变化,缺席=保持,
  // [x] 置 true,显式 [ ] 重开;第三状态不改变 done。
  items: Array<{ text: string; key: string; done?: boolean }>;
  continuationCount: number;
  blockerKey: string;
  blockerTurns: number;
  violationKey: string;
  violationTurns: number;
  allowExpansion: boolean;
  // 用户显式要求“直到/不达到不允许结束”时，由 host 持有的终态合同；旧 v1 entry
  // 没有这两个字段，clone 时按 objective 原位迁移。
  persistentOutcome: string;
  outcomeItemKey: string;
  redirectRounds: any[];
  redirectLevel: number;
};
export type ChecklistGateResult = {
  trigger: boolean;
  reason: string;
  open: string[];
  violations: string[];
  state: ChecklistGoalState | null;
};

export function normalizeChecklistItem(value: unknown): string {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function canonicalAddedChecklistViolation(value: unknown): string {
  const normalized = normalizeChecklistItem(value);
  const body = normalized.replace(/^(?:验收项目被新增或改名:\s*)+/u, "").trim();
  return `验收项目被新增或改名: ${body || normalized}`;
}

function checklistViolationFingerprint(violations: string[]): string {
  return [...new Set(violations.map(normalizeChecklistItem).filter(Boolean))].sort().join("|");
}

const NUMERIC_OUTCOME = /(?:[<>≤≥]=?|至少|不低于|超过|达到)\s*\d+(?:\.\d+)?\s*(?:倍|%|％|个|次|项|分)?/u;
const UNMET_OUTCOME = /(?:尚未|仍未|当前未|本轮未|未达到|未满足|未通过|未完成|不达标|没有合格|保持开放|没有关闭|未关闭)/u;

function concisePersistentOutcome(value: string): string {
  const text = normalizeChecklistItem(value);
  const prohibited = text.match(/不((?:达到|完成|通过|满足)[^。；;]{0,80}?)(?:不允许|不准|不得|禁止)(?:交付|停止|结束|关闭|收尾)/u);
  if (prohibited?.[1]) return prohibited[1];
  const until = text.match(/(?:直到|直至)\s*([^。；;]{1,168}?)(?=(?:才|方)?(?:允许|可以|能够)?(?:交付|结束|停止|关闭|收尾)|[。；;]|$)/u);
  if (until?.[1]) return until[1].trim();
  const colon = text.search(/[:：]/u);
  if (colon > 0 && NUMERIC_OUTCOME.test(text.slice(0, colon))) return text.slice(0, colon).trim();
  return [...text].slice(0, 220).join("");
}

export function persistentOutcomeDirective(value: unknown): string {
  const source = String(value || "").normalize("NFKC").trim();
  if (!source) return "";
  const lines = source.split(/\r?\n/u).map((line) => normalizeChecklistItem(
    line.replace(/^\s*[-*]\s*\[[^\]]*\]\s*/u, ""),
  )).filter(Boolean);
  const explicit = lines.find((line) =>
    /(?:直到|直至)[^。；;]{0,120}(?:达到|完成|通过|满足)/u.test(line) ||
    /不(?:达到|完成|通过|满足)[^。；;]{0,80}(?:不允许|不准|不得|禁止)(?:交付|停止|结束|关闭|收尾)/u.test(line));
  if (explicit) return concisePersistentOutcome(explicit);

  const taskOpen = lines.find((line) =>
    /researchTaskClosed\s*=\s*false/iu.test(line) ||
    /(?:任务|研究任务).{0,32}(?:保持开放|没有关闭|不关闭|未关闭)/u.test(line));
  const continued = /(?:^|\n)\s*继续(?:[，,。.!！\s].*)?\s*$/u.test(source);
  const numericUnmet = lines.find((line) => NUMERIC_OUTCOME.test(line) && UNMET_OUTCOME.test(line));
  if ((taskOpen || continued) && numericUnmet) return concisePersistentOutcome(numericUnmet);
  if (taskOpen) return "任务达到用户声明的终态并关闭";
  return "";
}

function persistentOutcomeItemText(target: string): string {
  return `冻结持续终态已有可验证的正向达成证据：${[...normalizeChecklistItem(target)].slice(0, 180).join("")}`;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function persistentOutcomeDecision(input: {
  objective: unknown; assistantText: unknown; target?: unknown;
}): { required: boolean; attained: boolean; unmet: boolean; target: string; reason: string } {
  const target = normalizeChecklistItem(input.target || persistentOutcomeDirective(input.objective));
  if (!target) return { required: false, attained: true, unmet: false, target: "", reason: "not-required" };
  const body = stripAcceptanceChecklist(input.assistantText);
  const compactBody = body.replace(/\s+/gu, "");
  const lastMatchIndex = (value: string, pattern: RegExp): number => {
    let last = -1;
    for (const match of value.matchAll(pattern)) last = Math.max(last, Number(match.index ?? -1));
    return last;
  };
  const lastUnmet = lastMatchIndex(body,
    /(?:当前|本轮|最终|至今|仍|尚).{0,32}(?:未达到|未满足|未通过|未完成|不达标|没有合格)|(?:未达到|未满足|未通过|未完成|不达标|没有合格).{0,48}(?:继续|禁止|不能|不得|封闭|失败)|researchTaskClosed\s*=\s*false|strategyDeliverable\s*=\s*false|(?:任务|研究任务).{0,20}(?:没有|尚未|仍未|保持)(?:关闭|完成|开放)/giu);
  const numericTargets = [...target.matchAll(/\d+(?:\.\d+)?\s*(?:倍|%|％|个|次|项|分)/gu)]
    .map((match) => match[0].replace(/\s+/gu, ""));
  let lastAttained = lastMatchIndex(body,
    /(?:(?:当前|本轮|最终)(?:(?!未|不).){0,20}(?:已经|均已|全部已|已)|(?:现已|已经|均已|全部已))(?:达到|超过|满足|通过|完成).{0,48}(?:目标|门槛|要求|验收)|(?:当前|本轮|最终)(?:(?!未|不).){0,24}(?:已取得|已获得|已有)(?:(?!未|不).){0,32}(?:正向(?:达成)?证据|可验证证据)|(?:持续|最终|冻结)(?:终态|目标)(?:已经|已)?(?:完成|达成|通过)(?=[。；;，,\s]|$)|researchTaskClosed\s*=\s*true|strategyDeliverable\s*=\s*true/giu);
  if (numericTargets.length) {
    const numericIndexes = numericTargets.map((token) => lastMatchIndex(compactBody, new RegExp(
      `(?:已|已经|现已|均已|全部已).{0,24}(?:达到|超过|满足|通过).{0,48}${regexEscape(token)}|${regexEscape(token)}.{0,32}(?:目标|门槛|要求).{0,16}(?:已)?(?:达到|达成|通过|满足)`,
      "giu",
    )));
    lastAttained = numericIndexes.every((index) => index >= 0) ? Math.max(...numericIndexes) : -1;
  }
  const attained = lastAttained >= 0 && lastAttained > lastUnmet;
  const unmet = lastUnmet >= 0 && lastUnmet > lastAttained;
  return {
    required: true,
    attained,
    unmet,
    target,
    reason: attained ? "persistent-outcome-attained" : unmet ? "persistent-outcome-unmet" : "persistent-outcome-unverified",
  };
}

export function createChecklistGoalState(
  objective: unknown = "", taskUserEntryId: unknown = "",
): ChecklistGoalState {
  const objectiveText = String(objective || "").trim();
  const persistentOutcome = persistentOutcomeDirective(objectiveText);
  const outcomeText = persistentOutcome ? persistentOutcomeItemText(persistentOutcome) : "";
  return {
    version: 1,
    status: "active",
    objective: objectiveText,
    taskUserEntryId: String(taskUserEntryId || ""),
    items: [],
    continuationCount: 0,
    blockerKey: "",
    blockerTurns: 0,
    violationKey: "",
    violationTurns: 0,
    allowExpansion: false,
    persistentOutcome,
    outcomeItemKey: outcomeText ? normalizeChecklistItem(outcomeText).toLocaleLowerCase() : "",
    redirectRounds: [],
    redirectLevel: 0,
  };
}

function cloneChecklistGoalState(state: ChecklistGoalState): ChecklistGoalState {
  const objective = String(state.objective || "");
  const persistentOutcome = normalizeChecklistItem(state.persistentOutcome || persistentOutcomeDirective(objective));
  const outcomeText = persistentOutcome ? persistentOutcomeItemText(persistentOutcome) : "";
  return {
    ...state,
    objective,
    persistentOutcome,
    outcomeItemKey: outcomeText ? normalizeChecklistItem(outcomeText).toLocaleLowerCase() : "",
    items: state.items.map((item) => ({ ...item })),
    violationKey: String(state.violationKey || ""),
    violationTurns: Math.max(0, Number(state.violationTurns || 0)),
    redirectRounds: Array.isArray(state.redirectRounds) ? state.redirectRounds.slice(-12).map((round) => ({ ...round })) : [],
    redirectLevel: Math.max(0, Math.min(2, Number(state.redirectLevel || 0))),
  };
}

export function resumeChecklistGoalState(
  state: ChecklistGoalState, prompt: unknown, taskUserEntryId: unknown = "",
): ChecklistGoalState {
  const next = cloneChecklistGoalState(state);
  const promptText = String(prompt || "").trim();
  const objective = promptText
    ? `${next.objective}\n\n用户继续要求: ${promptText}`.trim()
    : next.objective;
  const persistentOutcome = next.persistentOutcome || persistentOutcomeDirective(objective);
  const outcomeText = persistentOutcome ? persistentOutcomeItemText(persistentOutcome) : "";
  return {
    ...next,
    status: "active",
    objective,
    taskUserEntryId: String(taskUserEntryId || next.taskUserEntryId || ""),
    allowExpansion: true,
    blockerKey: "",
    blockerTurns: 0,
    violationKey: "",
    violationTurns: 0,
    persistentOutcome,
    outcomeItemKey: outcomeText ? normalizeChecklistItem(outcomeText).toLocaleLowerCase() : "",
  };
}

function ensurePersistentOutcomeItem(state: ChecklistGoalState): ChecklistGoalState {
  const next = cloneChecklistGoalState(state);
  if (!next.persistentOutcome || !next.outcomeItemKey) return next;
  if (!next.items.some((item) => item.key === next.outcomeItemKey)) {
    const text = persistentOutcomeItemText(next.persistentOutcome);
    next.items.push({ text, key: next.outcomeItemKey, done: false });
  }
  return next;
}

export function freezeChecklistGoalContract(
  state: ChecklistGoalState, checklistText: unknown,
): ChecklistGoalState {
  let next = cloneChecklistGoalState(state);
  if (next.status !== "active") return next;
  const parsed = parseAcceptanceChecklist(checklistText);
  if (!parsed?.items.length) return next;
  const candidates = new Map<string, AcceptanceChecklistItem>();
  for (const item of parsed.items) if (!candidates.has(item.key)) candidates.set(item.key, item);
  if (!next.items.length) {
    next.items = [...candidates.values()].map((item) => ({ text: item.text, key: item.key, done: false }));
  } else if (next.allowExpansion) {
    const existing = new Set(next.items.map((item) => item.key));
    for (const item of candidates.values()) {
      if (existing.has(item.key)) continue;
      next.items.push({ text: item.text, key: item.key, done: false });
      existing.add(item.key);
    }
    next.allowExpansion = false;
  }
  next = ensurePersistentOutcomeItem(next);
  return next;
}

function validChecklistGoalState(value: any): value is ChecklistGoalState {
  return value?.version === 1 && ["inactive", "active", "complete", "blocked"].includes(value?.status) &&
    (value?.persistentOutcome === undefined || typeof value.persistentOutcome === "string") &&
    (value?.outcomeItemKey === undefined || typeof value.outcomeItemKey === "string") &&
    Array.isArray(value?.items) && value.items.every((item: any) =>
      typeof item?.text === "string" && typeof item?.key === "string" &&
      (item?.done === undefined || typeof item.done === "boolean"));
}

export function latestChecklistGoalState(entries: any[]): ChecklistGoalState | null {
  let latest: ChecklistGoalState | null = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type !== "custom" || entry?.customType !== CHECKLIST_STATE_TYPE) continue;
    if (validChecklistGoalState(entry.data)) latest = cloneChecklistGoalState(entry.data);
  }
  return latest;
}

type AcceptanceChecklistBlock = {
  start: number;
  end: number;
  items: Array<{ marker: string; text: string }>;
};

type ScannedLine = { body: string; start: number; end: number; fenced: boolean };

function scanFencedLines(source: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let offset = 0;
  let fence: "`" | "~" | "" = "";
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline + 1;
    const body = source.slice(offset, end).replace(/\r?\n$/u, "");
    const fenceMatch = body.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = "";
      // fence 标记行自身视作 fenced:既不当 header 也不当折叠行。
      lines.push({ body, start: offset, end, fenced: true });
    } else {
      lines.push({ body, start: offset, end, fenced: Boolean(fence) });
    }
    offset = end;
  }
  return lines;
}

function firstAcceptanceChecklistBlock(value: unknown): AcceptanceChecklistBlock | null {
  const lines = scanFencedLines(String(value || ""));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.fenced || line.body.trim() !== CHECKLIST_HEADER) continue;
    const rawItems: Array<{ marker: string; text: string }> = [];
    let end = line.end;
    for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
      const itemLine = lines[itemIndex];
      if (!itemLine.body.trim() && !rawItems.length) { end = itemLine.end; continue; }
      const match = itemLine.body.match(/^\s*[-*]\s*\[([^\]\r\n]*)\]\s*(.+?)\s*$/u);
      if (!match) break;
      rawItems.push({ marker: String(match[1] || "").trim(), text: match[2] });
      end = itemLine.end;
    }
    if (rawItems.length) return { start: line.start, end, items: rawItems };
  }
  return null;
}

// 完成态折叠形态:全部冻结合同项完成后,回复可用一行代替全项复述。gate 端只认
// N/N 与合同项数完全一致的声明;fence 内、未冻结合同、数字不符一律不算。
const COLLAPSED_CHECKLIST_LINE = /^\s*【验收清单】\s*(\d+)\s*\/\s*(\d+)\s*全部完成\s*[。.!！]?\s*$/u;

export function collapsedAcceptanceChecklist(value: unknown):
  { done: number; total: number; start: number; end: number } | null {
  for (const line of scanFencedLines(String(value || ""))) {
    if (line.fenced) continue;
    const match = line.body.match(COLLAPSED_CHECKLIST_LINE);
    if (match) return { done: Number(match[1]), total: Number(match[2]), start: line.start, end: line.end };
  }
  return null;
}

export function parseAcceptanceChecklist(text: unknown): AcceptanceChecklist | null {
  const block = firstAcceptanceChecklistBlock(text);
  if (!block) return null;
  const items: AcceptanceChecklistItem[] = [];
  const counts = new Map<string, number>();
  for (const raw of block.items) {
    const marker = raw.marker;
    const textValue = normalizeChecklistItem(raw.text);
    if (!textValue) continue;
    const key = textValue.toLocaleLowerCase();
    const state = /^[xX]$/u.test(marker) ? "done" : marker === "" ? "open" : "invalid";
    items.push({ text: textValue, key, marker, state });
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1)
    .map(([key]) => items.find((item) => item.key === key)?.text || key);
  return {
    items,
    open: items.filter((item) => item.state !== "done").map((item) => item.text),
    done: items.filter((item) => item.state === "done").length,
    invalid: items.filter((item) => item.state === "invalid")
      .map((item) => `[${item.marker}] ${item.text}`),
    duplicates,
  };
}

export function checklistBlockerFingerprint(text: unknown, openItems: string[]): string {
  // 清单项目本身可能写着“修复工具不可用”，不能把任务名误当成真实阻塞；只看清单外叙述。
  const source = stripAcceptanceChecklist(text);
  if (!EXPLICIT_BLOCKER.test(source)) return "";
  const category = /(?:凭据|登录|认证|密钥|token|口令)/iu.test(source) ? "credentials"
    : /(?:权限|授权|管理员|访问被拒)/u.test(source) ? "permission"
    : /(?:网络|连接|不可达|超时|DNS|TLS|SSH)/iu.test(source) ? "network"
    : /(?:工具|通道|调用|执行层)/u.test(source) ? "tooling"
    : /(?:需要你|请你|等待用户|未提供)/u.test(source) ? "user-input"
    : "external";
  const keys = [...new Set(openItems.map((item) => normalizeChecklistItem(item).toLocaleLowerCase()))].sort();
  return `${category}:${keys.join("|")}`;
}

export function checklistGateDecision(input: {
  assistantText: unknown;
  stopReason: unknown;
  pendingMessages: boolean;
  hasGoalGate: boolean;
  state?: ChecklistGoalState | null;
  objective?: unknown;
  taskUserEntryId?: unknown;
  contractText?: unknown;
  deterministicVerified?: boolean;
  blockerTurnsRequired?: number;
  violationTurnsRequired?: number;
}): ChecklistGateResult {
  const unchanged = (reason: string, state: ChecklistGoalState | null = input.state || null): ChecklistGateResult =>
    ({ trigger: false, reason, open: [], violations: [], state });
  if (input.stopReason !== "stop") return unchanged("not-stop");
  if (input.pendingMessages) return unchanged("pending-messages");
  if (input.hasGoalGate) return unchanged("goal-gate-owns-completion");

  let state = input.state ? cloneChecklistGoalState(input.state) : null;
  if (input.deterministicVerified) {
    if (state) state = {
      ...state, status: "complete", blockerKey: "", blockerTurns: 0,
      violationKey: "", violationTurns: 0,
    };
    return unchanged("deterministic-host-verified", state);
  }
  if (state?.status === "inactive") return unchanged("goal-inactive", state);
  if (state?.status === "complete") return unchanged("goal-complete", state);
  if (state?.status === "blocked") return unchanged("goal-blocked", state);

  const parsed = parseAcceptanceChecklist(input.assistantText);
  const initialContract = parseAcceptanceChecklist(input.contractText) || parsed;
  if (!state) {
    if (!initialContract) return unchanged("no-checklist", null);
    state = createChecklistGoalState(input.objective, input.taskUserEntryId);
  }
  state = freezeChecklistGoalContract(state, input.contractText || input.assistantText);

  const violations: string[] = [];
  // 完成态折叠:完整清单缺席时才看折叠行;完整清单在场时以它为准。
  // 折叠只在 N/N 与冻结合同项数完全一致时等价于"全部 [x]",否则给出具体诊断打回。
  let effective = parsed;
  let collapseViolation = "";
  if (!effective) {
    const collapsed = collapsedAcceptanceChecklist(input.assistantText);
    if (collapsed) {
      if (!state.items.length) {
        collapseViolation = "折叠形态在冻结合同前无效;先给出完整【验收清单】并冻结";
      } else if (collapsed.done !== collapsed.total || collapsed.total !== state.items.length) {
        collapseViolation = `折叠清单 ${collapsed.done}/${collapsed.total} 与冻结合同 ${state.items.length} 项不符;须完整清单或正确的 N/N 全部完成`;
      } else {
        effective = {
          items: state.items.map((item) => ({
            text: item.text, key: item.key, marker: "x", state: "done" as const,
          })),
          open: [], done: state.items.length, invalid: [], duplicates: [],
        };
      }
    }
  }
  const parsedItems = effective?.items || [];
  const parsedByKey = new Map<string, AcceptanceChecklistItem>();
  for (const item of parsedItems) if (!parsedByKey.has(item.key)) parsedByKey.set(item.key, item);

  const contractKeys = new Set(state.items.map((item) => item.key));
  if (effective) {
    for (const item of parsedItems) {
      if (!contractKeys.has(item.key)) violations.push(canonicalAddedChecklistViolation(item.text));
      if (item.state === "invalid") violations.push(`禁止的第三状态 [${item.marker}]: ${item.text}`);
    }
    for (const item of effective.duplicates) violations.push(`重复验收项目: ${item}`);
  } else if (collapseViolation) {
    violations.push(collapseViolation);
  }
  // v13 增量协议:done 由 host 持久记账。回复只需声明变化项;缺席=保持既有状态,
  // 不再因"没复述清单"打回。完成仍只能来自显式 [x]/折叠行,防假完成硬度不变。
  for (const contract of state.items) {
    const current = parsedByKey.get(contract.key);
    if (!current) continue;
    if (current.state === "done") contract.done = true;
    else if (current.state === "open") contract.done = false;
  }

  const open: string[] = [];
  if (!state.items.length) {
    open.push("先给出仅含 [ ]/[x] 的可验证验收清单并冻结合同");
  } else {
    for (const contract of state.items) {
      if (!contract.done) open.push(contract.text);
    }
  }
  const formatViolations = [...violations];
  let persistentReason = "";
  const outcome = persistentOutcomeDecision({
    objective: state.objective,
    assistantText: input.assistantText,
    target: state.persistentOutcome,
  });
  if (outcome.required && !outcome.attained) {
    persistentReason = outcome.reason;
    const outcomeItem = state.items.find((item) => item.key === state.outcomeItemKey);
    open.push(outcomeItem?.text || persistentOutcomeItemText(outcome.target));
    violations.push(outcome.unmet
      ? "回复正文明确报告持续终态仍未达到，禁止用保护动作或 [x] 冒充完成"
      : "持续终态缺少正向达成证据，不能标记 complete");
  }
  const uniqueOpen = [...new Set(open)];
  if (!uniqueOpen.length && !violations.length) {
    state.status = "complete";
    state.blockerKey = "";
    state.blockerTurns = 0;
    state.violationKey = "";
    state.violationTurns = 0;
    return { trigger: false, reason: "goal-complete", open: [], violations: [], state };
  }

  state.status = "active";
  const violationKey = checklistViolationFingerprint(formatViolations);
  let repeatedViolation = false;
  if (violationKey) {
    state.violationTurns = state.violationKey === violationKey ? state.violationTurns + 1 : 1;
    state.violationKey = violationKey;
    repeatedViolation = state.violationTurns >=
      Math.max(1, input.violationTurnsRequired || CHECKLIST_VIOLATION_TURNS);
  } else {
    state.violationKey = "";
    state.violationTurns = 0;
  }
  const blockerKey = checklistBlockerFingerprint(input.assistantText, uniqueOpen);
  if (blockerKey) {
    state.blockerTurns = state.blockerKey === blockerKey ? state.blockerTurns + 1 : 1;
    state.blockerKey = blockerKey;
    if (state.blockerTurns >= Math.max(1, input.blockerTurnsRequired || CHECKLIST_BLOCKER_TURNS)) {
      state.status = "blocked";
      return { trigger: false, reason: "same-blocker-three-turns", open: uniqueOpen, violations, state };
    }
  } else {
    state.blockerKey = "";
    state.blockerTurns = 0;
  }
  state.continuationCount += 1;
  return {
    trigger: true,
    reason: blockerKey ? "blocker-retry" : persistentReason ||
      (repeatedViolation ? "repeated-checklist-violation" :
        collapseViolation ? "invalid-collapsed-checklist" :
          formatViolations.length ? "invalid-checklist" : "open-items"),
    open: uniqueOpen,
    violations,
    state,
  };
}

function stableAlphaHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) { hash ^= char.codePointAt(0) || 0; hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16).padStart(8, "0").replace(/[0-9a-f]/gu, (char) => "abcdefghijklmnop"[Number.parseInt(char, 16)]);
}

export function checklistRedirectEvidence(result: ChecklistGateResult, assistantText: unknown): string {
  const body = stripAcceptanceChecklist(assistantText);
  const signals = [
    ...(body.match(/\b(?:PASS|FAIL|ERROR|BLOCKED|ACTIVE|COMPLETE)[A-Z0-9_.:-]*/gu) || []),
    ...(body.match(/\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/gu) || []),
    ...(body.match(/\b[0-9a-f]{16,64}\b/giu) || []),
  ].slice(-80);
  const progressBasis = signals.length ? signals.join("|") : normalizeChecklistItem(body).slice(-2000);
  const open = [...new Set(result.open.map((item) => normalizeChecklistItem(item)))].sort().join("|");
  const reason = /(?:invalid-checklist|repeated-checklist-violation)/u.test(result.reason) ? "checklist-violation" : result.reason;
  return `failure checklist reason=${reason} open=${open} progress=${stableAlphaHash(progressBasis)}`;
}

export function formatChecklistGateContinuation(result: ChecklistGateResult, continuation: number): string {
  const openKeys = new Set(result.open.map((item) => normalizeChecklistItem(item).toLocaleLowerCase()));
  const contracts = result.state?.items || [];
  const openContracts = contracts.filter((item) => openKeys.has(item.key));
  const contractBlock = contracts.length
    ? (openContracts.length
      ? `未完成项(host 已持久记账,无需复述全清单):\n${openContracts.map((item) => `- [ ] ${item.text}`).join("\n")}`
      : "全部合同项已声明完成。")
    : "尚未冻结有效验收合同；下一回复先给出仅含 [ ]/[x] 的完整【验收清单】(仅此一次)并同步写入证据文件。";
  const diagnostics = result.violations.length
    ? `\n\n格式违规诊断（不是验收项目，禁止复制进清单）:\n${result.violations.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `目标仍为 ACTIVE(自动续跑第 ${continuation} 轮)。${contractBlock}${diagnostics}\n\n继续执行原始任务。执行策略硬约束:当前路径若受未来时间、外部事件或同路失败阻塞，禁止用 sleep、轮询或超长 timeout 维持前台会话；先复核 nextAction 是否过期，生成至少 2 条相互独立、尚未实测且不违反硬边界的合法方向 frontier，按预期信息增益/成本排序并立即执行第一条。不得把“禁止同路补丁”自行扩大为“禁止所有新方向”。仅当全部合法方向都有耗尽证据时，才把受阻分支持久化 deferred 并释放当前 run；deferred 不是终态完成。\n\n新完成的项在回复中以【验收清单】开头的小块增量声明:只列变化项,"- [x] <与合同原文逐字一致>"表示已有可验证证据,"- [ ]"表示重开;未变化项不要复述。禁止 [~] 或任何第三状态，禁止新增、改名合同项目。全部合同项完成后只写一行“【验收清单】${contracts.length || "N"}/${contracts.length || "N"} 全部完成”。命令输出、日志等证据细节写入任务工作区证据文件(默认 acceptance-evidence.md)，正文只留每项一句结论、关键数字与文件指针。如果确有外部阻塞，保留对应项未完成并报告可验证证据。对冻结持续终态，“已核验未达标/已禁止交付/任务保持开放”都不是完成，只有正文中的正向达成证据才能将该终态标为 [x]。`;
}

export const renderChecklistContinuation = formatChecklistGateContinuation;

export function goalGateVerdict(input: {
  exitCode: number | null; timedOut?: boolean; attempts: number; max: number;
}): "pass" | "retry" | "exhausted" | "fail-open" {
  if (input.timedOut || input.exitCode === null) return "fail-open";
  if (input.exitCode === 0) return "pass";
  return input.attempts >= input.max ? "exhausted" : "retry";
}

// 换向器按需装载;装载失败置 false 永久跳过,门行为回落原状(fail-open)。
let redirectorModule: any = null;
async function loadRedirector() {
  if (redirectorModule !== null) return redirectorModule;
  try { redirectorModule = await import(pathToFileURL(REDIRECTOR_MJS).href); }
  catch (error) { redirectorModule = false; log(`GOAL_REDIRECT LOAD_FAIL ${String(error).slice(0, 120)}`); }
  return redirectorModule;
}

function execGoalGate(command: string, cwd?: string): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = exec(command, {
      windowsHide: true, timeout: GOAL_GATE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8",
      // 目标门命令在任务工作区执行;拿不到合法 cwd 时保持旧行为(继承宿主 cwd)。
      ...(cwd && fs.existsSync(cwd) ? { cwd } : {}),
    }, (error: any, stdout, stderr) => {
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.stdin?.unref?.();
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

export function firstChecklistForLatestUser(messages: any[]): string {
  const source = Array.isArray(messages) ? messages : [];
  let latestUser = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index]?.role === "user") latestUser = index;
  }
  for (let index = latestUser + 1; index < source.length; index += 1) {
    if (source[index]?.role !== "assistant") continue;
    const text = assistantText(source[index]);
    if (text.includes(CHECKLIST_HEADER)) return text;
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  // 总开关:Best-of-N 子进程带 LOP_CHAIN_DISABLE=1 防递归链(候选内不再起 S2-S8/预审/门),
  // 兼作全链急停。
  if (process.env.LOP_CHAIN_DISABLE === "1") return;
  const sessionId = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lastPrompt = "";
  let lastPhase: Record<string, unknown> = {};
  let lastResolved: any = null;
  let historyRetryActive = false;
  let historyRetryCount = 0;
  let completionRetryActive = false;
  let goalGateRetryActive = false;
  let checklistRetryActive = false;
  let runtimeReloadQueued = false;
  let checklistGoal: ChecklistGoalState | null = null;
  let runHadTool = false;
  let turnMutated = false;
  // 侧车记忆标记(写入侧 v3.1):模型把标记 JSON 写到 memory-marker/*.json,不再放正文。
  let turnMemoryMarker = "";
  let turnToolFiles: string[] = [];
  let turnToolCommands: string[] = [];
  let memoryGateRetryActive = false;
  // 目标门状态:会话生命周期内持续,直到用户显式关闭或被新目标门覆盖。
  // auto=由 auto-gate 生成安装(exhausted 时降级清门而非锁死会话);
  // bestOfNUsed=单门生命周期内 fan-out 只允许一次(防额度爆炸);
  // planPending=方案先行分轮态(上一轮只作答未动手,下一轮实施);planLevels=已出过方案轮的升级 level。
  let goalGate: { command: string; attempts: number; rounds: any[]; level: number; auto?: boolean; bestOfNUsed?: boolean; planPending?: boolean; planLevels?: number[] } | null = null;
  // 显式【多候选】N 指令(会话态,新的人工消息重置)。
  let pendingBestOfN: { n: number } | null = null;
  let turnStartedAt = 0;
  let modelTurnStartedAt = 0;
  let deterministicDraftActive = false;
  let modelTurnDurations: number[] = [];
  let modelTtfbDurations: number[] = [];
  let toolDurationMs = 0;
  const toolStarts = new Map<string, number>();
  // 扩展装载即后台补扫,第一条 prompt 只等待尚未完成的尾部;后续 S3 不再扫描。
  // S3 出关键路径(2026-08-31 循环验收):status 新鲜(默认 ≤10min)直接跳扫——
  // 多会话日实测 97 扫/日全为重复枚举;parseSignature 迁移日单扫 60-164s 且阻塞首轮。
  const SCAN_FRESH_MS = Number(process.env.LOP_SCAN_FRESH_MS || 600000);
  const scanFreshAge = (() => {
    try {
      const home = process.env.LOP_MEMORY_HOME;
      if (!home) return Infinity;
      const s = JSON.parse(fs.readFileSync(path.join(home, "status.json"), "utf8"));
      const at = Date.parse(String(s?.updatedAt || ""));
      return Number.isFinite(at) ? Date.now() - at : Infinity;
    } catch { return Infinity; }
  })();
  const scanFresh = scanFreshAge < SCAN_FRESH_MS;
  if (scanFresh) log(`S3 STARTUP_SCAN skip-fresh age=${Math.round(scanFreshAge / 1000)}s`);
  // 首轮超时放行后 memoryReady 可能在无等待者时 reject,吞掉防 unhandledRejection
  // (真实错误已由 STARTUP_SCAN_FAIL 日志承载)。
  const memoryReady = process.env.PI_CHAIN_SKIP_STARTUP_SCAN === "1" || scanFresh
    ? Promise.resolve({ physicalSources: 0, changedSources: 0, canonicalized: 0 })
    : (async () => {
    // 修正1(2026-08-31):scanHistory 内含大段同步 sqlite/解析,进程内跑会饿死事件循环
    // (实测 2s 等待上限的 race 定时器打不进,首轮 s3 仍被压满整个扫描时长)。
    // 改 detached+windowsHide 子进程,首轮零阻塞;并发由 scan.lock 互斥,新鲜度由
    // status.json 跳扫收敛;扫描结果不再回填首轮(s3ScanSources 记 0)。
    try {
      const { spawn } = await import("node:child_process");
      const runner = path.join(CHAIN_DIR, "scan-runner.mjs");
      if (!fs.existsSync(runner)) {
        log(`S3 STARTUP_SCAN_FAIL runner missing: ${runner}`);
        return { physicalSources: 0, changedSources: 0, canonicalized: 0 };
      }
      const child = spawn(process.execPath, [runner], {
        detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env },
      });
      child.unref();
      log(`S3 STARTUP_SCAN spawned pid=${child.pid}`);
      return { physicalSources: 0, changedSources: 0, canonicalized: 0, spawned: true };
    } catch (error) {
      log(`S3 STARTUP_SCAN_FAIL ${String(error).slice(0, 200)}`);
      return { physicalSources: 0, changedSources: 0, canonicalized: 0 };
    }
  })();
  memoryReady.catch(() => {});
  // S6 打回轮标记:等价 Claude 侧 stop_hook_active,防预审递归打回。
  let advRedelivery = false;
  let advDeliveredTurn = false; // 本轮已投递过预审 context,防每次 tool_call 重复注入

  function setChecklistGoal(next: ChecklistGoalState | null, reason: string): void {
    const before = checklistGoal ? JSON.stringify(checklistGoal) : "";
    const after = next ? JSON.stringify(next) : "";
    checklistGoal = next ? cloneChecklistGoalState(next) : null;
    if (before === after) return;
    try {
      const persisted = next || { ...createChecklistGoalState(), status: "inactive" as const };
      (pi as any).appendEntry?.(CHECKLIST_STATE_TYPE, persisted);
      log(`CHECKLIST_GOAL STATE status=${persisted.status} reason=${reason} items=${persisted.items.length} turns=${persisted.continuationCount}`);
    } catch (error) {
      log(`CHECKLIST_GOAL STATE_FAIL ${String(error).slice(0, 160)}`);
    }
  }

  function appendRunControl(action: "cancel", reason: string, userEntryId = ""): void {
    try {
      (pi as any).appendEntry?.(RUN_CONTROL_TYPE, {
        version: 1, action, reason, userEntryId, at: new Date().toISOString(),
      });
      log(`RUN_CONTROL action=${action} reason=${reason} user=${userEntryId || "-"}`);
    } catch (error) {
      log(`RUN_CONTROL FAIL ${String(error).slice(0, 160)}`);
    }
  }

  function restoreChecklistGoal(ctx: any): void {
    try {
      const restored = latestChecklistGoalState(ctx?.sessionManager?.getBranch?.() || []);
      checklistGoal = restored;
      if (restored) log(`CHECKLIST_GOAL RESTORE status=${restored.status} items=${restored.items.length} turns=${restored.continuationCount}`);
    } catch (error) {
      checklistGoal = null;
      log(`CHECKLIST_GOAL RESTORE_FAIL ${String(error).slice(0, 160)}`);
    }
  }

  pi.on("session_start", async (_event: any, ctx: any) => restoreChecklistGoal(ctx));
  pi.on("session_tree", async (_event: any, ctx: any) => restoreChecklistGoal(ctx));

  // 以后覆盖活动扩展文件时，旧 runner 在下一次真实用户轮检测到磁盘版本漂移，先排队
  // 一个命令级 reload。pending message 会让旧完成门放行本轮，不再生成旧版自动续跑。
  (pi as any).registerCommand?.("lop-chain-reload", {
    description: `Reload lop-chain after the active extension file changes (${LOP_CHAIN_RUNTIME_VERSION})`,
    handler: async (_args: string, ctx: any) => {
      await ctx.reload();
      return;
    },
  });
  (pi as any).registerCommand?.("lop-goal-cancel", {
    description: "Cancel the active checklist goal and suppress durable automatic recovery",
    handler: async (_args: string, ctx: any) => {
      const userTurn = latestUserTurn(ctx?.sessionManager?.getBranch?.() || []);
      if (checklistGoal) setChecklistGoal({ ...checklistGoal, status: "inactive" }, "explicit-user-cancel-command");
      appendRunControl("cancel", "command", userTurn.id);
      ctx?.ui?.notify?.("当前目标已取消；异常恢复监督器不会续跑本目标。", "info");
    },
  });

  pi.on("context", (event: any, ctx: any) => {
    const original = Array.isArray(event?.messages) ? event.messages : [];
    let messages = scopeLopChainContext(original);
    const removed = original.length - messages.length;
    const sanitized = messages.filter((message) =>
      ["compactionSummary", "branchSummary"].includes(message?.role) && !original.includes(message)
    ).length;
    if (removed || sanitized) log(`CONTEXT removed=${removed} sanitizedSummary=${sanitized}`);
    try {
      const tokens = ctx?.getContextUsage?.()?.tokens;
      const overLine = typeof tokens === "number" && tokens > COMPACT_TRIGGER_TOKENS;
      if (frozenKeepFrom === null || overLine) {
        if (overLine) {
          // (重)冻结轮:按当前尾部 50k 重算边界并定格。这是唯一允许的缓存 miss 轮。
          const r = microcompact(messages);
          frozenKeepFrom = r.keepFrom;
          freezeCount += 1;
          if (r.trimmed) messages = r.messages;
          lastTrimCount = r.trimmed;
          log(`COMPACT_GUARD freeze#${freezeCount} tokens=${tokens} keepFrom=${r.keepFrom} trim n=${r.trimmed} tok≈${r.beforeTok}->${r.afterTok} keep=${TRIM_KEEP_RECENT_TOKENS}`);
          metric({ sessionId, compactGuard: true, freeze: freezeCount, trimCount: r.trimmed, trimBeforeTok: r.beforeTok, trimAfterTok: r.afterTok });
        }
      } else {
        // 冻结期:复用定格边界,同一裁剪集逐字节复现,新消息只追加。
        const r = microcompact(messages, frozenKeepFrom);
        if (r.trimmed) messages = r.messages;
        if (r.trimmed !== lastTrimCount) {
          lastTrimCount = r.trimmed;
          log(`COMPACT_GUARD frozen#${freezeCount} keepFrom=${frozenKeepFrom} trim n=${r.trimmed}`);
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
    if (event?.message?.role !== "assistant") return;
    // 每个模型请求记一行用量:cacheRead/input 是稳定前缀缓存率的直接测量源。
    const u = event.message.usage;
    if (u && typeof u.input === "number" && (u.input > 0 || u.cacheRead > 0)) {
      metric({ sessionId, kind: "usage", uIn: u.input, uCached: u.cacheRead ?? 0, uOut: u.output ?? 0, uTotal: u.totalTokens ?? 0 });
    }
    if (!modelTurnStartedAt) return;
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
  // 冻结边界:null=未触发。触发后 keepFrom 定格,投影逐字节稳定(前缀缓存友好);
  // 真实用量再次越线才重冻——缓存 miss 只发生在(重)冻结轮,不再每轮滑动。
  let frozenKeepFrom: number | null = null;
  let freezeCount = 0;
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
  function microcompact(messages: any[], keepFromOverride?: number): { messages: any[]; trimmed: number; beforeTok: number; afterTok: number; keepFrom: number } {
    const est = messages.map(estimateMessageTokens);
    const beforeTok = est.reduce((a, b) => a + b, 0);
    let keepFrom = messages.length;
    if (typeof keepFromOverride === "number") {
      keepFrom = Math.max(0, Math.min(keepFromOverride, messages.length));
    } else {
      let acc = 0;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        acc += est[i];
        keepFrom = i;
        if (acc >= TRIM_KEEP_RECENT_TOKENS) break;
      }
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
    return { messages: out, trimmed, beforeTok, afterTok: beforeTok - saved, keepFrom };
  }
  pi.on("session_compact", () => { frozenKeepFrom = null; lastTrimCount = -1; });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const prompt = String(event?.prompt || "");
    if (!prompt) return;
    const supervisorRecovery = prompt.startsWith(RUN_SUPERVISOR_RECOVERY_PREFIX);
    if (!runtimeReloadQueued) {
      try {
        const diskVersion = runtimeVersionFromSource(fs.readFileSync(MODULE_FILE, "utf8"));
        if (diskVersion && diskVersion !== LOP_CHAIN_RUNTIME_VERSION) {
          runtimeReloadQueued = true;
          log(`RUNTIME_DRIFT loaded=${LOP_CHAIN_RUNTIME_VERSION} disk=${diskVersion} queue=/lop-chain-reload`);
          pi.sendUserMessage("/lop-chain-reload", { deliverAs: "followUp" });
        }
      } catch (error) {
        log(`RUNTIME_DRIFT_CHECK_FAIL ${String(error).slice(0, 160)}`);
      }
    }
    if (advRedelivery) { log("S6 REDELIVERY TURN skip inject"); return; }
    if (goalGateRetryActive) { log(`GOAL_GATE retry=${goalGate?.attempts || 0}/${GOAL_GATE_MAX} skip reinject`); return; }
    if (checklistRetryActive) { log(`CHECKLIST_GOAL continuation=${checklistGoal?.continuationCount || 0} skip reinject`); return; }
    if (historyRetryActive) { log(`S3 USAGE_RETRY ${historyRetryCount}/2 skip reinject`); return; }
    if (completionRetryActive) { log("COMPLETION_GUARD retry skip reinject"); return; }
    if (memoryGateRetryActive) { log("MEMORY_GATE retry skip reinject"); return; }
    turnStartedAt = performance.now();
    turnMutated = false;
    turnMemoryMarker = "";
    turnToolFiles = [];
    turnToolCommands = [];
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
    const taskCwd = typeof (ctx as any)?.cwd === "string" ? (ctx as any).cwd : process.cwd();
    // 目标门声明/关闭只认真实用户消息;续跑注入轮 prompt 为空,走不到这里,
    // 因此 attempts 预算只被新的人工消息重置。
    const gateDirective = parseGoalGateDirective(prompt);
    if (gateDirective.action === "set") {
      goalGate = { command: gateDirective.command, attempts: 0, rounds: [], level: 0 };
      log(`GOAL_GATE SET cmd=${gateDirective.command.slice(0, 160)}`);
    } else if (gateDirective.action === "clear") {
      if (goalGate) log("GOAL_GATE CLEAR");
      goalGate = null;
      pendingBestOfN = null;
    } else if (goalGate && !supervisorRecovery) {
      goalGate.attempts = 0;
      goalGate.rounds = [];
      goalGate.level = 0;
      goalGate.bestOfNUsed = false;
    }
    // 显式【多候选】N:goal-gate 失败轮 fan-out N 路并行候选,由门命令筛选。
    try {
      const bon: any = await import(pathToFileURL(BEST_OF_N_MJS).href);
      const directive = bon.parseBestOfNDirective(prompt);
      if (directive) {
        pendingBestOfN = directive;
        log(`BESTOFN DIRECTIVE n=${directive.n}`);
      }
    } catch (e) { log(`BESTOFN PARSE FAIL_OPEN ${String(e).slice(0, 120)}`); }

    // 目标一旦 active 就跨普通追问/授权回复保持 active；不再用动作词把它自动降为 inactive。
    // 动作识别只负责首次建目标，异常续接由宿主持久化 supervisor 兜底。只有显式取消
    // 文本或 /lop-goal-cancel 才写入 durable cancel marker。
    const userTurn = latestUserTurn(ctx?.sessionManager?.getBranch?.() || []);
    if (supervisorRecovery) {
      log("RUN_SUPERVISOR recovery keeps existing goal state");
    } else if (isGoalCancellationPrompt(prompt)) {
      if (checklistGoal) setChecklistGoal({ ...checklistGoal, status: "inactive" }, "explicit-user-cancel-text");
      appendRunControl("cancel", "text", userTurn.id);
    } else if (checklistGoal?.status === "blocked") {
      setChecklistGoal(resumeChecklistGoalState(checklistGoal, prompt, userTurn.id), "user-resume");
    } else if (checklistGoal?.status === "active") {
      if ((isExecutionRequest(prompt) || isContextDependentHistoryPrompt(prompt)) && checklistGoal.items.length) {
        setChecklistGoal({
          ...checklistGoal,
          objective: `${checklistGoal.objective}\n\n用户追加要求: ${prompt}`.trim(),
          taskUserEntryId: userTurn.id || checklistGoal.taskUserEntryId,
          allowExpansion: true,
          blockerKey: "",
          blockerTurns: 0,
          violationKey: "",
          violationTurns: 0,
        }, "user-extends-active-goal");
      }
      // 普通问题/授权信息/短回复不改变 active 状态。
    } else if (checklistGoal?.status === "complete" && isGoalContinuationPrompt(prompt)) {
      setChecklistGoal(resumeChecklistGoalState(checklistGoal, prompt, userTurn.id), "user-reopens-complete-goal");
    } else if (isExecutionRequest(prompt) || gateDirective.action === "set") {
      setChecklistGoal(createChecklistGoalState(prompt, userTurn.id), "user-starts-goal");
    }
    const contexts: string[] = [];
    const phase: Record<string, unknown> = {};
    if (checklistGoal?.persistentOutcome) {
      contexts.push([
        "<persistent-outcome-gate>",
        "用户冻结了持续终态；核验‘未达到’、执行禁止交付或保持任务开放，只是过程状态，绝不能冒充终态完成。",
        // "必须原样包含"曾被理解为每轮清单在场并含该项 → 教唆全量复述;改为首轮纳入+宿主记账。
        `首次冻结【验收清单】时必须原样纳入以下 host 项；此后由宿主持续记账，无需每轮复述清单，仅在该项状态变化时以增量块声明。终态未取得正向证据时保持 [ ]，只有正文给出正向达成证据后才可改为 [x]：${persistentOutcomeItemText(checklistGoal.persistentOutcome)}`,
        "</persistent-outcome-gate>",
      ].join("\n"));
    }

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
      // S3 出关键路径:首条 prompt 对扫描最多等 2s,超时即放行(查询用现有索引,
      // 新鲜度由后台扫描补齐;扫描自身完成/失败仍由 STARTUP_SCAN 日志记录)。
      const scan: any = await Promise.race([
        memoryReady.catch((error) => ({ scanFailed: String(error).slice(0, 120) })),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }),
          Number(process.env.LOP_SCAN_FIRST_WAIT_MS || 2000))),
      ]);
      if (scan?.timedOut) log("S3 SCAN_WAIT timeout=2s 放行(后台继续)");
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
            // 写入侧 v3:resolver 只认 expansionTerms/expansionAllTerms 扩池,此前扩写二次检索是空操作。
            expansionTerms: expanded.historyTerms.slice(0, 8),
            expansionAllTerms: expanded.historyTerms,
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

    // S6 后台对抗预审起审(v2 三路正交盲聚合):agent_end 消费,外部能力 fail-open。
    const t6 = performance.now();
    try {
      const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
      const started = adv.startBackgroundReview({ session_id: sessionId, prompt, cwd: taskCwd });
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

    // auto-gate 起审:执行型任务且无显式【目标门】时,后台生成只读验收命令(双红纪律),
    // agent_end 消费安装。显式门永远优先;问答/上下文短语不生成;fail-open。
    try {
      if (process.env.LOP_AUTO_GATE !== "0" && !goalGate && gateDirective.action === "none" &&
          isExecutionRequest(prompt) && !isContextDependentHistoryPrompt(prompt)) {
        const auto: any = await import(pathToFileURL(AUTO_GATE_MJS).href);
        const adv: any = await import(pathToFileURL(ADVERSARY_MJS).href);
        auto.startAutoGate({
          session_id: sessionId, prompt: checklistGoal?.objective || prompt,
          cwd: taskCwd, bridge: adv.callBridgeText, log,
        });
        phase.autoGateStart = true;
      }
    } catch (e) { log(`AUTO_GATE START FAIL_OPEN ${String(e).slice(0, 120)}`); }

    phase.preModelMs = +(performance.now() - turnStartedAt).toFixed(1);
    lastPhase = phase;
    log(`INJECT s2=${phase.s2Ms}ms(${phase.s2Ratio}x) s3=${phase.s3Ms}ms(hit=${phase.s3Hit},exp=${phase.s3ViaExpansion},reason=${phase.s3Reason}) s4=${phase.s4Ms}ms(actual=${phase.s4ActualCount || 0},oracle=${phase.s4OracleCount || 0},exp=${(phase.s4FromExpansion as string[])?.length || 0}) s5=${phase.s5Ms}ms(${phase.s5Kind || phase.s5Reason}) bytes=${Buffer.byteLength(contexts.join("\n\n"))}`);
    if (!contexts.length) return;
    return {
      message: { customType: "lop-chain", content: contexts.join("\n\n"), display: false },
    };
  });

  // S7 工具红线:复用 rules-pretool;S6 预审就绪则执行阶段早投递(防长任务超 TTL)
  pi.on("tool_call", async (event: any, ctx: any) => {
    runHadTool = true;
    // 工具锚点与状态变更记账(写入侧 v3):供 Stop 落账结构化锚点与记忆标记门判定;失败留痕不阻断。
    try {
      const toolName = String(event?.toolName || "").trim().toLowerCase();
      const input = event?.input && typeof event.input === "object" ? event.input : {};
      const commandValue = input.command ?? input.cmd ?? "";
      const command = Array.isArray(commandValue) ? commandValue.join(" ") : String(commandValue || "");
      const file = String(input.path || input.file_path || input.filePath || input.notebook_path || "").trim();
      const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
      const sidecarMarker = String(mem.memoryMarkerFromToolUse?.(toolName, input) || "");
      if (sidecarMarker) {
        turnMemoryMarker = sidecarMarker;
        log("MEMORY_MARKER sidecar captured");
      } else if (MEMORY_MUTATING_TOOL.test(toolName) || (command && MEMORY_MUTATING_COMMAND.test(command))) turnMutated = true;
      if (sidecarMarker) { /* 侧车写入不进锚点 */ } else {
      if (file && turnToolFiles.length < 16 && !turnToolFiles.includes(file)) turnToolFiles.push(file);
      if (command && turnToolCommands.length < 8) turnToolCommands.push(command.replace(/\s+/g, " ").slice(0, 160));
      }
    } catch (e) { log(`MEMORY_ANCHORS FAIL_OPEN ${String(e).slice(0, 120)}`); }
    const toolName = String(event?.toolName || "");
    if (/^bash$/iu.test(toolName)) {
      if (!event.input || typeof event.input !== "object") event.input = {};
      const foreground = foregroundBashDecision(event.input);
      let branch: any[] = [];
      try { branch = ctx?.sessionManager?.getBranch?.() || []; } catch {}
      const stale = staleNextActionDecision(branch);
      if (foreground.action === "block") {
        log(`FOREGROUND_WAIT BLOCK tool=${toolName} requested=${foreground.requestedTimeoutSeconds ?? "none"} limit=${foreground.timeoutSeconds} wallClock=${foreground.wallClockWait} staleNextAction=${stale.stale}`);
        metric({ sessionId, hardGate: "foreground-wait", tool: toolName, requestedTimeout: foreground.requestedTimeoutSeconds, timeoutLimit: foreground.timeoutSeconds, wallClockWait: foreground.wallClockWait, staleNextAction: stale.stale });
        const frontier = stale.directive || "当前前台路径被 host deadline 拒绝。禁止改写成另一种 sleep/轮询；先生成至少 2 条相互独立、尚未实测且不违反硬边界的合法方向 frontier，并立即执行信息增益/成本最高的一条。只有全部方向均有耗尽证据时才允许持久化 deferred。";
        return { block: true, reason: `LOP_FOREGROUND_WAIT_BLOCK: ${foreground.reason}。${frontier}` };
      }
      if (foreground.action === "cap") {
        event.input.timeout = foreground.timeoutSeconds;
        log(`FOREGROUND_DEADLINE APPLY tool=${toolName} timeout=${foreground.timeoutSeconds}s wallClock=${foreground.wallClockWait}`);
        metric({ sessionId, hardGate: "foreground-deadline-applied", tool: toolName, timeout: foreground.timeoutSeconds });
      }
    }
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
    const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const assistantMessages = msgs.filter((message) => message?.role === "assistant");
    const lastAssistant = assistantMessages.at(-1);
    const text = assistantText(lastAssistant);
    const firstChecklistText = firstChecklistForLatestUser(msgs);
    let branch: any[] = [];
    try { branch = ctx?.sessionManager?.getBranch?.() || []; } catch {}
    const userTurn = latestUserTurn(branch);
    const prompt = lastPrompt || userTurn.text;

    // 防 before_agent_start 时分支尚未落入当前 user entry，也防本轮中途 reload：
    // agent_end 再按 user entry id 对账。新人工执行请求不能继承旧 complete；“继续”
    // 则原合同重开，自动 follow-up 没有新 user id，不会误触发。
    const newUserTurn = Boolean(userTurn.id && userTurn.id !== checklistGoal?.taskUserEntryId);
    if (newUserTurn && checklistGoal?.status === "complete") {
      if (isGoalContinuationPrompt(prompt)) {
        setChecklistGoal(resumeChecklistGoalState(checklistGoal, prompt, userTurn.id), "agent-end-reopens-complete-goal");
      } else if (isExecutionRequest(prompt) && !prompt.startsWith(RUN_SUPERVISOR_RECOVERY_PREFIX)) {
        // 恢复脚手架只续跑既有目标,不得当新目标 objective(否则 S8 落账键被污染)。
        setChecklistGoal(createChecklistGoalState(prompt, userTurn.id), "agent-end-starts-new-goal");
      }
    } else if (newUserTurn && checklistGoal?.status === "blocked" &&
               (isContextDependentHistoryPrompt(prompt) || isExecutionRequest(prompt))) {
      setChecklistGoal(resumeChecklistGoalState(checklistGoal, prompt, userTurn.id), "agent-end-resumes-blocked-goal");
    } else if (newUserTurn && checklistGoal?.status === "active") {
      setChecklistGoal({ ...checklistGoal, taskUserEntryId: userTurn.id }, "bind-current-user-turn");
    }

    // S6 可能在本次 agent_end 直接打回。必须在消费 S6 前冻结首份清单，否则打回轮
    // 可改写验收项目并冒充“首份合同”(本机 live smoke 已复现)。
    if (!goalGate && !deterministicDraftActive && firstChecklistText && !isGoalCancellationPrompt(prompt) &&
        (!checklistGoal || checklistGoal.status === "active" ||
          (checklistGoal.status === "inactive" && newUserTurn))) {
      const base = checklistGoal?.status === "active" ? checklistGoal : createChecklistGoalState(prompt, userTurn.id);
      setChecklistGoal(freezeChecklistGoalContract(base, firstChecklistText), "freeze-first-checklist-before-s6");
    }

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
        const disposition = s6BlockDisposition({
          status: review?.status, runHadTool, delivered: advDeliveredTurn,
        });
        if (disposition === "missed-window") {
          log(`S6 MISSED_WINDOW block 降级为日志(预审未见执行轨迹) ${String(review.reason || "").slice(0, 160)}`);
          metric({ sessionId, prompt: lastPrompt.slice(0, 160), ...lastPhase, s6MissedWindow: true });
        } else if (disposition === "redeliver") {
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
    // auto-gate 消费安装:显式门缺席且本轮为正常停轮时,取后台生成的双红验收命令装门。
    // 装上即走下方 goal-gate 全链(retry/换向器/账本);生成失败/不可验证=无门,回落现状。
    if (!goalGate && lastAssistant?.stopReason === "stop" && !ctx?.hasPendingMessages?.() &&
        !deterministicDraftActive) {
      try {
        const auto: any = await import(pathToFileURL(AUTO_GATE_MJS).href);
        const claimed = await auto.claimAutoGate({ session_id: sessionId, waitMs: 5000 });
        if (claimed?.status === "ready" && claimed.command) {
          goalGate = { command: claimed.command, attempts: 0, rounds: [], level: 0, auto: true };
          log(`AUTO_GATE INSTALL beforeExit=${claimed.beforeExit ?? "-"} cmd=${claimed.command.slice(0, 160)}`);
          metric({ sessionId, prompt: prompt.slice(0, 160), autoGate: "install", autoGateCmd: claimed.command.slice(0, 160) });
        } else if (claimed?.status && claimed.status !== "none") {
          log(`AUTO_GATE ${claimed.status} ${String(claimed.reason || "").slice(0, 120)}`);
        }
      } catch (e) { log(`AUTO_GATE FAIL_OPEN ${String(e).slice(0, 120)}`); }
    }
    // 目标门先于 completion guard:门存在时它就是完成判据,与 guard 的"承诺未执行"
    // 检测互不依赖(guard 管零工具假完成,门管"如实汇报未达标后停轮")。
    if (goalGate && lastAssistant?.stopReason === "stop" && !ctx?.hasPendingMessages?.()) {
      const gate = goalGate;
      // 方案先行收尾:上一轮是"只作答"轮(未动手,门必红)——不跑门不计尝试,
      // 直接注入实施轮:按已作答方案延伸实施,复用已有数据。
      if (gate.planPending) {
        gate.planPending = false;
        goalGateRetryActive = true;
        log("GOAL_GATE PLAN_CAPTURED queue implement round");
        metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, goalGate: "plan-round" });
        try {
          pi.sendMessage({
            customType: GOAL_GATE_TYPE,
            content: "按你上一条回复给出的方案延伸实施:逐项落实改动点,继续使用已有数据与证据,不要从头重做已验证过的部分;实施中若现场证据与方案冲突,以现场证据为准修正方案并说明。完成后目标门命令会自动执行。禁止修改校验命令、其判定逻辑或伪造其输入数据。",
            display: false,
            details: { command: gate.command, phase: "implement-after-plan" },
          }, { deliverAs: "followUp", triggerTurn: true });
          return;
        } catch (e) {
          goalGateRetryActive = false;
          log(`GOAL_GATE PLAN_FAIL_OPEN ${String(e).slice(0, 160)}`);
        }
      }
      const t9 = performance.now();
      const taskCwd = typeof (ctx as any)?.cwd === "string" ? (ctx as any).cwd : undefined;
      const result = await execGoalGate(gate.command, taskCwd).catch(() => ({ code: null, output: "", timedOut: false }));
      const verdict = goalGateVerdict({
        exitCode: result.code, timedOut: result.timedOut, attempts: gate.attempts, max: GOAL_GATE_MAX,
      });
      log(`GOAL_GATE ${verdict.toUpperCase()} code=${result.code ?? "-"} attempts=${gate.attempts}/${GOAL_GATE_MAX} ms=${+(performance.now() - t9).toFixed(0)} cmd=${gate.command.slice(0, 120)}`);
      if (verdict === "retry") {
        gate.attempts += 1;
        goalGateRetryActive = true;
        metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, goalGate: verdict, goalGateAttempts: gate.attempts });
        // 换向器:同路无进展时替换续跑文案强制换方向;自身异常 fail-open 回落原文案。
        let redirectMode = "normal";
        // 方案先行(normal 轻量形态):不让模型直接重做——回复第一部分必须先基于已有
        // 数据作答通过方案,再按方案延伸实施(跳闸轮升级为强制分轮,见下方 planPending)。
        let content = `目标门命令未通过(exit=${result.code},自动续跑 ${gate.attempts}/${GOAL_GATE_MAX})。命令输出尾部:\n${result.output.slice(-600)}\n\n先基于已有数据作答:在回复开头给出你判断能让目标门命令通过的完整方案(根因判断、要改的具体位置、为何能过门),直接引用上面失败输出与此前轮次已取得的证据;然后按该方案延伸实施,不要从头重做已验证过的部分。禁止未给出方案就动手修改。禁止修改校验命令、其判定逻辑或伪造其输入数据。若有证据表明目标在当前约束下不可达,停止尝试并给出量化差距与原因,由用户决定是否放宽。`;
        try {
          const redirector = await loadRedirector();
          if (redirector) {
            const redirect = await redirector.evaluateGoalRound({
              cwd: taskCwd, output: result.output, exitCode: result.code,
              attempts: gate.attempts, max: GOAL_GATE_MAX,
              prevRounds: gate.rounds || [], prevLevel: gate.level || 0,
            });
            gate.rounds = redirect.rounds;
            gate.level = redirect.level;
            redirectMode = redirect.mode;
            if (redirect.content) content = redirect.content;
            if (redirect.mode !== "normal") log(`GOAL_REDIRECT ${redirect.mode} trips=${redirect.tripped.join(",")} attempts=${gate.attempts}/${GOAL_GATE_MAX}`);
          }
        } catch (e) { log(`GOAL_REDIRECT FAIL_OPEN ${String(e).slice(0, 160)}`); }
        const bannedSummary = (gate.rounds || [])
          .filter((round: any) => round?.diffFp)
          .map((round: any) => `- 第${round.attempt}轮 exit=${round.exitCode} 改动指纹=${round.diffFp}${round.files?.length ? ` 涉及:${round.files.slice(0, 6).join(", ")}` : ""}${round.outputHead ? ` 失败:${round.outputHead}` : ""}`)
          .join("\n");
        // 方案先行分轮(2026-09-01 lop 裁决):换向器跳闸=同路无进展,此时不再让模型
        // 边想边改——先强制"只作答"轮,基于已有数据收敛完整通过方案;下一轮按方案
        // 延伸实施。作答不是尝试,不占 attempts 预算;每个升级 level 只插一次(有界)。
        try {
          const redirector = await loadRedirector();
          if (redirector?.shouldInsertPlanRound?.({
            mode: redirectMode, level: gate.level, planLevels: gate.planLevels,
          })) {
            gate.planLevels = [...(gate.planLevels || []), gate.level];
            gate.planPending = true;
            gate.attempts -= 1;
            content = redirector.renderPlanRound({
              mode: redirectMode, exitCode: result.code, attempts: gate.attempts,
              max: GOAL_GATE_MAX, tail: result.output.slice(-600), bannedSummary,
            });
            log(`GOAL_GATE PLAN_ROUND queued level=${gate.level} attempts=${gate.attempts}/${GOAL_GATE_MAX}`);
          }
        } catch (e) { log(`GOAL_PLAN FAIL_OPEN ${String(e).slice(0, 120)}`); }
        // Best-of-N fan-out:显式【多候选】或(LOP_BESTOFN_AUTO=1 且换向器已进 tabu)时,
        // 单门生命周期一次:N 路隔离 worktree 并行候选,由同一门命令筛选,胜者应用+主区复验。
        // 成功即发 followUp 让模型核对收尾(门保留,收尾轮 pass 路径自然收敛);
        // 失败把各候选证据并入续跑文案(比单路多 N 份禁忌证据)。方案轮在场时让位
        // (先收敛方案,方案轮后仍失败才轮到重炮)。全程 fail-open。
        const wantBestOfN = !gate.bestOfNUsed && !gate.planPending && (
          Boolean(pendingBestOfN) ||
          (process.env.LOP_BESTOFN_AUTO === "1" && redirectMode === "tabu"));
        if (wantBestOfN) {
          gate.bestOfNUsed = true;
          try {
            const bon: any = await import(pathToFileURL(BEST_OF_N_MJS).href);
            const bonN = pendingBestOfN?.n || 2;
            log(`BESTOFN START n=${bonN} trigger=${pendingBestOfN ? "explicit" : "auto-tabu"}`);
            const fan = await bon.runBestOfN({
              cwd: taskCwd, gateCommand: gate.command,
              taskPrompt: checklistGoal?.objective || prompt,
              n: bonN, bannedSummary, log,
            });
            metric({
              sessionId, prompt: prompt.slice(0, 160), ...lastPhase,
              bestOfN: bonN, bestOfNOk: Boolean(fan?.ok), bestOfNReason: fan?.reason || "",
              bestOfNWinner: fan?.winner ? fan.winner.index + 1 : 0,
            });
            if (fan?.ok) {
              log(`BESTOFN PASS winner=cand${fan.winner.index + 1} diffLines=${fan.winner.diffLines}`);
              pi.sendMessage({
                customType: BEST_OF_N_TYPE,
                content: `${bon.renderBestOfNOutcome(fan)}\n\n请核对已应用到工作区的改动,并向用户总结结果(改了什么、为什么、验收命令输出)。`,
                display: false,
                details: { command: gate.command, n: bonN, winner: fan.winner.index + 1 },
              }, { deliverAs: "followUp", triggerTurn: true });
              return;
            }
            log(`BESTOFN FAIL reason=${fan?.reason || "unknown"}`);
            content = `${content}\n\n${bon.renderBestOfNOutcome(fan)}`;
          } catch (e) { log(`BESTOFN FAIL_OPEN ${String(e).slice(0, 160)}`); }
        }
        try {
          pi.sendMessage({
            customType: GOAL_GATE_TYPE,
            content,
            display: false,
            details: { command: gate.command, attempts: gate.attempts, exitCode: result.code, redirect: redirectMode },
          }, { deliverAs: "followUp", triggerTurn: true });
          return;
        } catch (e) {
          goalGateRetryActive = false;
          log(`GOAL_GATE FAIL_OPEN ${String(e).slice(0, 160)}`);
        }
      } else {
        goalGateRetryActive = false;
        if (verdict === "pass" && checklistGoal?.status === "active") {
          setChecklistGoal({ ...checklistGoal, status: "complete", blockerKey: "", blockerTurns: 0 }, "deterministic-goal-gate-pass");
        } else if ((verdict === "exhausted" || verdict === "fail-open") && gate.auto) {
          // auto 门降级:生成的门可能天生永红(断言错对象),不许锁死会话;
          // 清门回落,验收清单门继续兜底。
          goalGate = null;
          log(`AUTO_GATE DEMOTE verdict=${verdict} cmd=${gate.command.slice(0, 120)}`);
          metric({ sessionId, prompt: prompt.slice(0, 160), autoGate: "demote", autoGateVerdict: verdict });
        } else if ((verdict === "exhausted" || verdict === "fail-open") && checklistGoal?.status === "active") {
          setChecklistGoal({ ...checklistGoal, status: "blocked" }, `deterministic-goal-gate-${verdict}`);
        }
        if (verdict === "exhausted") {
          metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, goalGate: verdict, goalGateAttempts: gate.attempts });
          // 预算顶:最后一轮也记入账本后落盘——已试路径+已排除假设,供人裁决或新会话蒸馏重启。
          try {
            const redirector = await loadRedirector();
            if (redirector) {
              const fin = await redirector.evaluateGoalRound({
                cwd: taskCwd, output: result.output, exitCode: result.code,
                attempts: gate.attempts, max: GOAL_GATE_MAX,
                prevRounds: gate.rounds || [], prevLevel: gate.level || 0,
              });
              gate.rounds = fin.rounds;
              const ledger = redirector.writeGoalLedger({
                dir: path.join(DATA, "goal-gate-ledger"), sessionId, command: gate.command, rounds: gate.rounds,
              });
              if (ledger) log(`GOAL_GATE LEDGER ${ledger}`);
            }
          } catch (e) { log(`GOAL_REDIRECT LEDGER_FAIL ${String(e).slice(0, 160)}`); }
        }
      }
    }
    // 两态验收目标:首份清单冻结,active 时永续 follow-up;complete 或同一真实阻塞
    // 连续三轮后的 blocked 才允许停。确定性目标门在场时仍独占完成判据。
    const checklistGate = checklistGateDecision({
      assistantText: text,
      stopReason: lastAssistant?.stopReason,
      pendingMessages: Boolean(ctx?.hasPendingMessages?.()),
      hasGoalGate: Boolean(goalGate),
      state: checklistGoal,
      objective: prompt,
      taskUserEntryId: userTurn.id,
      contractText: firstChecklistText,
      deterministicVerified: deterministicDraftActive,
      blockerTurnsRequired: CHECKLIST_BLOCKER_TURNS,
    });
    if (checklistGate.reason === "same-blocker-three-turns") {
      if (checklistGate.state) setChecklistGoal(checklistGate.state, checklistGate.reason);
      checklistRetryActive = false;
      log(`CHECKLIST_GOAL BLOCKED blockerTurns=${checklistGate.state?.blockerTurns || 0} open=${checklistGate.open.length}`);
      metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, checklistGoal: "blocked", checklistOpen: checklistGate.open.length, checklistBlockerTurns: checklistGate.state?.blockerTurns || 0 });
    } else if (checklistGate.trigger) {
      checklistRetryActive = true;
      const continuation = checklistGate.state?.continuationCount || 1;
      let redirectMode = "normal";
      let continuationText = formatChecklistGateContinuation(checklistGate, continuation);
      try {
        const redirector = await loadRedirector();
        if (redirector && checklistGate.state) {
          const previousRounds = Array.isArray(checklistGate.state.redirectRounds) ? checklistGate.state.redirectRounds.slice(-12) : [];
          const redirect = await redirector.evaluateGoalRound({ cwd: "", output: checklistRedirectEvidence(checklistGate, text), exitCode: 1, attempts: continuation, max: Math.max(3, continuation), prevRounds: previousRounds, prevLevel: checklistGate.state.redirectLevel || 0 });
          redirectMode = redirect.mode;
          const progressed = redirect.mode === "normal" && previousRounds.length > 0 && previousRounds.at(-1)?.failFp !== redirect.round?.failFp;
          checklistGate.state.redirectRounds = progressed ? [redirect.round] : redirect.rounds.slice(-12);
          checklistGate.state.redirectLevel = progressed ? 0 : redirect.level;
          const redirected = redirector.renderChecklistRedirect?.({ mode: redirect.mode, tripped: redirect.tripped, rounds: checklistGate.state.redirectRounds, open: checklistGate.open });
          if (redirected) continuationText = `${redirected}\n\n${continuationText}`;
          if (redirect.mode !== "normal") log(`CHECKLIST_REDIRECT ${redirect.mode} turn=${continuation} trips=${redirect.tripped.join(",") || "none"} open=${checklistGate.open.length}`);
        }
      } catch (e) { log(`CHECKLIST_REDIRECT FAIL_OPEN ${String(e).slice(0, 160)}`); }
      const staleAction = staleNextActionDecision(branch);
      if (staleAction.stale) {
        continuationText = `${staleAction.directive}\n\n${continuationText}`;
        log(`NEXT_ACTION STALE timestamp=${staleAction.timestamp} turn=${continuation}`);
      }
      if (checklistGate.state) setChecklistGoal(checklistGate.state, checklistGate.reason);
      log(`CHECKLIST_GOAL CONTINUE turn=${continuation} reason=${checklistGate.reason} redirect=${redirectMode} open=${checklistGate.open.length}`);
      metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, checklistGoal: "active", checklistReason: checklistGate.reason, checklistContinuation: continuation, checklistOpen: checklistGate.open.length, checklistRedirect: redirectMode, staleNextAction: staleAction.stale });
      try {
        pi.sendMessage({ customType: CHECKLIST_GATE_TYPE, content: continuationText, display: false, details: { status: "active", open: checklistGate.open, continuation, violations: checklistGate.violations, redirect: redirectMode, staleNextAction: staleAction.stale } }, { deliverAs: "followUp", triggerTurn: true });
        return;
      } catch (e) {
        checklistRetryActive = false;
        log(`CHECKLIST_GOAL FAIL_OPEN ${String(e).slice(0, 160)}`);
      }
    } else {
      if (checklistGate.state) setChecklistGoal(checklistGate.state, checklistGate.reason);
      checklistRetryActive = false;
      if (checklistGate.reason === "goal-complete" || checklistGate.reason === "deterministic-host-verified") {
        log(`CHECKLIST_GOAL COMPLETE reason=${checklistGate.reason}`);
        metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, checklistGoal: "complete" });
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

    // 记忆标记状态差门(写入侧 v3):有状态变更且最终回复无标记 → 追一轮补标记(每轮最多一次);
    // 纯问答不阻断;判定或发送失败 fail-open 留痕;补标记轮回来直接落账。
    if (prompt && text && !memoryGateRetryActive && lastAssistant?.stopReason === "stop" &&
        !ctx?.hasPendingMessages?.() && !prompt.startsWith(RUN_SUPERVISOR_RECOVERY_PREFIX)) {
      try {
        const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
        const gate = mem.decideStopGate({ mutated: turnMutated, lastAssistantMessage: text, memoryMarker: turnMemoryMarker, stopHookActive: false });
        if (gate.block) {
          memoryGateRetryActive = true;
          log(`MEMORY_GATE BLOCK reason=${gate.reason} files=${turnToolFiles.length} cmds=${turnToolCommands.length}`);
          metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, memoryGate: "block" });
          pi.sendMessage({
            customType: MEMORY_GATE_TYPE,
            content: String(gate.instruction || ""),
            display: false,
            details: { reason: gate.reason, files: turnToolFiles.slice(0, 8) },
          }, { deliverAs: "followUp", triggerTurn: true });
          return;
        }
        if (turnMutated) log(`MEMORY_GATE PASS reason=${gate.reason}`);
      } catch (e) {
        log(`MEMORY_GATE FAIL_OPEN ${String(e).slice(0, 160)}`);
      }
    }
    if (memoryGateRetryActive) {
      memoryGateRetryActive = false;
      log("MEMORY_GATE RETRY_CONSUMED");
      metric({ sessionId, prompt: prompt.slice(0, 160), ...lastPhase, memoryGate: "retry-consumed" });
    }
    const t8 = performance.now();
    try {
      if (prompt && text) {
        const mem: any = await import(pathToFileURL(MEMORY_MJS).href);
        const persistenceText = stripAcceptanceChecklist(text)
          .replace(/<!--\s*history-(?:used|conflict):[^>]+-->/gu, "")
          .replace(/<!--\s*lop-memory-event\s+\{[\s\S]*?\}\s*-->/gu, "")
          .trim();
        // 恢复轮注入 prompt 是调度脚手架(uuid+attempt),不能当任务键落账:有目标合同
        // 就换成原始目标文本,让恢复期完成态归并到原任务事件;无合同则无键可写。
        const recoveryTurn = prompt.startsWith(RUN_SUPERVISOR_RECOVERY_PREFIX);
        let canonicalPrompt = recoveryTurn ? String(checklistGoal?.objective || "").trim() : prompt;
        // 历史状态里存在用恢复 prompt 建出的目标(objective 本身是脚手架),同样无键可写。
        if (recoveryTurn && canonicalPrompt.startsWith(RUN_SUPERVISOR_RECOVERY_PREFIX)) canonicalPrompt = "";
        if (!persistenceText || !canonicalPrompt) {
          // 剥掉清单/凭证后正文为空 = 本轮无最终完成态可入账;Stop 只记最终完成态,
          // 跳过但必须留痕(此路径曾被当 S8 硬失败,恢复轮每次重试都炸一条)。
          const s8Skip = !persistenceText ? "empty-after-strip" : "recovery-without-goal";
          lastPhase = { ...lastPhase, s8Pass: true, s8Skip };
          log(`S8 SKIP ${s8Skip} recovery=${recoveryTurn}`);
        } else {
          const saved = await mem.recordStop({
            session_id: sessionId,
            turn_id: "",
            prompt: canonicalPrompt,
            // 原文(含标记)供标记解析;存储正文用剥离清单/凭证/标记后的 persistenceText。
            last_assistant_message: text,
            memory_answer: persistenceText,
            memory_marker: turnMemoryMarker,
            memory_tool_anchors: { files: turnToolFiles, commands: turnToolCommands, mutated: turnMutated, marker: turnMemoryMarker },
            transcript_path: "",
          });
          if (saved?.skipped || saved?.disabled) {
            // 记录端主动判定无可入账内容(synthetic-prompt/no-human-prompt/关闭):
            // 跳过留痕,不当硬失败;硬失败只留给真正的写入被拒。
            const s8Skip = String(saved.reason || (saved.disabled ? "disabled" : "skipped"));
            lastPhase = { ...lastPhase, s8Pass: true, s8Skip };
            log(`S8 SKIP ${s8Skip} recovery=${recoveryTurn}`);
          } else if (!saved?.canonical?.saved) {
            throw new Error(`canonical write not saved: ${JSON.stringify(saved).slice(0, 500)}`);
          } else {
            lastPhase = {
              ...lastPhase,
              s8Pass: true,
              s8CanonicalEventId: saved.canonical.eventId,
              s8CanonicalDerived: Boolean(saved.canonical.derived),
            };
            log(`S8 STOP ${saved?.added ? "ADDED" : "UPDATED"} canonical=${saved.canonical.eventId} derived=${Boolean(saved.canonical.derived)}`);
          }
        }
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
