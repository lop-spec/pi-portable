// 省报错轮：路径不存在时附最近存在目录下的相近项；grep 的 pattern 不是合法正则时按字面量搜。
// 不调用模型、不注入消息、不改其他工具；每次介入与 fail-open 都记日志。
// 依据：2026-09-25~10-02 交互会话 74 次 read/grep/ls 路径不存在、7 次 grep 正则解析失败，几乎每次都多一轮。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "tool-hints-v1";
const PATH_TOOLS = new Set(["read", "grep", "ls", "find"]);
const MISSING = /ENOENT|no such file or directory|Path not found|not found:/i;
const MAX_ITEMS = 12;
const LOG = process.env.PI_TOOL_HINTS_LOG || path.join(process.env.PI_PORTABLE_DATA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data"), "lop-tool-hints.log");
const oneLine = (value: unknown) => String(value).replace(/[\r\n]/g, " ").slice(0, 300);

function log(line: string) {
  try {
    try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, `${LOG}.1`); } catch {}
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch (error) { console.error(`[lop-tool-hints-log] ${oneLine(error)}`); }
}

// rg 用 Rust 正则；JS 两种模式都解析失败才判为非法，避免把 rg 合法写法误改成字面量。
export function isInvalidRegex(pattern: string) {
  const body = pattern.replace(/^\(\?[a-zA-Z]+\)/, "");
  for (const flags of ["", "u"]) { try { new RegExp(body, flags); return false; } catch {} }
  return true;
}

function score(name: string, wanted: string) {
  const a = name.toLowerCase(), b = wanted.toLowerCase();
  if (a === b) return 1000;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  const stem = b.replace(/\.[^.]+$/, "");
  return prefix * 2 + (stem.length >= 3 && a.includes(stem) ? 20 : 0) + (path.extname(a) && path.extname(a) === path.extname(b) ? 3 : 0);
}

// 返回追加给模型的提示；找不到任何存在的上级目录时返回空串。
export function missingPathHint(rawPath: string, cwd: string) {
  const target = path.resolve(cwd, rawPath.replace(/^@/, ""));
  let dir = path.dirname(target), wanted = path.basename(target);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    wanted = path.basename(dir);
    dir = parent;
  }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
  const ranked = entries
    .map(entry => ({ name: entry.name + (entry.isDirectory() ? "/" : ""), s: score(entry.name, wanted) }))
    .sort((x, y) => y.s - x.s || y.name.localeCompare(x.name))
    .slice(0, MAX_ITEMS)
    .map(item => item.name);
  const where = dir.replaceAll("\\", "/");
  return `\n[lop-tool-hints] 最近存在的目录：${where}（共 ${entries.length} 项）；与「${wanted}」最相近：${ranked.join(", ") || "(空目录)"}`;
}

export default function (pi: ExtensionAPI) {
  log(`loaded version=${VERSION}`);

  pi.on("tool_call", (event: any) => {
    try {
      if (event.toolName !== "grep") return;
      const input = event.input ?? {};
      if (input.literal || typeof input.pattern !== "string" || !isInvalidRegex(input.pattern)) return;
      input.literal = true;
      log(`grep-literal call=${oneLine(event.toolCallId)} pattern=${oneLine(input.pattern)}`);
    } catch (error) { log(`FAIL_OPEN tool_call reason=${oneLine(error)}`); }
  });

  pi.on("tool_result", (event: any, ctx: any) => {
    try {
      if (!event.isError || !PATH_TOOLS.has(event.toolName)) return;
      const rawPath = event.input?.path;
      const text = (event.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      if (typeof rawPath !== "string" || !rawPath || !MISSING.test(text)) return;
      const hint = missingPathHint(rawPath, ctx?.cwd || process.cwd());
      if (!hint) { log(`no-hint tool=${event.toolName} path=${oneLine(rawPath)} reason=no-existing-ancestor`); return; }
      log(`path-hint tool=${event.toolName} path=${oneLine(rawPath)}`);
      return { content: [...event.content, { type: "text", text: hint }] };
    } catch (error) { log(`FAIL_OPEN tool_result reason=${oneLine(error)}`); }
  });
}
