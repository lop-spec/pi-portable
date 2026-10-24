import { NextResponse } from 'next/server';
import { resolveSessionPath, buildSessionContext } from '@/lib/session-reader';
import { getRpcSession } from '@/lib/rpc-manager';
import { readDiskEntry } from '@/lib/session-disk-reader.mjs';
import { jsonResponse } from '@/lib/json-response';

// Explicit expansion only. Entry ids are scoped to the resolved session file.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id, entryId } = await params;
  try {
    const live = getRpcSession(id);
    const file = live?.isAlive() ? live.sessionFile : await resolveSessionPath(id);
    const entry = live?.isAlive() ? live.inner.sessionManager.getEntry(entryId) : file ? await readDiskEntry(file, entryId, new URL(req.url).searchParams) : null;
    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    const context = buildSessionContext([entry] as never, entryId, { sessionId: id, deferToolResultImages: true });
    return jsonResponse(req, { message: context.messages[0] ?? null }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
