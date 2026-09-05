// 受管双机同步（YANGYONG ↔ DESKTOP-3EGB4LB），一条命令完成：对端备份 → 传输 → 读回 SHA256 比对 → 代码顺带 node --check。
// 用法：
//   node peer-sync.mjs push <文件...>            整文件同步（三棵已知树自动映射；其他目录按相同绝对路径同步，仅处理显式指定文件）
//   node peer-sync.mjs patch <文件> < spec.json   只同步改动行：stdin 为 {"old":"...","new":"..."} 或其数组，每个锚点在对端必须恰好一处；
//                                                适用于 AGENTS.md / CLAUDE.md 这类含机器特有内容、不能整文件覆盖的文件
//   node peer-sync.mjs status                     打印映射与 SSH 连通性
// 别名：AGENTS = pi 全局规则(agent/AGENTS.md)，CLAUDE = ~/.claude/CLAUDE.md
// 只用 ssh/scp + 对端 PowerShell 内置命令（-EncodedCommand，避开 cmd 引号地狱）；不打印任何凭据。
// 退出码：任一文件失败为 1；用法错误为 2。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

export const SITES = {
  yangyong: {
    host: "100.84.69.5",
    repo: "C:/Users/lop/Documents/claude/pi-portable",
    agent: "C:/Users/lop/.pi/agent",
    claude: "C:/Users/lop/.claude",
    node: "node",
  },
  "desktop-3egb4lb": {
    host: "100.98.35.74",
    repo: "D:/Downloads/pi-protable",
    agent: "D:/Downloads/pi-protable/data/.pi/agent",
    claude: "C:/Users/lop/.claude",
    node: "D:/Downloads/pi-protable/runtime/node.exe",
  },
};
export const PEER_OF = { yangyong: "desktop-3egb4lb", "desktop-3egb4lb": "yangyong" };
const SSH_USER = "lop";
const SSH_OPTS = ["-i", "C:/Users/lop/.ssh/id_ed25519", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR"];
const CHECKABLE_RE = /\.(mjs|cjs|js)$/iu;

const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/u, "");
const lower = (p) => norm(p).toLowerCase();
const realOrSelf = (p) => { try { return norm(fs.realpathSync.native(p)); } catch { return norm(path.resolve(p)); } };

export function localSiteName(hostname = os.hostname()) {
  const name = String(hostname).toLowerCase();
  if (!SITES[name]) throw new Error(`未知主机 ${hostname}；只认 ${Object.keys(SITES).join("/")}`);
  return name;
}

