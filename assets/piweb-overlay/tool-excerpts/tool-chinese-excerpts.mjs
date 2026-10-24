// Presentation only: never read thinking, signatures, arguments or model input.
const cache = new WeakMap();
const sensitive = /password|passwd|secret|authorization|api[_-]?key|cookie|密码|密钥|口令|encrypted_content|thinkingSignature/iu;
/** @param {unknown} message @returns {string[]} */
export function toolChineseExcerpts(message) {
  if (!message || typeof message !== 'object' || message.role !== 'toolResult') return [];
  if (cache.has(message)) return cache.get(message);
  const saved = message.chatView?.chineseExcerpts;
  const phrases = new Set();
  if (Array.isArray(saved)) {
    for (const text of saved) if (typeof text === 'string' && /^[\u3400-\u9fff]{5,}$/u.test(text)) phrases.add(text);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const line of block.text.split(/\r?\n/u)) {
        if (sensitive.test(line)) continue;
        for (const [phrase] of line.matchAll(/[\u3400-\u9fff]{5,}/gu)) phrases.add(phrase);
      }
    }
  }
  const result = [...phrases];
  cache.set(message, result);
  return result;
}

/** Exact deduplication within one visible turn, preserving tool-call order. */
export function newToolChineseExcerpts(message, seen) {
  return toolChineseExcerpts(message).filter(text => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}
