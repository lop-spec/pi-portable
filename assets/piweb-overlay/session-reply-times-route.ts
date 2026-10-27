import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { listAllSessions, mergeSessionLists } from '@/lib/session-reader';
import { getRpcSessionInfos } from '@/lib/rpc-manager';
import { projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { lastAssistantReplyTime } from '@/lib/session-reply-time.mjs';
import { recentTasks } from '@/lib/recent-tasks.mjs';

export const dynamic = 'force-dynamic';
const cache = new Map<string, { fingerprint: string; time: number | null }>();
async function replyTime(file: string) {
  const info = await stat(file);
  const fingerprint = `${info.size}:${info.mtimeMs}:${info.ino}`, prior = cache.get(file);
  const time = prior?.fingerprint === fingerprint ? prior.time : await lastAssistantReplyTime(file);
  cache.delete(file); cache.set(file, { fingerprint, time });
  while (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return time;
}
async function limited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(10, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; result[index] = await fn(items[index]); }
  }));
  return result;
}
const catalogue = async () => mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos());
export async function POST(request: Request) {
  if (!projectMutationAllowed(request)) return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  try {
    const body = await request.json(), ids: unknown = body?.ids;
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(id))) return Response.json({ error: 'Invalid session ids' }, { status: 400 });
    const wanted = new Set(ids), sessions = (await catalogue()).filter(s => wanted.has(s.id));
    const values = await limited(sessions, async session => {
      try { const time = await replyTime(session.path); return { id: session.id, reply: time === null ? null : new Date(time).toISOString(), incomplete: false }; }
      catch { return { id: session.id, reply: null, incomplete: true }; }
    });
    return Response.json({ replies: Object.fromEntries(values.map(value => [value.id, value.reply])), incomplete: values.some(value => value.incomplete) || values.length < wanted.size }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
export async function GET() {
  try {
    const agentDir = getAgentDir(); let archived: Record<string, { relativePath?: string }> = {};
    try { archived = JSON.parse(await readFile(path.join(agentDir, 'session-archive.json'), 'utf8')).sessions ?? {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const matching = (s: { id: string; path: string }) => {
      const relative = archived[s.id]?.relativePath;
      if (!relative) return false;
      const expected = path.resolve(agentDir, 'sessions', ...relative.split('/')), actual = path.resolve(s.path);
      return process.platform === 'win32' ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
    };
    const all = await catalogue(), roots = all.filter(s => matching(s) && s.relation?.kind !== 'subagent');
    const values = await limited(roots, async session => {
      try { const time = await replyTime(session.path); return { session, time, incomplete: false }; }
      catch { return { session, time: null, incomplete: true }; }
    });
    const replies = Object.fromEntries(values.map(value => [value.session.id, value.time === null ? null : new Date(value.time).toISOString()]));
    const ranked = recentTasks(values.map(value => ({ root: value.session, subagents: [] })), new Set(), replies, Date.now());
    const ids = new Set<string>(ranked.map((family: { root: { id: string } }) => family.root.id));
    let count = 0;
    while (count !== ids.size) { count = ids.size; for (const s of all) if (matching(s) && s.relation?.kind === 'subagent' && ids.has(s.relation.parentSessionId)) ids.add(s.id); }
    return Response.json({ sessions: all.filter(s => ids.has(s.id)), replies: Object.fromEntries([...ids].filter(id => id in replies).map(id => [id, replies[id]])), incomplete: values.some(value => value.incomplete) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
