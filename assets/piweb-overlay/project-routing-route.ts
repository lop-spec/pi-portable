import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { listAllSessions, mergeSessionLists, invalidateSessionListCache, invalidateSessionPathCache } from '@/lib/session-reader';
import { getRpcSession, getRpcSessionInfos, isRpcSessionStarting } from '@/lib/rpc-manager';
import { projectMutationAllowed, withSessionMoveLock } from '@/lib/portable-project-store.mjs';
import { createProject, ensureInbox, routingLayout, moveProjectSessions, validProjectName } from '@/lib/project-routing.mjs';
import { allowFileRoot } from '@/lib/file-access';
export const dynamic = 'force-dynamic';
export async function GET() {
  const agentDir = getAgentDir(), layout = routingLayout(agentDir);
  const inbox = ensureInbox(agentDir);
  return Response.json({ ...layout.data, baseRoot: layout.baseRoot, inbox }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(req: Request) {
  if (!projectMutationAllowed(req)) return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  try {
    const body = await req.json(), agentDir = getAgentDir();
    const name = validProjectName(body.project);
    if (body.action === 'create') { const result = createProject(agentDir, name); allowFileRoot(result.cwd); invalidateSessionListCache(); return Response.json(result); }
    if (body.action !== 'move') return Response.json({ error: 'Unknown action' }, { status: 400 });
    const all = mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos());
    const target = all.find(s => s.id === body.id);
    if (!target) return Response.json({ error: 'Session not found' }, { status: 404 });
    if (target.relation?.kind === 'subagent') throw new Error('请移动主对话，关联子会话会一起移动');
    const ids = new Set<string>([target.id]);
    let size = 0;
    while (size !== ids.size) { size = ids.size; all.forEach(s => { if (s.relation?.kind === 'subagent' && ids.has(s.relation.parentSessionId)) ids.add(s.id); }); }
    return await withSessionMoveLock([...ids], async () => {
      for (const id of ids) if (isRpcSessionStarting(id) || getRpcSession(id)?.isBusyForProjectMove()) throw new Error('对话正在运行，归属将在回复完成后执行');
      for (const id of ids) await getRpcSession(id)?.shutdown();
      const family = [target, ...all.filter(s => s.id !== target.id && ids.has(s.id))];
      const result = await moveProjectSessions({ agentDir, sessions: family, name, title: body.title, preserveCwd: Boolean(body.preserveCwd) });
      for (const id of ids) invalidateSessionPathCache(id);
      invalidateSessionListCache(); allowFileRoot(result.cwd);
      return Response.json(result);
    });
  } catch (error) { console.error('[pi-project]', error); return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
}
