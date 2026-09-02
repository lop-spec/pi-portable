// SSE 流吞吐观测：从 Responses SSE 尾部提取真实 usage，计算首字节后的生成吞吐。
// 只观测、零改写；解析失败一律返回 null 字段，绝不影响转发路径。

const TAIL_BUDGET_BYTES = 128 * 1024;

// 尾部环形缓冲：只保留最后 ~128KB，response.completed 的 usage 必在其中。
export function createTailRing(budget = TAIL_BUDGET_BYTES) {
  const chunks = [];
  let held = 0;
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      chunks.push(chunk);
      held += chunk.length;
      while (held - (chunks[0]?.length || 0) >= budget && chunks.length > 1) {
        held -= chunks.shift().length;
      }
    },
    get totalBytes() { return total; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

function lastNumber(text, pattern) {
  let match = null;
  for (const found of text.matchAll(pattern)) match = found;
  return match ? Number(match[1]) : null;
}

// usage 出现在流末尾的 response.completed 事件里；取最后一次出现的值。
export function extractUsage(tailText) {
  const text = String(tailText || '');
  // 上游在 response.completed 里回显实际执行的 service_tier:请求 priority 而额度耗尽时
  // 静默降为 "default"(2026-09-02 实测:同分钟内 47-57 tok/s → 27 tok/s,别无任何信号)。
  let tier = null;
  for (const found of text.matchAll(/"service_tier"\s*:\s*"([a-z_]+)"/gu)) tier = found[1];
  return {
    inputTokens: lastNumber(text, /"input_tokens"\s*:\s*(\d+)/gu),
    cachedInputTokens: lastNumber(text, /"cached_tokens"\s*:\s*(\d+)/gu),
    outputTokens: lastNumber(text, /"output_tokens"\s*:\s*(\d+)/gu),
    reasoningTokens: lastNumber(text, /"reasoning_tokens"\s*:\s*(\d+)/gu),
    serviceTier: tier,
  };
}

export function computeThroughput({ firstByteAt, endAt, outputTokens }) {
  const streamMs = Math.max(0, Math.round(endAt - firstByteAt));
  const tokens = Number(outputTokens);
  const tokPerSec = Number.isFinite(tokens) && tokens > 0 && streamMs >= 100
    ? Number((tokens / (streamMs / 1000)).toFixed(1))
    : null;
  return { streamMs, tokPerSec };
}
