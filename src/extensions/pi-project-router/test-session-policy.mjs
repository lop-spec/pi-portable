import fs from 'node:fs';
import path from 'node:path';

export const TEST_MARKER = '【测试任务】';
export function readTestIds(agentDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(agentDir, 'recent-test-sessions.json'), 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.ids) || data.ids.some(id => typeof id !== 'string')) throw new Error('Invalid test session registry');
    return new Set(data.ids);
  } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
}
export function isTestSession(session, ids = new Set()) {
  return ids.has(session.id) || session.testTask === true || (typeof session.firstMessage === 'string' && session.firstMessage.trimStart().startsWith(TEST_MARKER));
}
export function excludedTestIds(sessions, ids = new Set()) {
  const excluded = new Set(ids);
  for (const session of sessions) if (isTestSession(session, ids)) excluded.add(session.id);
  let size;
  do { size = excluded.size; for (const session of sessions) if (session.relation?.kind === 'subagent' && excluded.has(session.relation.parentSessionId)) excluded.add(session.id); } while (size !== excluded.size);
  return excluded;
}
export function visibleSessions(sessions, agentDir) {
  const excluded = excludedTestIds(sessions, readTestIds(agentDir));
  return sessions.filter(session => !excluded.has(session.id));
}
export function firstUserText(entries) {
  const message = entries.find(entry => entry.type === 'message' && entry.message?.role === 'user')?.message;
  return typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}
