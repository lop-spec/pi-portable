import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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

// Keep the file path stable: archive records, forks, lazy media and bookmarks
// refer to it. Only the native cwd header changes; all history bytes stay exact.
export function prepareSessionHeader(file, id, cwd, sessionRoot, validateDirectory = true) {
  cwd = directoryPath(cwd);
  if (validateDirectory && !fs.statSync(cwd).isDirectory()) throw new Error('目标路径不是文件夹');
  const realFile = fs.realpathSync(file), realRoot = fs.realpathSync(sessionRoot);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(realFile) !== '.jsonl') throw new Error('会话文件不在受管目录内');
  const original = fs.readFileSync(realFile), end = original.indexOf(10);
  if (end < 0 || end > 65536) throw new Error('会话头无效');
  const header = JSON.parse(original.subarray(0, end).toString('utf8'));
  if (header.type !== 'session' || header.id !== id) throw new Error('会话身份不匹配');
  if (projectKey(header.cwd) === projectKey(cwd)) return { changed: false, cwd };
  const next = Buffer.concat([Buffer.from(JSON.stringify({ ...header, cwd }) + (original[end - 1] === 13 ? '\r\n' : '\n')), original.subarray(end + 1)]);
  return { changed: true, cwd, file: realFile, original, next };
}
export function relocateSessionHeaders(sessions, cwd, sessionRoot) {
  const prepared = sessions.map(s => prepareSessionHeader(s.path, s.id, typeof cwd === 'function' ? cwd(s) : cwd, sessionRoot));
  const changes = prepared.filter(p => p.changed);
  for (const item of changes) item.backup = backupFile(item.file);
  const committed = [];
  try {
    for (const item of changes) {
      if (!fs.readFileSync(item.file).equals(item.original)) throw new Error('会话被其他进程修改，请停止后再移动');
      atomicWrite(item.file, item.next);
      committed.push(item);
      if (!fs.readFileSync(item.file).equals(item.next)) throw new Error('会话移动读回失败；备份：' + item.backup);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      try {
        if (!fs.readFileSync(item.file).equals(item.next)) throw new Error('文件被其他进程修改，保留备份待恢复');
        atomicWrite(item.file, item.original);
      } catch (rollbackError) { console.error('[pi-web projects] rollback failed; backup:', item.backup, rollbackError); }
    }
    throw error;
  }
  return { changed: changes.length > 0, ...(typeof cwd === 'function' ? {} : { cwd: directoryPath(cwd) }), backups: changes.map(p => p.backup) };
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
