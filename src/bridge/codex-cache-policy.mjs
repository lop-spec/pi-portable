import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';

const GPT56_MODEL = /^gpt-5\.6(?:-|$)/iu;
const VOLATILE_DEVELOPER_TEXT = /<\/?(?:environment_context|history-resolved)\b|history-(?:used|conflict):/iu;
const EXACT_HISTORY = /<history-resolved\b(?=[^>]*\bmode=["']exact["'])(?=[^>]*\brelevance=["']1(?:\.0+)?["'])[^>]*>/iu;
const HISTORY_USAGE = /<history-resolved\b(?=[^>]*\bmode=["']exact["'])[^>]*\busage=["'](h_[a-z0-9_-]+)["'][^>]*>/iu;
const FAILED_TOOL_OUTPUT = /(?:["'](?:ok)["']\s*:\s*false|["'](?:isError|timedOut)["']\s*:\s*true|["'](?:exitCode|failed_count)["']\s*:\s*[1-9]\d*|tool call error|validation failed|script failed|\b(?:ENOENT|EACCES)\b|(?:验证|执行|调用|处理)失败)/iu;
const REPLAY_MAX_REQUEST_BYTES = 256 * 1024;
const TIMING_SENSITIVE_USER = /(?:耗时|延迟|时延|用时|响应时间|执行时间|毫秒|latency|duration|elapsed|wall\s*time|\bms\b)/iu;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutBreakpoints(value) {
  if (Array.isArray(value)) return value.map(withoutBreakpoints);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'prompt_cache_breakpoint') out[key] = withoutBreakpoints(child);
  }
  return out;
}

function contentBlocks(item) {
  return Array.isArray(item?.content) ? item.content : [];
}

function developerText(item) {
  if (typeof item?.content === 'string') return item.content;
  return contentBlocks(item)
    .filter((block) => block?.type === 'input_text')
    .map((block) => String(block.text || ''))
    .join('\n');
}

function visibleText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? ''); } catch { return String(value ?? ''); }
}

function exactHistoryPresent(input) {
  // pi 宿主的历史注入走 user 消息(2026-08-28),标记语义同 developer 注入,扫描面放宽。
  return input.some((item) => (item?.role === 'developer' || item?.role === 'user') && EXACT_HISTORY.test(developerText(item)));
}

function failedToolOutputPresent(input) {
  return input.some((item) =>
    ['custom_tool_call_output', 'function_call_output'].includes(String(item?.type || '')) &&
    FAILED_TOOL_OUTPUT.test(visibleText(item?.output))
  );
}

function conversationAlreadyStarted(input) {
  // 历史摘要只允许降低新会话的首个模型请求。摘要标记会随线程上下文继续
  // 出现在后续请求中，不能据此把工具轮、追问轮和其余整条线程永久降为 low。
  return input.some((item) =>
    item?.role === 'assistant' ||
    ['custom_tool_call', 'function_call', 'custom_tool_call_output', 'function_call_output'].includes(String(item?.type || ''))
  );
}

function replayString(value) {
  return String(value)
    .replace(/(\busage=["'])h_[a-z0-9_-]+/giu, '$1h_*')
    .replace(/history-(used|conflict):h_[a-z0-9_-]+/giu, 'history-$1:h_*');
}

function replayToolReceiptString(value) {
  return replayString(value)
    .replace(/(Wall time:?\s+)\d+(?:\.\d+)?(\s+seconds)/giu, '$1*$2')
    .replace(/((?:"|\\")(?:ms|durationMs|duration_ms)(?:"|\\")\s*:\s*)\d+(?:\.\d+)?/gu, '$1*');
}

function replayToolReceipt(value) {
  if (typeof value === 'string') return replayToolReceiptString(value);
  if (Array.isArray(value)) return value.map(replayToolReceipt);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replayToolReceipt(child)]));
}

function normalizeReplayInputReceipts(input, timingSensitive = false) {
  if (!Array.isArray(input)) return input;
  if (timingSensitive) return input;
  return input.map((item) => {
    if (!['custom_tool_call_output', 'function_call_output'].includes(String(item?.type || ''))) {
      return item;
    }
    return { ...item, output: replayToolReceipt(item.output) };
  });
}

