import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { listAllSessions, mergeSessionLists, invalidateSessionListCache, invalidateSessionPathCache } from '@/lib/session-reader';
import { getRpcSession, getRpcSessionInfos, isRpcSessionStarting } from '@/lib/rpc-manager';
import { withSessionMoveLock, projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { deleteSessionFiles } from '@/lib/portable-context-store.mjs';

// Separate explicit endpoint: legacy DELETE remains archive-compatible at the UI proxy.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!projectMutationAllowed(req)) {
    console.error('[pi-web physical-delete] cross-origin request rejected');
    return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  try {
    const { id } = await params;
    const { confirmId } = await req.json();
    if (confirmId !== id) throw new Error('缺少对话物理删除确认');
    const all = mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos());
    const target = all.find(s => s.id === id);
    if (!target) return Response.json({ error: 'Session not found' }, { status: 404 });
    if (target.relation?.kind === 'subagent') throw new Error('请删除主对话，关联子会话会一起删除');
    const ids = new Set([id]);
    let size = 0;
    while (ids.size !== size) { size = ids.size; all.forEach(s => { if (s.relation?.kind === 'subagent' && ids.has(s.relation.parentSessionId)) ids.add(s.id); }); }
    return await withSessionMoveLock([...ids], async () => {
      for (const sid of ids) if (isRpcSessionStarting(sid) || getRpcSession(sid)?.isBusyForProjectMove()) throw new Error('对话或关联子会话正在运行，请先停止');
      for (const sid of ids) await getRpcSession(sid)?.shutdown();
      const files = deleteSessionFiles(all.filter(s => ids.has(s.id)), join(getAgentDir(), 'sessions'), confirmId, id);
      ids.forEach(sid => invalidateSessionPathCache(sid));
      invalidateSessionListCache();
      console.info('[pi-web physical-delete] session files deleted', files);
      return Response.json({ ok: true, sessionIds: [...ids], deletedFiles: files });
    });
  } catch (error) {
    console.error('[pi-web physical-delete] rejected or failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
