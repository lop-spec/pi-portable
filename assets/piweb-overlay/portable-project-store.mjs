import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export function projectMutationAllowed(req) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.get('host'); }
  catch { return false; }
}

export const projectKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export function directoryPath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/u.test(value)) throw new Error('请输入有效的绝对目录路径');
  let candidate = value.trim();
  if (candidate === '~') candidate = os.homedir();
  else if (/^~[/\\]/u.test(candidate)) candidate = path.join(os.homedir(), candidate.slice(2));
  if (!path.isAbsolute(candidate)) throw new Error('请输入绝对路径，例如 D:\\Projects\\新项目');
  return path.resolve(candidate);
}
export function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function backupFile(file) {
  const backup = file + '.bak-' + Date.now() + '-' + crypto.randomUUID();
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  if (digest(fs.readFileSync(file)) !== digest(fs.readFileSync(backup))) throw new Error('备份校验失败，未修改原文件');
  return backup;
}
export class ProjectStore {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, projects: [], hidden: [] };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.hidden)) throw new Error('项目列表损坏，停止写入');
    return data;
  }
  save(data) {
    if (fs.existsSync(this.file)) backupFile(this.file);
    const text = JSON.stringify(data, null, 2) + '\n';
    atomicWrite(this.file, text);
    if (fs.readFileSync(this.file, 'utf8') !== text) throw new Error('项目列表读回失败');
    return data;
  }
  add(cwd, root = cwd, create = false) {
    cwd = directoryPath(cwd);
    if (create) fs.mkdirSync(cwd, { recursive: true });
    if (!fs.statSync(cwd).isDirectory()) throw new Error('路径不是文件夹');
    const data = this.read(), key = projectKey(root);
    const existing = data.projects.some(item => item.key === key);
    if (existing && !data.hidden.includes(key)) return data;
    data.projects = [{ key, root }, ...data.projects.filter(item => item.key !== key)];
    data.hidden = data.hidden.filter(item => item !== key);
    return this.save(data);
  }
  rebase(root, target, name) {
    const data = this.read();
    const within = p => { const rel = path.relative(projectKey(root), projectKey(p)); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
    const remap = p => within(p) ? path.join(target, path.relative(root, p)) : p;
    const existing = data.projects.find(p => p.key === projectKey(root));
    data.projects = data.projects.map(p => within(p.root) ? { ...p, root: remap(p.root), key: projectKey(remap(p.root)), ...(p.key === projectKey(root) ? { name } : {}) } : p);
    if (!existing) data.projects.unshift({ key: projectKey(target), root: target, name });
    data.projects = [...new Map(data.projects.map(p => [p.key, p])).values()];
    data.hidden = [...new Set([...data.hidden.map(remap).map(projectKey), projectKey(root)])].filter(p => p !== projectKey(target));
    return this.save(data);
  }
  remove(root) {
    const data = this.read(), key = projectKey(directoryPath(root));
    if (data.hidden.includes(key)) return data;
    data.projects = data.projects.filter(item => item.key !== key);
    data.hidden.push(key);
    return this.save(data);
  }
}

// Session files are append-only JSONL and the first line is the header; a project rename or a
// move changes that line's cwd and nothing else. So only the header is read, journaled and
// rewritten, never the history (a 400 MB project used to cost ~7 full passes and ~1 GB of RAM):
// in place when the new line fits (JSON allows trailing spaces, so a shorter line is padded to the
// old length and nothing after it moves), otherwise one streamed copy through a temp file that
// leaves HEADER_SLACK spaces so the next rename fits in place. The file path stays stable: archive
// records, forks, lazy media and bookmarks refer to it. All history bytes stay exact.
const HEADER_LIMIT = 65536, HEADER_SLACK = 512;
const headerScratch = Buffer.alloc(HEADER_LIMIT + 1);

