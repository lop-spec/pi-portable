// Extract the timestamp of the last assistant message without parsing or retaining transcript bodies.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const CHUNK = 64 * 1024;

function messageHead() {
  const stack = []; let quoted = false, escaped = false, capture = false, token = '', keyString = false, target;
  const out = {};
  const feed = text => {
    for (const ch of text) {
      if (quoted) {
        if (capture) { token += ch; if (token.length > 2048) { capture = false; token = ''; } }
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch !== '"') continue;
        quoted = false;
        if (capture) {
          let value; try { value = JSON.parse(token); } catch { value = undefined; }
          const frame = stack.at(-1);
          if (keyString && frame) { frame.key = value; frame.expectKey = false; }
          else if (target) out[target] = value;
        } else if (keyString && stack.at(-1)) { stack.at(-1).key = null; stack.at(-1).expectKey = false; }
        if (out.type && out.type !== 'message') return true;
        if (out.type === 'message' && out.role && out.timestamp) return true;
        continue;
      }
      const frame = stack.at(-1);
      if (ch === '{' || ch === '[') {
        const tag = !frame ? 'root' : frame.tag === 'root' && frame.key === 'message' && ch === '{' ? 'message' : 'other';
        stack.push({ kind: ch, tag, expectKey: ch === '{', key: null });
      } else if (ch === '}' || ch === ']') stack.pop();
      else if (ch === ',' && frame?.kind === '{') { frame.expectKey = true; frame.key = null; }
      else if (ch === '"') {
        quoted = true; escaped = false; keyString = Boolean(frame?.kind === '{' && frame.expectKey);
        target = !keyString && frame?.tag === 'root' && ['type', 'timestamp'].includes(frame.key) ? frame.key
          : !keyString && frame?.tag === 'message' && frame.key === 'role' ? 'role' : null;
        capture = keyString || Boolean(target); token = capture ? '"' : '';
      }
    }
    return false;
  };
  return { feed, out };
}
async function lineMetadata(handle, start, end) {
  const head = messageHead(), decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, end - start)));
  for (let offset = start; offset < end;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
    if (!bytesRead) break; offset += bytesRead;
    if (head.feed(decoder.write(buffer.subarray(0, bytesRead)))) return head.out;
  }
  head.feed(decoder.end()); return head.out;
}
export async function lastAssistantReplyTime(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const size = (await handle.stat()).size, buffer = Buffer.allocUnsafe(CHUNK); let cursor = size, end = size;
    const check = async start => {
      if (end <= start) return null;
      const entry = await lineMetadata(handle, start, end);
      if (entry.type !== 'message' || entry.role !== 'assistant') return null;
      const time = Date.parse(entry.timestamp); if (!Number.isFinite(time)) throw new Error('助手回复时间无效：' + file);
      return time;
    };
    while (cursor > 0) {
      const start = Math.max(0, cursor - CHUNK), length = cursor - start;
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead !== length) throw new Error('会话读取不完整：' + file);
      for (let i = length - 1; i >= 0; i--) if (buffer[i] === 10) {
        const time = await check(start + i + 1); if (time !== null) return time;
        end = start + i;
      }
      cursor = start;
    }
    return await check(0);
  } finally { await handle.close(); }
}
export async function oldestReplySession(sessions) {
  const times = await Promise.all(sessions.map(async session => ({ session, replyTime: await lastAssistantReplyTime(session.path) })));
  const known = times.filter(item => item.replyTime !== null).sort((a, b) => a.replyTime - b.replyTime || String(a.session.id).localeCompare(String(b.session.id)));
  if (!known.length) throw new Error('目标项目没有可识别回复时间的对话，暂不能自动归档');
  return known[0];
}
