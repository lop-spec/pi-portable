// pi 压缩摘要请求的推理强度隔离。
// 判定只看请求内容：input[0] 是 developer/system 项且正文以 pi-coding-agent 固定的
// SUMMARIZATION_SYSTEM_PROMPT 开头，才把 reasoning.effort 改成目标档位。
// 不记会话、不记账号、不记上一请求：普通轮次永远原样透传，改动不可能"钉"到后续请求上
//（2026-08 的 history 快路事故正是因为按会话记状态；本模块刻意没有任何状态）。
export const PI_SUMMARIZATION_PROMPT_PREFIX = "You are a context summarization assistant.";
export const SUMMARIZATION_BODY_SIGNATURE = Buffer.from(PI_SUMMARIZATION_PROMPT_PREFIX, "utf8");
export const DEFAULT_SUMMARY_EFFORT = "low";
const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function leadText(item) {
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) {
    return item.content
      .filter((block) => block?.type === "input_text")
      .map((block) => String(block.text || ""))
      .join("\n");
  }
  return "";
}

/** 环境变量 CODEX_SUMMARY_EFFORT：档位名或 off；非法值回落默认 low。 */
export function resolveSummaryEffort(value) {
  const normalized = String(value ?? DEFAULT_SUMMARY_EFFORT).trim().toLowerCase();
  if (normalized === "off") return "off";
  return VALID_EFFORTS.has(normalized) ? normalized : DEFAULT_SUMMARY_EFFORT;
}

/** 只有 input[0] 为 pi 摘要系统提示才算摘要请求；同样文本出现在 user/工具结果里不算。 */
export function isPiSummarizationRequest(payload) {
  const first = Array.isArray(payload?.input) ? payload.input[0] : null;
  if (!first || (first.role !== "developer" && first.role !== "system")) return false;
  return leadText(first).trimStart().startsWith(PI_SUMMARIZATION_PROMPT_PREFIX);
}

/**
 * 原地改写 payload.reasoning.effort，返回 { applied, reason, from, to }。
 * 没有 reasoning 字段（thinking off）时不添加：不替客户端决定要不要推理。
 */
export function applySummarizationEffort(payload, { effort = DEFAULT_SUMMARY_EFFORT } = {}) {
  if (effort === "off") return { applied: false, reason: "disabled" };
  if (!isPiSummarizationRequest(payload)) return { applied: false, reason: "not-summarization" };
  const reasoning = payload.reasoning && typeof payload.reasoning === "object" ? payload.reasoning : null;
  const current = reasoning ? reasoning.effort : undefined;
  if (current === undefined) return { applied: false, reason: "no-reasoning-field" };
  if (current === effort) return { applied: false, reason: "already", from: current, to: effort };
  payload.reasoning = { ...reasoning, effort };
  return { applied: true, reason: "summarization", from: current, to: effort };
}
