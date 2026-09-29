import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { atomicWrite, projectMutationAllowed } from '@/lib/portable-project-store.mjs';
import { normalizeModelMenu } from '@/lib/portable-model-menu.mjs';

// Which models the model menu lists directly (the rest go under "更多模型"); one file for
// every browser of this pi-web, next to web-projects.json.
export const dynamic = 'force-dynamic';
const file = () => join(getAgentDir(), 'web-model-menu.json');

function read() {
  try { return normalizeModelMenu(JSON.parse(readFileSync(file(), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalizeModelMenu(null);
    throw error;
  }
}

export async function GET() {
  try { return Response.json(read(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) {
    console.error('[pi-web model menu] read failed', error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!projectMutationAllowed(req)) {
    console.error('[pi-web model menu] cross-origin mutation rejected');
    return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  try {
    const menu = normalizeModelMenu(await req.json());
    atomicWrite(file(), JSON.stringify({ primary: menu.primary }, null, 2) + '\n');
    return Response.json(menu, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[pi-web model menu] save failed', error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
