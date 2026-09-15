import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ProjectStore, directoryPath, projectMutationAllowed, withSessionMoveLock, projectKey } from '@/lib/portable-project-store.mjs';
import { projectLeafTarget, renamePhysicalProject, relocateCopiedProject } from '@/lib/portable-project-layout.mjs';
import { resolveProject } from '@/lib/worktree';
import { allowFileRoot } from '@/lib/file-access';
import { projectIdentityKey } from '@/lib/project-identity';
import { listAllSessions, mergeSessionLists, invalidateSessionListCache, invalidateSessionPathCache } from '@/lib/session-reader';
import { getRpcSessionInfos, getRpcSession, hasBusyRpcSessionInProject } from '@/lib/rpc-manager';
import { deleteProjectDirectory, withProjectDeletionLock, pathWithin } from '@/lib/portable-context-store.mjs';

export const dynamic = 'force-dynamic';
const store = () => new ProjectStore(join(getAgentDir(), 'web-projects.json'));
export async function GET() {
  try { return Response.json(store().read(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { console.error('[pi-web projects] read failed', error); return Response.json({ error: String(error) }, { status: 500 }); }
}
export async function POST(req: Request) {
  if (!projectMutationAllowed(req)) {
    console.error('[pi-web projects] cross-origin mutation rejected');
    return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  try {
    const body = await req.json();
    const cwd = directoryPath(body.cwd);
    const registry = store();
    registry.read(); // fail before filesystem changes if state is corrupt
    if (body.action === 'remove') return Response.json({ ...registry.remove(cwd), preserved: true });
    if (body.action === 'rename' || body.action === 'delete' || body.action === 'relocate') {
      const all = mergeSessionLists(await listAllSessions({ force: true }), getRpcSessionInfos());
      const knownRoots = [...registry.read().projects.map((p: { root: string }) => p.root), ...all.map(s => s.projectRoot ?? s.cwd)];
      if (!knownRoots.some((p: string) => projectIdentityKey(p) === projectIdentityKey(cwd))) throw new Error('未知项目');
      if (body.action === 'rename' || body.action === 'relocate') {
        const target = body.action === 'rename' ? projectLeafTarget(cwd, body.name) : directoryPath(body.target);
        if (body.action === 'relocate' && (pathWithin(cwd, target) || pathWithin(target, cwd))) throw new Error('复制目标不能与源目录相互包含');
        const affected = all.filter(s => pathWithin(cwd, s.cwd));
        const ids = affected.map(s => s.id);
        const mutate = async () => withSessionMoveLock(ids, async () => {
          if (hasBusyRpcSessionInProject(cwd) || hasBusyRpcSessionInProject(target)) throw new Error('项目内有正在运行或启动的对话，请先停止');
          for (const sid of ids) await getRpcSession(sid)?.shutdown();
          let result;
          if (body.action === 'rename') result = renamePhysicalProject({ root: cwd, name: body.name, registry, sessions: affected, sessionRoot: join(getAgentDir(), 'sessions'), knownRoots, protectedRoots: [getAgentDir()] });
          else {
            if (!statSync(target).isDirectory()) throw new Error('复制目标不存在');
            if (!registry.read().projects.some((p: { root: string }) => projectKey(p.root) === projectKey(target))) throw new Error('请先添加已复制的目标项目');
            result = relocateCopiedProject({ root: cwd, target, registry, sessions: affected, sessionRoot: join(getAgentDir(), 'sessions'), knownRoots });
          }
          ids.forEach(sid => invalidateSessionPathCache(sid)); invalidateSessionListCache(); allowFileRoot(target);
          return Response.json(result);
        });
        return await withProjectDeletionLock(cwd, () => projectKey(cwd) === projectKey(target) ? mutate() : withProjectDeletionLock(target, mutate));
      }
      return await withProjectDeletionLock(cwd, async () => {
        if (hasBusyRpcSessionInProject(cwd)) throw new Error('项目内有正在运行或启动的对话，请先停止');
        for (const s of getRpcSessionInfos()) if (pathWithin(cwd, s.cwd)) await getRpcSession(s.id)?.shutdown();
        await deleteProjectDirectory(cwd, body.confirmPath, { knownRoots, protectedRoots: [getAgentDir()] });
        console.info('[pi-web projects] physically deleted directory; conversations preserved', cwd);
        return Response.json({ ...registry.remove(cwd), deletedPath: cwd, conversationsPreserved: true });
      });
    }
    if (body.action !== 'create' && body.action !== 'add') return Response.json({ error: 'Unknown action' }, { status: 400 });
    if (body.action === 'create') mkdirSync(cwd, { recursive: true });
    if (!statSync(cwd).isDirectory()) throw new Error('路径不是文件夹');
    const project = await resolveProject(cwd);
    const data = registry.add(cwd, project.projectRoot);
    allowFileRoot(cwd);
    return Response.json({ ...data, cwd, projectRoot: project.projectRoot, projectKey: projectIdentityKey(project.projectRoot) });
  } catch (error) {
    console.error('[pi-web projects] mutation failed', error);
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