/** 已知树按根映射，其他目录使用相同绝对路径；junction/符号链接按 realpath 比，不递归扫描目录。 */
export function mapPath(input, siteName = localSiteName(), { realpath = realOrSelf } = {}) {
  const site = SITES[siteName];
  const peer = SITES[PEER_OF[siteName]];
  if (input === "AGENTS") return { local: `${site.agent}/AGENTS.md`, remote: `${peer.agent}/AGENTS.md`, tree: "agent" };
  if (input === "CLAUDE") return { local: `${site.claude}/CLAUDE.md`, remote: `${peer.claude}/CLAUDE.md`, tree: "claude" };
  const abs = realpath(path.resolve(input));
  // 对端 agent 根(data/.pi/agent)在 repo 根之下:按根路径最长优先匹配,否则会被 repo 抢先吞掉。
  const trees = ["repo", "agent", "claude"].sort((a, b) => lower(realpath(site[b])).length - lower(realpath(site[a])).length);
  for (const tree of trees) {
    const root = lower(realpath(site[tree]));
    if (lower(abs) === root || lower(abs).startsWith(`${root}/`)) {
      const rel = abs.slice(root.length + 1);
      return { local: abs, remote: rel ? `${peer[tree]}/${rel}` : peer[tree], tree };
    }
  }
  return { local: abs, remote: abs, tree: "absolute" };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const winPath = (p) => norm(p).replace(/\//g, "\\");
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function ssh(host, body, { allowFail = false } = {}) {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$ErrorActionPreference='Continue'\n${body}`;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  const r = spawnSync("ssh", [...SSH_OPTS, `${SSH_USER}@${host}`, `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 && !allowFail) throw new Error(`ssh 失败(${r.status})：${String(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return String(r.stdout || "");
}
function scpTo(host, local, remote) {
  execFileSync("scp", ["-q", ...SSH_OPTS, local, `${SSH_USER}@${host}:${norm(remote)}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}
function scpFrom(host, remote, local) {
  execFileSync("scp", ["-q", ...SSH_OPTS, `${SSH_USER}@${host}:${norm(remote)}`, local], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** 对端：目录保证存在；已有文件做 .bak-<ts>-<label> 备份；返回每个文件一行（BAK 路径 / NEW / FAIL）。 */
// 对端脚本用"路径数组 + 循环"：多文件时 -EncodedCommand 的体积只随路径长度增长(Windows 命令行上限 8191 字符)。
function remotePrepare(host, remotes, label) {
  const list = remotes.map((r) => psq(winPath(r))).join(",");
  const body = `$ts=Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($p in @(${list})) { try { New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $p) -ErrorAction Stop | Out-Null; if (Test-Path -LiteralPath $p) { $d=$p+'.bak-'+$ts+'-${label}'; Copy-Item -LiteralPath $p -Destination $d -ErrorAction Stop; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p -ErrorAction Stop).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $d -ErrorAction Stop).Hash) { throw 'backup hash mismatch' }; 'BAK '+$d } else { 'NEW' } } catch { 'FAIL '+$_ } }`;
  return ssh(host, body).trim().split(/\r?\n/).filter(Boolean);
}
/** 对端：每个文件一行 "<sha256>[ check=<exit>]"；.mjs/.cjs/.js 顺带对端 node --check。 */
function remoteVerify(host, peerSite, remotes) {
  const list = remotes.map((r) => psq(winPath(r))).join(",");
  const body = `$node=${psq(winPath(peerSite.node))}
foreach ($p in @(${list})) { try { $h=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower(); $c=''; if ($p -match '\\.(mjs|cjs|js)$') { & $node --check $p 2>&1 | Out-Null; $c=' check='+$LASTEXITCODE }; $h+$c } catch { 'FAIL '+$_ } }`;
  return ssh(host, body).trim().split(/\r?\n/).filter(Boolean);
}

export function runPush(files, { siteName = localSiteName(), label = "pre-sync" } = {}) {
  const peerName = PEER_OF[siteName];
  const peer = SITES[peerName];
  const items = files.map((f) => mapPath(f, siteName));
  for (const it of items) if (!fs.existsSync(it.local) || !fs.statSync(it.local).isFile()) throw new Error(`本机文件不存在：${it.local}`);
  const prepared = remotePrepare(peer.host, items.map((i) => i.remote), label);
  if (prepared.length !== items.length || prepared.some((line) => !/^(BAK |NEW$)/u.test(line))) throw new Error(`对端备份失败，未传输：${prepared.join("; ")}`);
  for (const it of items) scpTo(peer.host, it.local, it.remote);
  const verify = remoteVerify(peer.host, peer, items.map((i) => i.remote));
  let failed = 0;
  items.forEach((it, i) => {
    const localSha = sha256(fs.readFileSync(it.local));
    const [remoteSha, checkPart] = String(verify[i] || "").split(" check=");
    const checkOk = checkPart === undefined || checkPart.trim() === "0";
    const ok = remoteSha === localSha && checkOk && !String(prepared[i] || "").startsWith("FAIL");
    if (!ok) failed++;
    const checkText = checkPart === undefined ? "" : ` check=${checkOk ? "ok" : `exit ${checkPart.trim()}`}`;
    const shaText = remoteSha === localSha ? "" : ` 对端=${String(remoteSha).slice(0, 12)}`;
    console.log(`${ok ? "OK" : "MISMATCH"} ${it.local} -> ${peerName}:${it.remote} sha=${localSha.slice(0, 12)}${shaText}${checkText} ${prepared[i] || ""}`);
  });
  return failed;
}

export function applyPatch(text, spec) {
  const specs = Array.isArray(spec) ? spec : [spec];
  let out = text;
  for (const item of specs) {
    if (!item || typeof item.old !== "string" || typeof item.new !== "string" || !item.old) throw new Error('每项需要 {"old":"...","new":"..."}');
    const count = out.split(item.old).length - 1;
    if (count !== 1) throw new Error(`锚点在对端出现 ${count} 次，必须恰好 1 次：${item.old.slice(0, 40)}`);
    out = out.replace(item.old, () => item.new);
  }
  return out;
}

export function runPatch(file, spec, { siteName = localSiteName(), label = "pre-patch" } = {}) {
  if (!spec || (Array.isArray(spec) ? !spec.length : typeof spec.old !== "string")) throw new Error('stdin 需要 {"old":"...","new":"..."} 或其数组');
  const peerName = PEER_OF[siteName];
  const peer = SITES[peerName];
  const it = mapPath(file, siteName);
  const tmp = path.join(os.tmpdir(), `peer-sync-${process.pid}-${path.basename(it.remote)}`);
  scpFrom(peer.host, it.remote, tmp);
  const raw = fs.readFileSync(tmp, "utf8");
  const patched = applyPatch(raw.replace(/\r\n/g, "\n"), spec);
  const out = raw.includes("\r\n") ? patched.replace(/\n/g, "\r\n") : patched;
  fs.writeFileSync(tmp, out, "utf8");
  const prepared = remotePrepare(peer.host, [it.remote], label);
  if (prepared.length !== 1 || !/^(BAK |NEW$)/u.test(prepared[0])) throw new Error(`对端备份失败，未传输：${prepared.join("; ")}`);
  scpTo(peer.host, tmp, it.remote);
  const [line] = remoteVerify(peer.host, peer, [it.remote]);
  const expect = sha256(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  const ok = String(line || "").split(" ")[0] === expect;
  console.log(`${ok ? "OK" : "MISMATCH"} patch ${peerName}:${it.remote} sha=${expect.slice(0, 12)} ${prepared[0] || ""}`);
  return ok ? 0 : 1;
}

function runStatus(siteName = localSiteName()) {
  const peerName = PEER_OF[siteName];
  const peer = SITES[peerName];
  console.log(`本机 ${siteName} → 对端 ${peerName} (${peer.host})`);
  for (const tree of ["repo", "agent", "claude"]) console.log(`  ${tree.padEnd(6)} ${SITES[siteName][tree]}  ->  ${peer[tree]}`);
  console.log("  其他目录：相同绝对路径（仅显式指定文件，不递归）");
  const out = ssh(peer.host, "$env:COMPUTERNAME", { allowFail: true }).trim();
  console.log(out ? `  SSH ok: ${out}` : "  SSH 不通");
  return out ? 0 : 1;
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync.native(process.argv[1]).toLowerCase() === fs.realpathSync.native(fileURLToPath(import.meta.url)).toLowerCase(); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const labelIdx = rest.indexOf("--label");
    const label = labelIdx >= 0 ? String(rest[labelIdx + 1] || "sync").replace(/[^\w.-]+/g, "-") : undefined;
    const files = rest.filter((a, i) => labelIdx < 0 || (i !== labelIdx && i !== labelIdx + 1));
    const opts = label ? { label } : {};
    if (cmd === "push" && files.length) process.exit(runPush(files, opts) ? 1 : 0);
    if (cmd === "patch" && files.length === 1) process.exit(runPatch(files[0], JSON.parse(fs.readFileSync(0, "utf8")), opts));
    if (cmd === "status") process.exit(runStatus());
    console.error("用法：peer-sync.mjs push <文件...> | patch <文件> < spec.json | status   [--label 标签]");
    process.exit(2);
  } catch (error) {
    console.log(`FAIL ${String(error.message || error).slice(0, 300)}`);
    process.exit(1);
  }
}
