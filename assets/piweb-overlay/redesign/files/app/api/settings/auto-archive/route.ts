import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { readAutoArchive, saveAutoArchive } from '@/lib/portable-auto-archive.mjs';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET() {
  try { return Response.json(readAutoArchive(getAgentDir()), { headers }); }
  catch (error) {
    console.error('[auto-archive] read failed', error);
    return Response.json({ error: '自动归档设置读取失败' }, { status: 500, headers });
  }
}

export async function PUT(req: Request) {
  if (!projectMutationAllowed(req)) return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  try {
    const body = await req.json();
    return Response.json(saveAutoArchive(getAgentDir(), body.enabled), { headers });
  } catch (error) {
    console.error('[auto-archive] save failed', error);
    return Response.json({ error: '自动归档设置未保存' }, { status: 400, headers });
  }
}
