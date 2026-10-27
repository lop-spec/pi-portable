import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

const exec = promisify(execFile);

async function openWithSystem(target: string) {
  if (process.platform === "win32") {
    // The path is passed through the environment, never interpolated into a
    // command or shell. PowerShell itself is hidden; the requested app is not.
    const script = "$ErrorActionPreference='Stop';$p=New-Object System.Diagnostics.ProcessStartInfo;$p.FileName=$env:PIWEB_LOCAL_OPEN_TARGET;$p.UseShellExecute=$true;[System.Diagnostics.Process]::Start($p)|Out-Null";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await exec(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: { ...process.env, PIWEB_LOCAL_OPEN_TARGET: target }, windowsHide: true, timeout: 15000,
    });
    return;
  }
  await exec(process.platform === "darwin" ? "open" : "xdg-open", [target], { windowsHide: true, timeout: 15000 });
}

export async function POST(request: NextRequest) {
  // This opens a GUI on the server, so unlike a read-only file request it must
  // come from a same-origin browser action, not a cross-site or originless call.
  if (!isApiRequestAllowed(request) || !request.headers.get("origin") || !hasJsonContentType(request)) {
    return NextResponse.json({ error: "不允许的请求" }, { status: 403 });
  }
  let body: { path?: unknown; action?: unknown; sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
  }
  if (!body || typeof body.path !== "string" || body.path.length > 32767 || body.path.includes("\0") || !path.isAbsolute(body.path) || (body.action !== "file" && body.action !== "path")) {
    return NextResponse.json({ error: "文件路径或操作无效" }, { status: 400 });
  }
  const filePath = path.normalize(body.path);
  const roots = await getAllowedFileRoots();
  const allowedByRoot = isFilePathAllowed(filePath, roots);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const allowedBySession = !allowedByRoot && await isFilePathReferencedBySession(filePath, sessionId);
  if (!allowedByRoot && !allowedBySession) return NextResponse.json({ error: "文件不在允许访问的范围" }, { status: 403 });
  try {
    const fileStat = await stat(filePath);
    if (allowedByRoot && !isExistingFilePathAllowed(filePath, roots)) {
      return NextResponse.json({ error: "文件不在允许访问的范围" }, { status: 403 });
    }
    if (!fileStat.isFile() && !fileStat.isDirectory()) return NextResponse.json({ error: "不是普通文件或目录" }, { status: 400 });
    const target = body.action === "path" && !fileStat.isDirectory() ? path.dirname(filePath) : filePath;
    await openWithSystem(target);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return NextResponse.json({ error: "文件或目录不存在" }, { status: 404 });
    console.error("[pi-web] open local file failed:", error);
    return NextResponse.json({ error: "系统未能打开，请检查文件关联和权限" }, { status: 500 });
  }
}
