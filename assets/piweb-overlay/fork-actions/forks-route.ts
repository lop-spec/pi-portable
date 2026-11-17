import { NextResponse } from "next/server";
import { getSessionEntries, listAllSessions, resolveSessionPath } from "@/lib/session-reader";
import { forkAnchor, forkMarkerTitle } from "@/lib/portable-fork-core.mjs";

export const dynamic = "force-dynamic";

// Fork markers of one session: the session it was forked from (when it is a fork) and the sessions forked
// from it, each with the turn it left from. Forks are the catalogue's sessions whose header names this
// session as parent; the turn comes from comparing entry ids (a fork copies its path with the ids intact).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const parentPath = await resolveSessionPath(id);
    if (!parentPath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const sessions = await listAllSessions();
    const relation = sessions.find((session) => session.id === id)?.relation;
    const originId = relation?.kind === "fork" ? relation.originSessionId : undefined;
    const origin = originId ? sessions.find((session) => session.id === originId) : undefined;
    const children = sessions.filter((session) => session.parentSessionId === id && session.relation?.kind === "fork");
    const parentEntries = children.length > 0 ? getSessionEntries(parentPath) : [];
    const forks = children.map((child) => {
      let anchorEntryId: string | null = null;
      try {
        anchorEntryId = forkAnchor(parentEntries, getSessionEntries(child.path));
      } catch (error) {
        console.error("[pi-web] fork point unreadable:", child.id, error);
      }
      return { id: child.id, title: forkMarkerTitle(child), created: child.created, anchorEntryId };
    }).sort((a, b) => a.created.localeCompare(b.created));
    return NextResponse.json({
      origin: origin ? { id: origin.id, title: forkMarkerTitle(origin) } : null,
      forks,
    });
  } catch (error) {
    console.error("[pi-web] fork markers failed:", id, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
