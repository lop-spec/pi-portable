import { isClineAgentInstalled, isOpenCodeAgentInstalled } from "@/lib/cline-agent";

// Whether this server can run Cline turns; the composer hides its agent switch otherwise.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ installed: isClineAgentInstalled(), opencode: isOpenCodeAgentInstalled() }, { headers: { "Cache-Control": "no-store" } });
}
