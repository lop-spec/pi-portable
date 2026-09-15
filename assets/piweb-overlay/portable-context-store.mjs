import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { directoryPath, projectKey } from './portable-project-store.mjs';

export function pathWithin(root, candidate) {
  const relative = path.relative(projectKey(root), projectKey(candidate));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
const lockKey = Symbol.for('pi-web.project-deletions');
const locks = () => globalThis[lockKey] ??= new Set();
export function assertProjectAvailable(cwd) {
  if (cwd && [...locks()].some(root => pathWithin(root, cwd))) throw new Error('项目正在物理删除，请稍后重试');
}
export async function withProjectDeletionLock(root, operation) {
  root = directoryPath(root);
  if ([...locks()].some(p => pathWithin(p, root) || pathWithin(root, p))) throw new Error('项目正在物理删除');
  locks().add(root);
  try { return await operation(); } finally { locks().delete(root); }
}
export function validateProjectDeletion(root, confirmation, { knownRoots, protectedRoots = [] }) {
  root = directoryPath(root);
  if (confirmation !== root) throw new Error('请确认完整绝对路径后再物理删除');
  if (!knownRoots.some(p => projectKey(p) === projectKey(root))) throw new Error('只能删除已知项目，拒绝任意路径');
  const protectedPaths = [path.parse(root).root, os.homedir(), process.cwd(), path.dirname(process.execPath), ...protectedRoots];
  if (protectedPaths.some(p => pathWithin(root, p))) throw new Error('拒绝删除磁盘根、用户主目录或 Pi 运行/数据目录及其上级目录');
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || projectKey(fs.realpathSync(root)) !== projectKey(root)) throw new Error('拒绝删除符号链接、联接点或非目录项目');
  const git = path.join(root, '.git');
  if (fs.existsSync(git) && !fs.lstatSync(git).isDirectory()) throw new Error('这是关联 worktree，请通过 worktree 管理移除');
  const linked = path.join(git, 'worktrees');
  if (fs.existsSync(linked) && fs.readdirSync(linked).length) throw new Error('项目仍有关联 worktree，请先移除关联 worktree');
  return root;
}
export async function deleteProjectDirectory(root, confirmation, options) {
  const target = validateProjectDeletion(root, confirmation, options);
  // Explicitly confirmed physical deletion only. Node rm does not follow child symlinks.
  await fs.promises.rm(target, { recursive: true, force: false, maxRetries: 0 });
  if (fs.existsSync(target)) throw new Error('目录删除未完成：' + target);
  return target;
}
export function deleteSessionFiles(sessions, sessionRoot, confirmation, id) {
  if (confirmation !== id) throw new Error('缺少对话物理删除确认');
  const realRoot = fs.realpathSync(sessionRoot);
  const files = sessions.map(s => {
    const file = directoryPath(s.path);
    if (fs.lstatSync(file).isSymbolicLink() || !pathWithin(realRoot, fs.realpathSync(file)) || path.extname(file) !== '.jsonl') throw new Error('拒绝删除受管目录外的会话');
    const fd = fs.openSync(file, 'r');
    let first;
    try { const b = Buffer.alloc(65537); const n = fs.readSync(fd, b); const end = b.subarray(0, n).indexOf(10); if (end < 0) throw new Error('会话头无效'); first = JSON.parse(b.subarray(0, end).toString()); }
    finally { fs.closeSync(fd); }
    if (first.type !== 'session' || first.id !== s.id) throw new Error('会话身份不匹配');
    return file;
  });
  // Full allowlist and identity validation before the first unlink.
  const deleted = [];
  try { for (const file of files) { fs.unlinkSync(file); deleted.push(file); } }
  catch (error) { console.error('[pi-web physical-delete] partial deletion', { deleted, error: String(error) }); throw new Error('删除未全部完成；已删除 ' + deleted.length + ' 个文件：' + String(error)); }
  return deleted;
}
