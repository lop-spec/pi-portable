import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";

export const dynamic = "force-dynamic";

/** Same bound as the session list: the UI derives titles from the first 320 characters. */
const FIRST_MESSAGE_MAX_CHARS = 320;

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same catalog used by the sidebar. `allowStale`
    // keeps the request off the catalogue rebuild path: agent activity
    // invalidates the scan constantly, and rebuilding it costs hundreds of
    // milliseconds because loadAllSessions() re-reads every forked and subagent
    // session. The trade-off is that a session created in the last couple of
    // seconds is not searched yet; the stale read schedules the rebuild, so the
    // next search sees it.
    const sessions = query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    const response = await searchSessionContents(sessions, query, request.signal);
    // Result rows carry the whole session object for selection; only the
    // first message is unbounded (up to ~100KB), so trim it like the list does.
    return jsonResponse(request, {
      ...response,
      results: response.results.map((result) => (
        result.session.firstMessage.length > FIRST_MESSAGE_MAX_CHARS
          ? { ...result, session: { ...result.session, firstMessage: result.session.firstMessage.slice(0, FIRST_MESSAGE_MAX_CHARS) } }
          : result
      )),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
