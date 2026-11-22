import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { getRpcSession } from "@/lib/rpc-manager";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { extractTurnWrittenFiles } from "@/lib/turn-written-files";
import type { AssistantContentBlock, ToolResultMessage } from "@/lib/types";
import { resolveLocalFileHref } from "@/lib/file-links";
import { isFilePathReferencedByEntries } from "@/lib/session-file-references-core";
import { collectSessionCandidates, extensionOf } from "@/lib/session-artifacts.mjs";

export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const live = getRpcSession(id), running = live?.isAlive() ? live : undefined;
    const filePath = running ? null : await resolveSessionPath(id);
    if (!running && !filePath) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const manager = running?.inner.sessionManager ?? openSessionManager(filePath!);
    const cwd = manager.getHeader()?.cwd;
    const branch = manager.getBranch();
    const candidates = collectSessionCandidates(branch, {
      writtenPaths: (calls: AssistantContentBlock[], results: Map<string, ToolResultMessage>) => extractTurnWrittenFiles(calls, results, cwd),
      resolveReference: (value: string) => resolveLocalFileHref(value, cwd),
    });
    const roots = await getAllowedFileRoots();
    const checked = await Promise.all(candidates.map(async (candidate: {filePath:string; source:string}) => {
      try {
        if (!isExistingFilePathAllowed(candidate.filePath, roots) && !isFilePathReferencedByEntries(candidate.filePath, branch as never)) return null;
        if (!(await stat(candidate.filePath)).isFile()) return null;
        return { ...candidate, extension: extensionOf(candidate.filePath) };
      } catch { return null; }
    }));
    return NextResponse.json({ files: checked.filter(Boolean) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[pi-web] session artifacts failed", error);
    return NextResponse.json({ error: "读取产物失败，请重试" }, { status: 500 });
  }
}
