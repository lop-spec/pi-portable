import { collectConversationNodeRecords } from "@/lib/pi-portable-runtime.js";
import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { resolveSessionPath, openSessionManager, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    if (url.searchParams.get('nodes') === '1') {
      const branch = sm.getBranch(leafId).filter(entry => entry.type === 'message');
      const records = collectConversationNodeRecords(branch.map(entry => entry.message), branch.map(entry => entry.id));
      const nodes = records.map(({ role, text, fullText, entryId }) => ({ role, text, fullText, entryId }));
      return jsonResponse(req, { nodes }, { headers: { 'Cache-Control': 'no-store' } });
    }
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    // ?view=chat is opt-in (see buildSessionContext); default shape unchanged.
    const chatViewOptions = url.searchParams.get("view") === "chat"
      ? { view: "chat" as const, cwd: sm.getHeader()?.cwd }
      : undefined;
    const context = buildSessionContext(sm.getEntries() as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      ...chatViewOptions,
      sessionId: id,
    });

    // A history page is 100s of KB of repetitive JSON; gzip it like /api/sessions/[id] (P21).
    return jsonResponse(req, { context, tail, before: before ?? null });
  } catch (error) {
    console.error("[pi-web] conversation context failed:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
