// Shared implementation for the CLI, web creation, and physical session moves.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ProjectStore, atomicWrite, projectKey, relocateSessionHeaders, isManagedSessionPath, prepareSessionHeader, commitSessionHeaders, restoreSessionHeaders, writeHeaderJournal } from './portable-project-store.mjs';

export const STANDARD_PROJECTS = ['极速浏览器', 'Pi与pi-web', 'Windows', 'Android', '股票回测', '图像与视频', '数据运维', '生活事务'];
const projectAliases = { 'pi-web性能优化': 'Pi与pi-web', 'Pi规则与扩展': 'Pi与pi-web', '远程桌面': 'Windows', '视频画质增强': '图像与视频', '图文生成': '图像与视频', '每日创意': '图像与视频', '购物选品': '生活事务', '社交生活': '生活事务' };
export function validProjectName(value) {
  if (typeof value !== 'string') throw new Error('需要准确的项目名称');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 40 || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name) || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9]|未分类|未归属|收件箱|新项目|综合工作台|其他)(?:\..*)?$/iu.test(name)) throw new Error('项目名称必须具体、单层且不含路径或保留名称');
  return projectAliases[name] ?? STANDARD_PROJECTS.find(p => p.toLowerCase() === name.toLowerCase()) ?? name;
}
export function routingLayout(agentDir) {
  const registry = new ProjectStore(path.join(agentDir, 'web-projects.json'));
  const data = registry.read();
  const baseRoot = data.baseRoot ?? (os.hostname().toLowerCase() === 'lop-home' ? 'D:/Documents/pi-web' : path.join(os.userInfo().homedir, 'Documents', 'Pi项目'));
  const inbox = data.inbox ?? path.join(path.dirname(baseRoot), 'Pi收件');
  return { registry, data, baseRoot: path.resolve(baseRoot), inbox: path.resolve(inbox) };
}
export function sessionIndex(agentDir, cwd) {
  const safe = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(agentDir, 'sessions', safe);
}
export function indexedSessionPath(agentDir, file) {
  const sessions = path.join(agentDir, 'sessions'), rel = path.relative(sessions, file);
  if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return file;
  const real = fs.realpathSync(file), layout = routingLayout(agentDir);
  const root = [...layout.data.projects.map(p => p.root), layout.inbox].find(root => projectKey(path.dirname(real)) === projectKey(path.join(root, '会话')));
  if (!root) throw new Error('会话物理路径未登记');
  return path.join(sessionIndex(agentDir, root), path.basename(real));
}
export function ensureSessionIndex(agentDir, cwd, physicalDir) {
  fs.mkdirSync(physicalDir, { recursive: true });
  const link = sessionIndex(agentDir, cwd);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (fs.existsSync(link)) {
    if (projectKey(fs.realpathSync(link)) === projectKey(physicalDir)) return link;
    // Never replace an existing nonempty session directory or a foreign junction.
    if (fs.lstatSync(link).isSymbolicLink() || fs.readdirSync(link).length) throw new Error('会话索引已存在且不为空：' + link);
    fs.rmdirSync(link);
  }
  fs.symlinkSync(path.resolve(physicalDir), link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}
export function ensureInbox(agentDir) {
  const { inbox } = routingLayout(agentDir);
  fs.mkdirSync(inbox, { recursive: true });
  ensureSessionIndex(agentDir, inbox, path.join(inbox, '会话'));
  return inbox;
}
export function createProject(agentDir, value) {
  const name = validProjectName(value), layout = routingLayout(agentDir);
  const existing = layout.data.projects.find(p => (p.name ?? path.basename(p.root)).toLowerCase() === name.toLowerCase());
  if (!existing && layout.data.managed && layout.data.projects.length >= 8) throw new Error('项目已满 8 个，请先合并并重命名');
  const cwd = existing?.root ?? path.join(layout.baseRoot, name);
  // Managed project names occupy exactly one level beneath the base.
  if (path.dirname(path.resolve(cwd)) !== layout.baseRoot) throw new Error('请先将同名旧项目整理到项目根目录：' + cwd);
  fs.mkdirSync(cwd, { recursive: true });
  ensureSessionIndex(agentDir, cwd, path.join(cwd, '会话'));
  const key = projectKey(cwd);
  const next = { ...layout.data, baseRoot: layout.baseRoot, inbox: layout.inbox, managed: true,
    projects: [...layout.data.projects.filter(p => p.key !== key), { key, root: cwd, name }],
    hidden: layout.data.hidden.filter(k => k !== key && k !== projectKey(layout.inbox)) };
  if (JSON.stringify(next) !== JSON.stringify(layout.data)) layout.registry.save(next);
  return { ...next, cwd, projectRoot: cwd, projectKey: key };
}
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf); const end = buf.subarray(0, n).indexOf(10); if (end < 0) throw new Error('会话头无效'); return JSON.parse(buf.subarray(0, end).toString('utf8')); }
  finally { fs.closeSync(fd); }
}
// Transcripts live at <base>/<project>/会话/<file>. The SDK's single-level index
// is only a junction, not a second copy. This preserves SDK discovery and a 3-level layout.
export async function moveProjectSessions({ agentDir, sessions, name, title, preserveCwd = false }) {
  if (title !== undefined) validSessionTitle(title);
  validProjectName(name);
  const sessionRoot = path.join(agentDir, 'sessions');
  const before = sessions.map(s => {
    if (!isManagedSessionPath(s.path, sessionRoot)) throw new Error('会话不在受管目录：' + s.id);
    const header = readHeader(s.path);
    if (header.type !== 'session' || header.id !== s.id) throw new Error('会话身份不匹配');
    return { ...s, header, real: fs.realpathSync(s.path), stat: fs.statSync(s.path) };
  });
  const project = createProject(agentDir, name), folder = path.join(project.cwd, '会话');
  const moves = before.map(s => ({ ...s, target: path.join(folder, path.basename(s.path)) }));
  for (const s of moves) if (projectKey(s.real) !== projectKey(s.target) && fs.existsSync(s.target)) throw new Error('目标会话已存在，拒绝覆盖：' + s.target);
  const changed = moves.filter(s => projectKey(s.real) !== projectKey(s.target) || (!preserveCwd && projectKey(s.header.cwd) !== projectKey(project.cwd)));
  if (!changed.length) {
    if (title !== undefined) renameSessionTitle(moves[0].target, title);
    return { ok: true, changed: false, info: { ...sessions[0], ...(title !== undefined ? { name: title } : {}), projectRoot: project.cwd, projectKey: project.projectKey }, ...project };
  }
  const journalDir = path.join(agentDir, 'project-migrations');
  const journal = path.join(journalDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID() + '.json');
  const records = moves.map(s => ({ id: s.id, from: s.path, real: s.real, to: s.target, cwd: s.header.cwd, mtime: s.stat.mtimeMs }));
  atomicWrite(journal, JSON.stringify({ state: 'prepared', records }, null, 2));
  const aliasesFile = path.join(agentDir, 'session-path-aliases.json'), assignedFile = path.join(agentDir, 'session-projects.json');
  const archiveFile = path.join(agentDir, 'session-archive.json');
  const states = [aliasesFile, assignedFile, archiveFile].map(file => ({ file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null }));
  const aliases = states[0].bytes ? JSON.parse(states[0].bytes.toString('utf8')) : {};
  const assigned = states[1].bytes ? JSON.parse(states[1].bytes.toString('utf8')) : {};
  const archive = states[2].bytes ? JSON.parse(states[2].bytes.toString('utf8')) : null;
  const renamed = [];
  let headerResult, beforeTitleSize;
  try {
    // No history rewrite or timestamp churn: the existing streaming header editor
    // keeps every byte after line 1 identical. Full-header journals permit rollback.
    if (!preserveCwd) headerResult = await relocateSessionHeaders(before, project.cwd, sessionRoot);
    for (const s of moves) {
      if (projectKey(s.real) !== projectKey(s.target)) { fs.renameSync(s.real, s.target); renamed.push(s); }
      fs.utimesSync(s.target, s.stat.atime, s.stat.mtime);
    }
    for (const s of moves) { aliases[s.path] = s.target; aliases[s.real] = s.target; }
    atomicWrite(aliasesFile, JSON.stringify(aliases, null, 2));
    for (const s of moves) assigned[s.id] = { root: project.cwd, path: s.target, originalCwd: assigned[s.id]?.originalCwd ?? s.header.cwd };
    atomicWrite(assignedFile, JSON.stringify(assigned, null, 2));
    if (archive?.sessions) {
      for (const s of moves) if (archive.sessions[s.id]) Object.assign(archive.sessions[s.id], { relativePath: path.relative(sessionRoot, indexedSessionPath(agentDir, s.target)).split(path.sep).join('/'), cwd: preserveCwd ? s.cwd : project.cwd, ...(title !== undefined && s.id === sessions[0].id ? { name: title } : {}) });
      atomicWrite(archiveFile, JSON.stringify(archive, null, 2));
    }
    if (title !== undefined) { beforeTitleSize = fs.statSync(moves[0].target).size; renameSessionTitle(moves[0].target, title); }
    atomicWrite(journal, JSON.stringify({ state: 'complete', records, headerBackups: headerResult?.backups ?? [] }, null, 2));
    return { ...project, ok: true, changed: true, sessionIds: sessions.map(s => s.id), journal,
      info: { ...sessions[0], ...(title !== undefined ? { name: title } : {}), path: moves[0].target, cwd: preserveCwd ? sessions[0].cwd : project.cwd, projectRoot: project.cwd, projectKey: project.projectKey } };
  } catch (error) {
    if (beforeTitleSize !== undefined && fs.existsSync(moves[0].target)) fs.truncateSync(moves[0].target, beforeTitleSize);
    for (const state of states) { if (state.bytes) atomicWrite(state.file, state.bytes); else fs.rmSync(state.file, { force: true }); }
    for (const s of renamed.reverse()) fs.renameSync(s.target, s.real);
    if (headerResult?.changed) {
      const restore = before.map(s => prepareSessionHeader(s.path, s.id, s.header.cwd, sessionRoot, false)).filter(p => p.changed);
      await commitSessionHeaders(restore, journal);
    }
    atomicWrite(journal, JSON.stringify({ state: 'rolled-back', records, error: String(error) }, null, 2));
    throw error;
  }
}
export async function renameManagedProject({ agentDir, root, name, sessions }) {
  const layout = routingLayout(agentDir), target = path.join(layout.baseRoot, validProjectName(name));
  if (projectKey(path.dirname(root)) !== projectKey(layout.baseRoot)) throw new Error('不是受管的单层项目');
  if (projectKey(root) === projectKey(target)) return { ...layout.data, cwd: root, previousRoot: root, sessionIds: [], changed: false };
  if (fs.existsSync(target)) throw new Error('同名目录已存在，拒绝覆盖');
  const within = value => { const rel = path.relative(root, value); return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  const remap = value => within(value) ? path.join(target, path.relative(root, value)) : value;
  const assigned = sessionAssignments(agentDir), aliases = pathAliases(agentDir);
  const affected = sessions.filter(s => within(s.cwd) || assigned[s.id]?.root && projectKey(assigned[s.id].root) === projectKey(root));
  const prepared = affected.map(s => prepareSessionHeader(s.path, s.id, remap(s.cwd), path.join(agentDir, 'sessions'), false)).filter(p => p.changed);
  const journal = prepared.length ? writeHeaderJournal(path.join(agentDir, 'sessions'), prepared) : null;
  const original = fs.readFileSync(layout.registry.file);
  let renamed = false;
  try {
    fs.renameSync(root, target); renamed = true;
    for (const item of prepared) item.file = remap(item.file);
    await commitSessionHeaders(prepared, journal);
    const data = layout.registry.rebase(root, target, path.basename(target));
    ensureSessionIndex(agentDir, target, path.join(target, '会话'));
    const oldIndex = sessionIndex(agentDir, root);
    try { if (fs.lstatSync(oldIndex).isSymbolicLink()) fs.unlinkSync(oldIndex); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [id, item] of Object.entries(assigned)) if (projectKey(item.root) === projectKey(root)) assigned[id] = { ...item, root: target, path: remap(item.path) };
    for (const [old, value] of Object.entries(aliases)) aliases[old] = remap(value);
    for (const s of affected) aliases[s.path] = remap(fs.existsSync(s.path) ? fs.realpathSync(s.path) : path.join(root, '会话', path.basename(s.path)));
    atomicWrite(path.join(agentDir, 'session-projects.json'), JSON.stringify(assigned, null, 2));
    atomicWrite(path.join(agentDir, 'session-path-aliases.json'), JSON.stringify(aliases, null, 2));
    const archiveFile = path.join(agentDir, 'session-archive.json');
    if (fs.existsSync(archiveFile)) {
      const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
      for (const s of affected) if (archive.sessions?.[s.id]) Object.assign(archive.sessions[s.id], { relativePath: path.relative(path.join(agentDir, 'sessions'), path.join(sessionIndex(agentDir, target), path.basename(s.path))).split(path.sep).join('/'), cwd: remap(s.cwd) });
      atomicWrite(archiveFile, JSON.stringify(archive, null, 2));
    }
    return { ...data, cwd: target, previousRoot: root, sessionIds: affected.map(s => s.id), changed: true, preserved: true };
  } catch (error) {
    await restoreSessionHeaders(prepared, journal);
    atomicWrite(layout.registry.file, original);
    if (renamed) fs.renameSync(target, root);
    throw error;
  }
}
export function sessionAssignments(agentDir) {
  const file = path.join(agentDir, 'session-projects.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
export function pathAliases(agentDir) {
  const file = path.join(agentDir, 'session-path-aliases.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
export function validSessionTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f<>]/u.test(value)) throw new Error('对话标题须简短具体，不能含控制符或标签');
  return value.trim();
}
export function renameSessionTitle(file, value) {
  const name = validSessionTitle(value), fd = fs.openSync(file, 'r');
  let lines;
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 65536), bytes = Buffer.alloc(size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    if (bytes.at(-1) !== 10) throw new Error('会话尾部未完整写入，拒绝改名');
    lines = bytes.toString('utf8').split('\n').filter(Boolean); if (start) lines.shift();
  } finally { fs.closeSync(fd); }
  const entries = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const last = entries.at(-1); if (!last?.id) throw new Error('会话尾部无有效节点');
  if ([...entries].reverse().find(e => e.type === 'session_info')?.name === name) return;
  fs.appendFileSync(file, JSON.stringify({ type: 'session_info', id: crypto.randomUUID(), parentId: last.type === 'session' ? null : last.id, timestamp: new Date().toISOString(), name }) + '\n');
}
export function projectTag(message) {
  if (message?.role !== 'assistant' || message.stopReason === 'toolUse' || !Array.isArray(message.content) || message.content.some(b => b.type === 'toolCall')) return null;
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/(?:^|\n)<归属 项目="([^<>\n"]{1,40})">([^<>\n]{1,80})<\/归属>\s*$/u);
  return match ? { project: validProjectName(match[1]), title: validSessionTitle(match[2]) } : null;
}