function replayVisible(value) {
  if (typeof value === 'string') return replayString(value);
  if (Array.isArray(value)) {
    return value.map((item) => replayVisible(item));
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [childKey, child] of Object.entries(value)) {
    out[childKey] = replayVisible(child);
  }
  return out;
}

function replayInputItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const visible = { ...item };
  delete visible.id;
  delete visible.internal_chat_message_metadata_passthrough;
  return visible;
}

function timingSensitiveReplay(input) {
  return input.some((item) => item?.role === 'user' && TIMING_SENSITIVE_USER.test(developerText(item)));
}

export function responseReplayIdentity(payload, options = {}) {
  const disabled = (reason) => ({ enabled: false, reason, key: '', usageToken: '' });
  if (!GPT56_MODEL.test(String(payload?.model || ''))) return disabled('unsupported-model');
  if (!Array.isArray(payload?.input)) return disabled('missing-input');
  // v7.8.1 链式重放:previous_response_id 不再挡门也不进 key——追问轮请求携带全量
  // input,归一后 payload 逐字节等价才重放,语义与首轮重放同等守恒。此前只重放
  // 首轮,追问轮永远真实生成,受上游生成速度方差摆布(2026-08-27 五链 run5/6:
  // t1 follow 196ms↔4269ms 同内容波动 20 倍)。

  let usageToken = '';
  for (const item of payload.input) {
    if (item?.role !== 'developer' && item?.role !== 'user') continue;
    const text = developerText(item);
    if (!EXACT_HISTORY.test(text)) continue;
    usageToken = HISTORY_USAGE.exec(text)?.[1] || '';
    break;
  }
  if (!usageToken) return disabled('no-exact-history');

  const replayPayload = { ...payload };
  delete replayPayload.metadata;
  delete replayPayload.client_metadata;
  delete replayPayload.prompt_cache_key;
  delete replayPayload.previous_response_id;
  const visiblePayload = replayVisible(replayPayload);
  visiblePayload.input = normalizeReplayInputReceipts(
    visiblePayload.input.map(replayInputItem),
    timingSensitiveReplay(payload.input),
  );
  const canonical = canonicalJson(visiblePayload);
  const maxRequestBytes = Number(options.maxRequestBytes) || REPLAY_MAX_REQUEST_BYTES;
  if (Buffer.byteLength(canonical) > maxRequestBytes) return disabled('request-too-large');
  return {
    enabled: true,
    reason: 'exact-history-request',
    key: createHash('sha256').update(canonical).digest('hex'),
    usageToken,
    groupKey: String(payload.prompt_cache_key || ''),
    componentHashes: Object.fromEntries(Object.entries(visiblePayload).map(([name, value]) => [
      name,
      createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12),
    ])),
    inputHashes: Array.isArray(visiblePayload.input) ? visiblePayload.input.map((value) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12)
    ) : [],
  };
}

function applyHistoryReplayEffort(payload, effort) {
  const from = String(payload?.reasoning?.effort || '');
  const result = { applied: false, reason: 'disabled', from, to: from };
  if (!effort || effort === 'off') return result;
  if (!exactHistoryPresent(payload.input)) {
    result.reason = 'no-exact-history';
    return result;
  }
  if (failedToolOutputPresent(payload.input)) {
    result.reason = 'tool-failure-escalation';
    return result;
  }
  if (conversationAlreadyStarted(payload.input)) {
    result.reason = 'history-first-request-complete';
    return result;
  }
  payload.reasoning = { ...(payload.reasoning || {}), effort };
  Object.assign(result, {
    applied: from !== effort,
    reason: 'exact-history-replay',
    to: effort,
  });
  return result;
}

