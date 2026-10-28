import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { listAllSessions, mergeSessionLists, invalidateSessionListCache, invalidateSessionPathCache } from '@/lib/session-reader';
import { getRpcSession, getRpcSessionInfos, isRpcSessionStarting, hasBusyRpcSessionInProject } from '@/lib/rpc-manager';
import { projectMutationAllowed, withSessionMoveLock } from '@/lib/portable-project-store.mjs';
import { withProjectDeletionLock } from '@/lib/portable-context-store.mjs';
import { createProject, ensureInbox, routingLayout, moveProjectSessions, validProjectName, routingReport } from '@/lib/project-routing.mjs';
import { MAX_PROJECTS, planProjectMerge, mergeManagedProjects } from '@/lib/project-capacity.mjs';
import { allowFileRoot } from '@/lib/file-access';
export const dynamic = 'force-dynamic';
const catalogue = async () => mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos());
export async function GET() {
  const agentDir = getAgentDir(), layout = routingLayout(agentDir), inbox = ensureInbox(agentDir);
  // New/empty folders have no persisted session from which file-access can derive roots.
  allowFileRoot(inbox);
  for (const project of layout.data.projects) allowFileRoot(project.root);
  return Response.json({ ...layout.data, baseRoot: layout.baseRoot, inbox, ...routingReport(agentDir) }, { headers: { 'Cache-Control': 'no-store' } });
}
async function consolidate(agentDir: string, name: string) {
  const layout = routingLayout(agentDir), plan = planProjectMerge({ ...layout.data, baseRoot: layout.baseRoot }, name), all = await catalogue();
  const within = (root: string, cwd: string) => { const rel = path.relative(root.toLowerCase(), cwd.toLowerCase()); return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  const affected = all.filter(s => plan.projects.some((p: { root: string; key: string }) => s.projectKey === p.key || within(p.root, s.cwd)));
  const ids = affected.map(s => s.id), roots = [...new Set<string>([...plan.projects.map((p: { root: string }) => p.root), plan.target])];
  const lock = (index: number): Promise<unknown> => index < roots.length ? withProjectDeletionLock(roots[index], () => lock(index + 1)) : withSessionMoveLock(ids, async () => {
    if (plan.projects.some((p: { root: string }) => hasBusyRpcSessionInProject(p.root)) || ids.some(id => isRpcSessionStarting(id) || getRpcSession(id)?.isBusyForProjectMove())) throw new Error('待合并项目有对话正在运行，回复结束后再整理');
    for (const id of ids) await getRpcSession(id)?.shutdown();
    const result = await mergeManagedProjects({ agentDir, name: plan.name, sessions: all, projects: plan.projects });
    ids.forEach(id => invalidateSessionPathCache(id)); invalidateSessionListCache(); allowFileRoot(result.cwd); return result;
  });
  return lock(0);
}
export async function POST(req: Request) {
  if (!projectMutationAllowed(req)) return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  try {
    const body = await req.json(), agentDir = getAgentDir();
    if (body.action === 'verify') return Response.json(routingReport(agentDir, { id: body.id }));
    const name = validProjectName(body.project), layout = routingLayout(agentDir);
    if (!['create', 'move', 'merge'].includes(body.action)) return Response.json({ error: 'Unknown action' }, { status: 400 });
    const exists = layout.data.projects.some((p: { root: string; name?: string }) => (p.name ?? path.basename(p.root)).toLowerCase() === name.toLowerCase());
    if (body.action === 'merge' || !exists && layout.data.managed && layout.data.projects.length >= MAX_PROJECTS) {
      const result = await consolidate(agentDir, name);
      if (body.action !== 'move') return Response.json({ ...result as object, ...routingReport(agentDir) });
    }
    if (body.action === 'create') { const result = createProject(agentDir, name); allowFileRoot(result.cwd); invalidateSessionListCache(); return Response.json({ ...result, ...routingReport(agentDir) }); }
    const all = await catalogue(), target = all.find(s => s.id === body.id);
    if (!target) return Response.json({ error: 'Session not found' }, { status: 404 });
    if (target.relation?.kind === 'subagent') throw new Error('请移动主对话，关联子会话会一起移动');
    const ids = new Set<string>([target.id]); let size = 0;
    while (size !== ids.size) { size = ids.size; all.forEach(s => { if (s.relation?.kind === 'subagent' && ids.has(s.relation.parentSessionId)) ids.add(s.id); }); }
    return await withSessionMoveLock([...ids], async () => {
      for (const id of ids) if (isRpcSessionStarting(id) || getRpcSession(id)?.isBusyForProjectMove()) throw new Error('对话正在运行，归属将在回复完成后执行');
      for (const id of ids) await getRpcSession(id)?.shutdown();
      const family = [target, ...all.filter(s => s.id !== target.id && ids.has(s.id))];
      const result = await moveProjectSessions({ agentDir, sessions: family, name, title: body.title, preserveCwd: Boolean(body.preserveCwd) });
      ids.forEach(id => invalidateSessionPathCache(id)); invalidateSessionListCache(); allowFileRoot(result.cwd);
      const report = routingReport(agentDir, { id: target.id, file: result.info.path, title: body.title });
      if (!report.verification.ok) throw new Error('归档验证失败：' + report.verification.errors.join('；'));
      return Response.json({ ...result, ...report });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error), retryable = /正在运行|正在移动|正在物理删除/.test(message);
    console.error('[pi-project]', error); return Response.json({ error: message, retryable }, { status: retryable ? 409 : 422 });
  }
}
