// 省轮次：路径不存在时附最近存在目录下的相近项；grep 的 pattern 不是合法正则时按字面量搜；
// read 可选 paths 一次读多个已知文件（不传 paths 时原样交给原生 read）。
// 不调用模型、不注入消息、不改其他工具；每次介入与 fail-open 都记日志。
// 依据：2026-09-25~10-02 交互会话 74 次 read/grep/ls 路径不存在、7 次 grep 正则解析失败，几乎每次都多一轮。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "tool-hints-v2";
export const MAX_EXTRA_PATHS = 7;
export const MULTI_READ_MAX_CHARS = 120_000;
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

// 依据：09-25~10-02 真实会话里只读接只读的单工具连续调用 497 对，348 对后者参数不在前者结果里（大概率互不依赖）；
// 10-04 A/B 证明规则措辞推不动并行，所以把「一次读多个」做成参数。
export function multiReadTool(template: any, forCwd: (cwd: string) => any, Type: any) {
  const parameters = Type.Object({ ...template.parameters.properties,
    paths: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_EXTRA_PATHS, description: `Additional files to read in this same call (up to ${MAX_EXTRA_PATHS}), each from the start with the default limit; offset/limit apply only to path. Use it instead of separate read calls when the files are already known.` })),
  });
  return { ...template, parameters,
    description: `${template.description} To read several known files at once, list the extra ones in paths.`,
    async execute(id: string, input: any, signal: any, onUpdate: any, ctx: any) {
      const { paths, ...first } = input ?? {};
      const base = forCwd(ctx?.cwd || process.cwd());
      const extra = Array.isArray(paths) ? [...new Set(paths.filter((p: unknown) => typeof p === "string" && p && p !== first.path))] as string[] : [];
      if (!extra.length) return base.execute(id, first, signal, onUpdate, ctx);
      const content: any[] = [], skipped: string[] = [];
      let chars = 0, failed = 0, details: any;
      for (const [i, p] of [first.path, ...extra].entries()) {
        if (chars >= MULTI_READ_MAX_CHARS) { skipped.push(p); continue; }
        content.push({ type: "text", text: `=== ${p} ===` });
        try {
          const r = await base.execute(`${id}#${i}`, i ? { path: p } : first, signal, undefined, ctx);
          if (i === 0) details = r.details;
          for (const c of r.content || []) { content.push(c); if (c.type === "text") chars += c.text.length; }
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          content.push({ type: "text", text: `[读取失败] ${message}${MISSING.test(message) ? missingPathHint(p, ctx?.cwd || process.cwd()) : ""}` });
        }
      }
      if (skipped.length) content.push({ type: "text", text: `[未读，合计已超 ${MULTI_READ_MAX_CHARS} 字符] ${skipped.join(", ")}` });
      log(`multi-read call=${oneLine(id)} files=${extra.length + 1} failed=${failed} skipped=${skipped.length}`);
      if (failed === extra.length + 1) throw Error(content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      return { content, details };
    },
  };
}

// deps 仅供测试注入；运行时由 Pi 的加载器解析这两个包。
export default async function (pi: ExtensionAPI, deps?: { Type: any; createReadToolDefinition: (cwd: string) => any }) {
  log(`loaded version=${VERSION}`);
  try {
    const { Type } = deps ?? await import("typebox");
    const create = deps?.createReadToolDefinition ?? (await import("@earendil-works/pi-coding-agent")).createReadToolDefinition;
    const cache = new Map<string, any>();
    const forCwd = (cwd: string) => { let t = cache.get(cwd); if (!t) { t = create(cwd); cache.set(cwd, t); } return t; };
    pi.registerTool(multiReadTool(forCwd(process.cwd()), forCwd, Type));
  } catch (error) { log(`FAIL_OPEN multi-read native-read-kept reason=${oneLine(error)}`); }

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
      if (!event.isError || !PATH_TOOLS.has(event.toolName) || event.input?.paths?.length) return; // 多文件读取已在结果里逐个附提示
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
