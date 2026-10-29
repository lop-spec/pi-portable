import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { listAllSessions, mergeSessionLists } from '@/lib/session-reader';
import { getRpcSessionInfos } from '@/lib/rpc-manager';
import { projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { readStatusStore, updateStatusStore } from '@/lib/craft-session/store.mjs';

export const dynamic = 'force-dynamic';
export async function GET() {
  try { return Response.json(readStatusStore(getAgentDir()), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { console.error('[session status] read failed', error); return Response.json({ error: '会话状态读取失败' }, { status: 500 }); }
}
export async function POST(request: Request) {
  if (!projectMutationAllowed(request)) return Response.json({ error: '跨站请求被拒绝' }, { status: 403 });
  try {
    const body = await request.json();
    if (typeof body?.id !== 'string' || !body.patch) return Response.json({ error: '无效请求' }, { status: 400 });
    const sessions = mergeSessionLists(await listAllSessions(), getRpcSessionInfos());
    if (!sessions.some(session => session.id === body.id && !session.transient)) return Response.json({ error: '会话不存在或尚未保存' }, { status: 404 });
    const result = updateStatusStore(getAgentDir(), body.id, body.patch);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[session status] update failed', error);
    return Response.json({ error: error instanceof Error ? error.message : '会话状态保存失败' }, { status: 400 });
  }
}