/** The first line of a session file (with its line ending), parsed, plus the stat used to detect concurrent writes. */
function readHeaderLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size, mtimeMs } = fs.fstatSync(fd);
    let have = 0, end = -1;
    while (end < 0 && have <= HEADER_LIMIT) {
      const read = fs.readSync(fd, headerScratch, have, Math.min(4096, headerScratch.length - have), have);
      if (!read) break;
      end = headerScratch.subarray(have, have + read).indexOf(10);
      if (end >= 0) end += have;
      have += read;
    }
    if (end < 0 || end >= HEADER_LIMIT) throw new Error('会话头无效');
    const line = Buffer.from(headerScratch.subarray(0, end + 1));
    return { line, header: JSON.parse(line.toString('utf8')), size, mtimeMs };
  } finally { fs.closeSync(fd); }
}
function nextHeaderLine(current, cwd) {
  const eol = Buffer.from(current.line.length > 1 && current.line[current.line.length - 2] === 13 ? '\r\n' : '\n');
  const json = Buffer.from(JSON.stringify({ ...current.header, cwd }), 'utf8');
  const room = current.line.length - eol.length;
  if (json.length <= room) return Buffer.concat([json, Buffer.alloc(room - json.length, 0x20), eol]);
  const line = Buffer.concat([json, Buffer.alloc(HEADER_SLACK, 0x20), eol]);
  if (line.length > HEADER_LIMIT) throw new Error('会话头无效');
  return line;
}
/** Replace the first line of `file` with `line`; `expected` is what the caller last saw, and any other state is refused. */
async function writeHeaderLine(file, expected, line) {
  const live = fs.statSync(file);
  if (live.size !== expected.size || live.mtimeMs !== expected.mtimeMs || !readHeaderLine(file).line.equals(expected.line)) throw new Error('会话被其他进程修改，请停止后重试');
  if (line.length === expected.line.length) {
    const fd = fs.openSync(file, 'r+');
    try { fs.writeSync(fd, line, 0, line.length, 0); } finally { fs.closeSync(fd); }
  } else {
    const temp = file + '.tmp-' + crypto.randomUUID();
    try {
      const out = fs.createWriteStream(temp, { flags: 'wx' });
      out.write(line);
      await pipeline(fs.createReadStream(file, { start: expected.line.length, highWaterMark: 1 << 20 }), out);
      if (fs.statSync(temp).size !== expected.size - expected.line.length + line.length) throw new Error('会话头重写长度校验失败');
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  const after = fs.statSync(file);
  return { line, size: after.size, mtimeMs: after.mtimeMs };
}
/** Everything a rewrite changes is the header line, so saving the original lines is a complete backup. Restore = put `header` back as line 1. */
export function writeHeaderJournal(sessionRoot, items) {
  const dir = path.join(path.dirname(path.resolve(sessionRoot)), 'session-header-backups');
  const file = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`);
  atomicWrite(file, JSON.stringify({ version: 1, at: new Date().toISOString(), sessions: items.map(item => ({ id: item.current.header.id, file: item.file, header: item.current.line.toString('utf8') })) }, null, 1) + '\n');
  return file;
}
export function prepareSessionHeader(file, id, cwd, sessionRoot, validateDirectory = true) {
  cwd = directoryPath(cwd);
  if (validateDirectory && !fs.statSync(cwd).isDirectory()) throw new Error('目标路径不是文件夹');
  const realFile = fs.realpathSync(file), realRoot = fs.realpathSync(sessionRoot);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(realFile) !== '.jsonl') throw new Error('会话文件不在受管目录内');
  const current = readHeaderLine(realFile);
  if (current.header.type !== 'session' || current.header.id !== id) throw new Error('会话身份不匹配');
  if (projectKey(current.header.cwd) === projectKey(cwd)) return { changed: false, cwd };
  return { changed: true, cwd, file: realFile, current, next: nextHeaderLine(current, cwd) };
}
/** Put back, byte for byte, the headers of the changes that were already written (later ones first). Safe to repeat. */
export async function restoreSessionHeaders(changes, journal) {
  for (const item of [...changes].reverse()) {
    if (!item.after) continue;
    try { await writeHeaderLine(item.file, item.after, item.current.line); item.after = null; }
    catch (rollbackError) { console.error('[pi-web projects] header rollback failed; journal:', journal, rollbackError); }
  }
}
/** Rewrite the header of every prepared change in turn; if one fails the ones already written are put back. */
export async function commitSessionHeaders(changes, journal) {
  try { for (const item of changes) item.after = await writeHeaderLine(item.file, item.current, item.next); }
  catch (error) { await restoreSessionHeaders(changes, journal); throw error; }
}
export async function relocateSessionHeaders(sessions, cwd, sessionRoot) {
  const changes = sessions.map(s => prepareSessionHeader(s.path, s.id, typeof cwd === 'function' ? cwd(s) : cwd, sessionRoot)).filter(p => p.changed);
  const journal = changes.length ? writeHeaderJournal(sessionRoot, changes) : null;
  await commitSessionHeaders(changes, journal);
  return { changed: changes.length > 0, ...(typeof cwd === 'function' ? {} : { cwd: directoryPath(cwd) }), backups: journal ? [journal] : [] };
}
export function relocateSessionHeader(file, id, cwd, sessionRoot) {
  return relocateSessionHeaders([{ path: file, id }], cwd, sessionRoot);
}

// Shared across Next route bundles; never let prompt/start race with a move.
const lockKey = Symbol.for('pi-web.project-moves');
const moving = () => globalThis[lockKey] ??= new Set();
export function assertSessionNotMoving(id) {
  if (moving().has(id)) throw new Error('会话正在移动，请稍后重试');
}
export async function withSessionMoveLock(ids, operation) {
  ids.forEach(assertSessionNotMoving);
  ids.forEach(id => moving().add(id));
  try { return await operation(); }
  finally { ids.forEach(id => moving().delete(id)); }
}