function findStableBreakpoint(input) {
  let candidate = null;
  for (let itemIndex = 0; itemIndex < input.length; itemIndex += 1) {
    const item = input[itemIndex];
    if (item?.type === 'additional_tools') continue;
    if (item?.role !== 'developer' && item?.role !== 'system') break;

    const text = developerText(item);
    if (VOLATILE_DEVELOPER_TEXT.test(text)) break;
    // v7.16.0 边界兼容字符串:pi(pi-ai 序列化)的系统提示是单条 developer/system 项,
    // content 为纯字符串——此前只认 input_text 块数组,pi 流量恒 no-safe-stable-boundary
    // (2026-08-30→09-01 静默烧掉 380 万未缓存 tokens)。字符串项本身即稳定文本,记作
    // key-only 边界(blockIndex=-1),永不把 content 改写成块数组。
    if (typeof item?.content === 'string' && item.content) {
      candidate = { itemIndex, blockIndex: -1 };
      continue;
    }
    const blocks = contentBlocks(item);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      if (blocks[blockIndex]?.type === 'input_text') {
        candidate = { itemIndex, blockIndex };
        break;
      }
    }
  }
  return candidate;
}

function sessionSeed(input) {
  // v7.16.0 并发会话分键:key 掺入首条 user 项摘要。v7.8.0 的"同前缀同 key"假设
  // 低并发;pi 多并发会话 + Best-of-N 并发候选后,单 key 汇聚大量互异后缀会打散
  // 上游缓存节点。首条 user 项整个会话逐轮原样重放 → 单会话内 key 恒定;同会话
  // 的并发候选共享它 → 仍共享缓存;不同会话首消息互异 → 各自独立 key。
  const first = input.find((item) => item?.role === 'user');
  if (!first) return '';
  const {
    id: _id,
    internal_chat_message_metadata_passthrough: _passthrough,
    ...modelVisible
  } = first;
  return createHash('sha256').update(canonicalJson(withoutBreakpoints(modelVisible))).digest('hex').slice(0, 16);
}

