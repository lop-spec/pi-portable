import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';

const GPT56_MODEL = /^gpt-5\.6(?:-|$)/iu;
const VOLATILE_DEVELOPER_TEXT = /<\/?(?:environment_context|history-resolved)\b|history-(?:used|conflict):/iu;

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

export function applyCodexRequestPolicy(payload, { explicitBreakpoint = true } = {}) {
  const copy = cloneJson(payload);
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
    return { payload: copy, cache };
  }
  if (!Array.isArray(copy.input)) {
    cache.reason = 'missing-input';
    return { payload: copy, cache };
  }

  const boundary = findStableBreakpoint(copy.input);
  if (!boundary) {
    cache.reason = 'no-safe-stable-boundary';
    return { payload: copy, cache };
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
  return { payload: copy, cache };
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

export function rewriteCodexRequestBody(body, headers, { explicitBreakpoint = true } = {}) {
  try {
    const encoding = String(headerValue(headers, 'content-encoding') || '').toLowerCase();
    let raw = body;
    if (encoding.includes('gzip')) raw = gunzipSync(body);
    else if (encoding.includes('deflate')) raw = inflateSync(body);
    const original = JSON.parse(raw.toString('utf8'));
    const { payload, cache } = applyCodexRequestPolicy(original, { explicitBreakpoint });
    // tier 只读不改:请求带什么 service_tier 就透传什么(是否被授予以 tok/s 判)。
    const effectiveTier = Object.prototype.hasOwnProperty.call(payload, 'service_tier')
      ? payload.service_tier
      : null;
    if (!cache.applied) {
      return {
        body,
        headers,
        meta: {
          parseFailed: false,
          cacheApplied: false,
          effectiveTier,
          cache,
        },
      };
    }
    return {
      body: Buffer.from(JSON.stringify(payload), 'utf8'),
      headers: removeHeader(headers, 'content-encoding'),
      meta: {
        parseFailed: false,
        cacheApplied: cache.applied,
        effectiveTier,
        cache,
      },
    };
  } catch {
    return {
      body,
      headers,
      meta: {
        parseFailed: true,
        cacheApplied: false,
        effectiveTier: null,
        cache: null,
      },
    };
  }
}
