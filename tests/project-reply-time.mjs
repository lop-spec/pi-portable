import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastAssistantReplyTime, oldestReplySession } from '../assets/piweb-overlay/session-reply-time.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-time-'));
const entry = (type, role, timestamp, extra = {}) => JSON.stringify({ type, id: Math.random().toString(36), parentId: null, timestamp, ...(role ? { message: { role, content: '例子', ...extra } } : {}) }) + '\n';
const write = (name, content) => { const file = path.join(dir, name + '.jsonl'); fs.writeFileSync(file, content); return file; };
test('uses the last assistant reply, not the latest user message, metadata, or file mtime', async () => {
  const file = write('latest', entry('session', null, '2026-10-01T00:00:00Z') + entry('message', 'assistant', '2026-10-02T00:00:00Z') + entry('message', 'user', '2026-10-04T00:00:00Z') + entry('session_info', null, '2026-10-05T00:00:00Z'));
  fs.utimesSync(file, new Date(), new Date());
  assert.equal(await lastAssistantReplyTime(file), Date.parse('2026-10-02T00:00:00Z'));
});
test('handles arbitrary field order, UTF-8, escaped quotes, CRLF and very large lines', async () => {
  const first = JSON.stringify({ type: 'session', timestamp: '2026-10-01T00:00:00Z', id: 'x', cwd: dir }) + '\r\n';
  const reply = JSON.stringify({ timestamp: '2026-10-02T00:00:00Z', id: 'a', message: { content: '中文\\\"' + 'x'.repeat(3 * 1024 * 1024), role: 'assistant' }, type: 'message' }) + '\r\n';
  const file = write('large', first + reply + entry('message', 'user', '2026-10-03T00:00:00Z'));
  assert.equal(await lastAssistantReplyTime(file), Date.parse('2026-10-02T00:00:00Z'));
});
test('picks the oldest reply regardless of list order and skips conversations with no assistant reply', async () => {
  const later = write('later', entry('message', 'assistant', '2026-10-06T00:00:00Z'));
  const earlier = write('earlier', entry('message', 'assistant', '2026-10-01T00:00:00Z') + entry('message', 'user', '2026-10-20T00:00:00Z'));
  const noReply = write('no-reply', entry('message', 'user', '2026-09-01T00:00:00Z'));
  assert.equal((await oldestReplySession([{ id: 'later', path: later }, { id: 'no', path: noReply }, { id: 'earlier', path: earlier }])).session.id, 'earlier');
  await assert.rejects(oldestReplySession([{ id: 'no', path: noReply }]), /没有可识别回复时间/);
});
