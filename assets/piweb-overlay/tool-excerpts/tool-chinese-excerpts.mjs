// Presentation only: recover source boundaries, never model reasoning or code evaluation.
const cache = new WeakMap();
const sensitive = /password|passwd|secret|authorization|api[_-]?key|cookie|access[_-]?token|密码|密钥|口令/iu;
const privateKey = /^(?:thinking|analysis|reasoning|reasoning_content|thinkingSignature|encrypted_content)$/iu;
const privateLine = /["']?(?:thinking|analysis|reasoning|reasoning_content|thinkingSignature|encrypted_content)["']?\s*:/iu;
const hasChinese = text => (text.match(/[\u3400-\u9fff]/gu)?.length ?? 0) >= 5;
const literal = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu;

function decodeLiteral(raw) {
  if (raw[0] === '"') { try { return JSON.parse(raw); } catch { /* JS, not JSON */ } }
  return raw.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|\r?\n|([\s\S]))/giu, (_all, wide, u, x, simple) => {
    if (wide) { const code = parseInt(wide, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : _all; }
    if (u || x) return String.fromCharCode(parseInt(u || x, 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[simple] ?? simple ?? '';
  });
}

// Windows sometimes decodes a UTF-8 subprocess stream with code page 936.
// Reverse only high-confidence runs, before filtering or extracting text.
const suspect = /[銆锛鍙鐨鏍缁瀹绱杩浣鏂鍐鎴涔爜閰闅楠鍗鍒鍑鎵瀵嬪濂锟鈥闂绔]/gu;
const hanChar = /\p{Script=Han}/gu;
let gbPairs;
function windowsPairs() {
  if (gbPairs) return gbPairs;
  const decoder = new TextDecoder('gb18030', { fatal: true });
  const pairs = new Map([['€',0x80]]), bytes = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    bytes[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      bytes[1] = trail;
      try {
        const ch = decoder.decode(bytes);
        if (ch.length === 1 && !pairs.has(ch)) pairs.set(ch, lead * 256 + trail);
      } catch { /* not a code-page pair */ }
    }
  }
  gbPairs = pairs;
  return pairs;
}
function repairWindowsText(text) {
  return text.replace(/[^\x00-\x7f\s]{5,}/gu, run => {
    const signals = run.match(suspect)?.length ?? 0;
    const lossy = run.includes('\uFFFD');
    const privateUse = /[\uE000-\uF8FF]/u.test(run);
    if (signals < 2 && !(signals && (lossy || privateUse))) return run;
    const pairs = windowsPairs();
    const repair = part => {
      const bytes = new Uint8Array(part.length * 2);
      let i = 0;
      for (const ch of part) {
        const pair = pairs.get(ch);
        if (pair === undefined) return null;
        if (pair > 255) bytes[i++] = pair >> 8;
        bytes[i++] = pair & 255;
      }
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        // If Windows substituted a broken byte, keep the strictly decodable prefix only.
        const decoded = decoder.decode(bytes.subarray(0,i), { stream: lossy });
        const han = decoded.match(hanChar)?.length ?? 0;
        return han >= 3 && han * 2 >= decoded.length && !/[\x00-\x1f\x7f]/u.test(decoded) ? decoded : null;
      } catch { return null; }
    };
    if (!lossy) return repair(run) ?? (signals >= 3 && privateUse ? '' : run);
    const repaired = run.split(/\uFFFD+/u).filter(Boolean).map(part => repair(part));
    return repaired.some(Boolean) ? repaired.filter(Boolean).join(' ') : signals >= 2 ? '' : run;
  });
}

/** Keep complete JSON string values, quoted code/UI strings, or plain paragraphs. */
export function extractChineseSource(text) {
  const excerpts = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const clean = repairWindowsText(value).replaceAll('\r\n', '\n').trim();
    if (hasChinese(clean) && !sensitive.test(clean) && !privateLine.test(clean)) excerpts.add(clean);
  };
  const walk = value => {
    if (typeof value === 'string') { add(value); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value && typeof value === 'object') {
      if (['thinking', 'reasoning', 'analysis'].includes(value.type)) return;
      for (const [key, item] of Object.entries(value)) if (!privateKey.test(key) && !sensitive.test(key)) walk(item);
    }
  };
  const json = value => {
    try { walk(JSON.parse(value)); return true; } catch { return false; }
  };
  const plain = value => {
    for (const paragraph of value.replaceAll('\r\n', '\n').split(/\n[\t ]*\n/u)) {
      if (json(paragraph.trim())) continue;
      let pending = [];
      const flush = () => { add(pending.join('\n')); pending = []; };
      for (const line of paragraph.split('\n')) {
        if (sensitive.test(line) || privateLine.test(line)) { flush(); continue; }
        const trimmed = line.trim();
        if (/^[{\["]/u.test(trimmed) && json(trimmed)) { flush(); continue; }
        if (!/[\u3400-\u9fff]/u.test(line) && !/\\u(?:\{|[\da-f]{4})/iu.test(line)) { flush(); continue; }
        // Bound syntax detection: megabyte output lines must not cause quadratic regex work.
        const prefix = line.slice(0, 512);
        const syntax = /^\s*-\s+(?:button|generic|textbox|link|heading|paragraph|status|alert)\b/u.test(prefix)
          || /(?:^|\s)(?:const|let|var|return|export|throw)\s/u.test(prefix)
          || /(?:[\w.$]+\s*\(|[\w"']+\s*[:=])\s*["'`]/u.test(prefix);
        const strings = syntax ? [...line.matchAll(literal)].map(m => decodeLiteral(m[0])) : [];
        if (strings.some(hasChinese)) { flush(); for (const s of strings) add(s); }
        else pending.push(line);
      }
      flush();
    }
  };
  if (typeof text !== 'string' || !text.trim()) return [];
  if (!json(text.trim())) {
    let offset = 0;
    for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) {
      plain(text.slice(offset, match.index));
      if (!json(match[1].trim())) plain(match[1]);
      offset = match.index + match[0].length;
    }
    plain(text.slice(offset));
  }
  return [...excerpts];
}

/** @param {unknown} message @returns {string[]} */
export function toolChineseExcerpts(message) {
  if (!message || typeof message !== 'object' || message.role !== 'toolResult') return [];
  if (cache.has(message)) return cache.get(message);
  const excerpts = new Set();
  const saved = message.chatView?.chineseExcerpts;
  if (Array.isArray(saved)) {
    for (const value of saved) for (const text of extractChineseSource(value)) excerpts.add(text);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const text of extractChineseSource(block.text)) excerpts.add(text);
    }
  }
  const result = [...excerpts];
  cache.set(message, result);
  return result;
}

/** Exact source-unit deduplication within one visible turn, preserving call order. */
export function newToolChineseExcerpts(message, seen) {
  return toolChineseExcerpts(message).filter(text => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}