function stableCacheKey(payload, itemIndex) {
  const stableInput = payload.input.slice(0, itemIndex + 1).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const {
      id: _id,
      internal_chat_message_metadata_passthrough: _passthrough,
      ...modelVisible
    } = item;
    return modelVisible;
  });
  const prefix = withoutBreakpoints({
    model: payload.model,
    instructions: payload.instructions,
    tools: payload.tools,
    input: stableInput,
  });
  const seed = sessionSeed(payload.input);
  const digest = createHash('sha256')
    .update(canonicalJson(prefix) + (seed ? `|session:${seed}` : ''))
    .digest('hex').slice(0, 32);
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13)}`;
  const variant = (8 | (Number.parseInt(versioned[16], 16) & 3)).toString(16);
  const uuid = `${versioned.slice(0, 16)}${variant}${versioned.slice(17)}`;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

export function applyCodexRequestPolicy(
  payload,
  { explicitBreakpoint = true, historyReplayEffort = 'off' } = {},
) {
  const copy = cloneJson(payload);
  let reasoning = {
    applied: false,
    reason: 'unsupported-model',
    from: String(copy?.reasoning?.effort || ''),
    to: String(copy?.reasoning?.effort || ''),
  };
  const cache = {
    applied: false,
    breakpointApplied: false,
    reason: '',
    key: '',
    itemIndex: -1,
    blockIndex: -1,
  };
  if (!GPT56_MODEL.test(String(copy?.model || ''))) {
    cache.reason = 'unsupported-model';
    return { payload: copy, cache, reasoning };
  }
  if (!Array.isArray(copy.input)) {
    cache.reason = 'missing-input';
    reasoning.reason = 'missing-input';
    return { payload: copy, cache, reasoning };
  }

  reasoning = applyHistoryReplayEffort(copy, historyReplayEffort);

  const boundary = findStableBreakpoint(copy.input);
  if (!boundary) {
    cache.reason = 'no-safe-stable-boundary';
    return { payload: copy, cache, reasoning };
  }

  // 字符串形态边界(blockIndex=-1)无块可挂显式断点:恒 key-only,不改写 content 形态。
  const breakpointApplied = explicitBreakpoint && boundary.blockIndex >= 0;
  if (breakpointApplied) {
    const block = copy.input[boundary.itemIndex].content[boundary.blockIndex];
    block.prompt_cache_breakpoint = { mode: 'explicit' };
  }
  // v7.8.0:key 只按稳定前缀分组,不再掺首条任务文本。任务分组会把不同任务路由到
  // 不同上游缓存节点——t1 写热的共享前缀 t2-t5 摸不到(2026-08-27 五链基准:
  // 跨任务首轮命中封顶 11008,同任务重跑 13056)。同前缀同 key 后限流面=同项目
  // 连续首请求,量级远低于单 key 降级阈值。
  copy.prompt_cache_key = stableCacheKey(copy, boundary.itemIndex);
  Object.assign(cache, {
    applied: true,
    breakpointApplied,
    reason: breakpointApplied ? 'stable-developer-prefix' : 'stable-developer-prefix-key-only',
    key: copy.prompt_cache_key,
    ...boundary,
  });
  return { payload: copy, cache, reasoning };
}

// 上行重压缩：改写后的明文 JSON 在发往上游前恢复 gzip（客户端原本就发 gzip，
// 上游按 Content-Encoding 解压是已实证行为）。已带 content-encoding 的透传体
// 原样返回；小于 minBytes 的小包不压，避免为健康探测类请求浪费 CPU。
export function compressUpstreamBody(body, headers, { minBytes = 4096 } = {}) {
  if (headerValue(headers, 'content-encoding')) return { body, headers, compressed: false };
  if (!body || body.length < minBytes) return { body, headers, compressed: false };
  const compressed = gzipSync(body);
  return {
    body: compressed,
    headers: { ...headers, 'content-encoding': 'gzip' },
    compressed: true,
  };
}

function headerValue(headers, name) {
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function removeHeader(headers, name) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === name) delete out[key];
  }
  return out;
}

export function rewriteCodexRequestBody(
  body,
  headers,
  {
    tier = 'off',
    explicitBreakpoint = true,
    historyReplayEffort = 'off',
  } = {},
) {
  try {
    const encoding = String(headerValue(headers, 'content-encoding') || '').toLowerCase();
    let raw = body;
    if (encoding.includes('gzip')) raw = gunzipSync(body);
    else if (encoding.includes('deflate')) raw = inflateSync(body);
    const original = JSON.parse(raw.toString('utf8'));
    const { payload, cache, reasoning } = applyCodexRequestPolicy(original, {
      explicitBreakpoint,
      historyReplayEffort,
    });
    // reasoning 强度完全由会话控制(2026-09-01 lop 裁决,撤销 08-30 的全请求强制 max):
    // 桥不再改写 reasoning.effort;历史快路(applyHistoryReplayEffort)是显式规则例外,保留。
    let tierApplied = false;
    const hasRequestTier = Object.prototype.hasOwnProperty.call(payload, 'service_tier');
    if (tier !== 'off' && !hasRequestTier) {
      payload.service_tier = tier;
      tierApplied = true;
    }
    const tierSource = tierApplied ? 'fallback' : hasRequestTier ? 'request' : 'upstream';
    const effectiveTier = Object.prototype.hasOwnProperty.call(payload, 'service_tier')
      ? payload.service_tier
      : null;
    const replay = responseReplayIdentity(payload);
    if (!cache.applied && !tierApplied && !reasoning.applied) {
      return {
        body,
        headers,
        meta: {
          parseFailed: false,
          cacheApplied: false,
          tierApplied: false,
          tierSource,
          effectiveTier,
          reasoningApplied: false,
          cache,
          reasoning,
          replay,
        },
      };
    }
    return {
      body: Buffer.from(JSON.stringify(payload), 'utf8'),
      headers: removeHeader(headers, 'content-encoding'),
      meta: {
        parseFailed: false,
        cacheApplied: cache.applied,
        tierApplied,
        tierSource,
        effectiveTier,
        reasoningApplied: reasoning.applied,
        cache,
        reasoning,
        replay,
      },
    };
  } catch {
    return {
      body,
      headers,
      meta: {
        parseFailed: true,
        cacheApplied: false,
        tierApplied: false,
        tierSource: 'unknown',
        effectiveTier: null,
        reasoningApplied: false,
        cache: null,
        reasoning: null,
        replay: null,
      },
    };
  }
}
