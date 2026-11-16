import { isClineAgentInstalled } from "@/lib/cline-agent";

// Whether this server can run Cline turns; the composer hides its agent switch otherwise.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ installed: isClineAgentInstalled() }, { headers: { "Cache-Control": "no-store" } });
}
