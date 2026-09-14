import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { attachSessionProjectInfo, listAllSessions, mergeSessionLists, invalidateSessionListCache, invalidateSessionPathCache } from '@/lib/session-reader';
import { getRpcSession, getRpcSessionInfos, isRpcSessionStarting } from '@/lib/rpc-manager';
import { ProjectStore, directoryPath, withSessionMoveLock, relocateSessionHeaders, projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { allowFileRoot } from '@/lib/file-access';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!projectMutationAllowed(req)) {
    console.error('[pi-web projects] cross-origin move rejected');
    return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  try {
    const { id } = await params;
    const cwd = directoryPath((await req.json()).cwd);
    if (!statSync(cwd).isDirectory()) throw new Error('目标路径不是文件夹');
    const all = mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos());
    const target = all.find(s => s.id === id);
    if (!target) return Response.json({ error: 'Session not found' }, { status: 404 });
    if (target.relation?.kind === 'subagent') throw new Error('请移动主对话，关联子会话会一起移动');
    const ids = new Set([id]);
    let size = 0;
    while (ids.size !== size) {
      size = ids.size;
      all.forEach(s => { if (s.relation?.kind === 'subagent' && ids.has(s.relation.parentSessionId)) ids.add(s.id); });
    }
    const family = all.filter(s => ids.has(s.id));
    const info = (await attachSessionProjectInfo([{ ...target, cwd }]))[0];
    const registry = new ProjectStore(join(getAgentDir(), 'web-projects.json'));
    return await withSessionMoveLock([...ids], async () => {
      for (const sid of ids) {
        if (isRpcSessionStarting(sid) || getRpcSession(sid)?.isBusyForProjectMove()) throw new Error('对话或关联子会话正在运行，请停止后再移动');
      }
      registry.add(cwd, info.projectRoot ?? cwd);
      for (const sid of ids) await getRpcSession(sid)?.shutdown();
      const result = relocateSessionHeaders(family, cwd, join(getAgentDir(), 'sessions'));
      ids.forEach(sid => invalidateSessionPathCache(sid));
      invalidateSessionListCache();
      allowFileRoot(cwd);
      console.info('[pi-web projects] moved', [...ids], cwd);
      return Response.json({ ok: true, ...result, info, sessionIds: [...ids], preserved: true });
    });
  } catch (error) {
    console.error('[pi-web projects] move failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
