const ERROR_EVENT = /(?:event:\s*error|"type"\s*:\s*"(?:error|response\.failed)"|"status"\s*:\s*"failed")/iu;
const STRIP_HEADERS = new Set([
  'connection', 'content-encoding', 'content-length', 'date', 'keep-alive',
  'proxy-connection', 'set-cookie', 'transfer-encoding', 'upgrade',
]);

function replayBody(body, storedToken, currentToken) {
  // v7.8.2:凭证 token 无条件对齐本轮。重放门槛已保证归一后 payload 逐字节等价,
  // 故存储轮与本轮注入的历史内容等价,凭证只需换 token 不换语义(used/conflict 保留)。
  // 依赖 storedToken 精确匹配曾在"跑完写新事件→下轮 token 轮转"场景下静默失配
  // (2026-08-27 五链 run8:t2/t3 final 带着上一轮的 h_ token,凭证校验 2/5 失败)。
  if (!currentToken) return Buffer.from(body);
  return Buffer.from(
    Buffer.from(body).toString('utf8').replace(
      /history-(used|conflict):h_[0-9a-f]{16}/gu,
      `history-$1:${currentToken}`,
    ),
    'utf8',
  );
}

function replayHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIP_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  out['x-lop-exact-response-cache'] = 'hit';
  return out;
}

export class ExactResponseMemo {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) || 10 * 60 * 1000;
    this.maxEntries = Number(options.maxEntries) || 64;
    this.maxBodyBytes = Number(options.maxBodyBytes) || 512 * 1024;
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key, usageToken) {
    const item = this.entries.get(key);
    if (!item) return null;
    if (this.now() - item.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, item);
    // 命中滑动续期：语义键已包含全部当前证据（指令/环境/历史/工具回执/退出码），
    // 相同键重放与条目年龄无关；不续期会让「预热全命中→计分时集中过期」连锁失效。
    item.storedAt = this.now();
    const body = replayBody(item.body, item.usageToken, usageToken);
    return {
      statusCode: item.statusCode,
      headers: { ...replayHeaders(item.headers), 'content-length': body.length },
      body,
    };
  }

  set(key, response = {}) {
    const body = Buffer.from(response.body || '');
    if (!key || response.statusCode !== 200 || !body.length ||
        body.length > this.maxBodyBytes || ERROR_EVENT.test(body.toString('utf8'))) {
      return false;
    }
    this.entries.delete(key);
    this.entries.set(key, {
      statusCode: response.statusCode,
      headers: { ...(response.headers || {}) },
      body,
      usageToken: String(response.usageToken || ''),
      storedAt: this.now(),
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return true;
  }
}
