import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, backupFile, directoryPath, prepareSessionHeader, projectKey } from './portable-project-store.mjs';
import { pathWithin, validateProjectDeletion } from './portable-context-store.mjs';

export function projectLeafTarget(root, name) {
  root = directoryPath(root);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name) || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) throw new Error('请输入有效的末级文件夹名称（不能包含路径分隔符、保留名称或末尾空格/点）');
  return path.join(path.dirname(root), name.trim());
}

// The route holds both project locks and every affected session lock. No copy,
// deletion or history relocation: folder rename + native cwd headers only.
export function renamePhysicalProject(options) { return changeProjectRoot(options); }
export function relocateCopiedProject(options) { return changeProjectRoot({ ...options, copyOnly: true }); }
function changeProjectRoot({ root, name, registry, sessions, sessionRoot, knownRoots, protectedRoots = [], copyOnly = false, target: copiedTarget }) {
  root = directoryPath(root);
  const target = copyOnly ? directoryPath(copiedTarget) : projectLeafTarget(root, name);
  const originalRegistry = fs.existsSync(registry.file) ? fs.readFileSync(registry.file) : null;
  registry.read();
  if (!copyOnly) validateProjectDeletion(root, root, { knownRoots, protectedRoots: [...protectedRoots, sessionRoot, registry.file] });
  else if (!fs.statSync(target).isDirectory() || pathWithin(root, target) || pathWithin(target, root)) throw new Error('复制目标必须为独立的已有目录');
  if (target === root) return { ...registry.rebase(root, target, path.basename(target)), cwd: target, previousRoot: root, changed: false };
  if (!copyOnly && fs.existsSync(target) && projectKey(target) !== projectKey(root)) throw new Error('目标文件夹已存在，未覆盖或合并');
  const affected = sessions.filter(s => pathWithin(root, s.cwd));
  const prepared = affected.map(s => prepareSessionHeader(s.path, s.id, path.join(target, path.relative(root, s.cwd)), sessionRoot, copyOnly)).filter(p => p.changed);
  // Every backup and every preflight completes before changing the directory.
  const registryBackup = originalRegistry ? backupFile(registry.file) : null;
  for (const p of prepared) p.backup = backupFile(p.file);
  for (const p of prepared) if (!fs.readFileSync(p.file).equals(p.original)) throw new Error('会话被其他进程修改，请停止后重试');
  let renamed = false;
  const committed = [];
  try {
    if (!copyOnly) { fs.renameSync(root, target); renamed = true; }
    for (const p of prepared) {
      if (!fs.readFileSync(p.file).equals(p.original)) throw new Error('会话被其他进程修改，停止重命名');
      atomicWrite(p.file, p.next); committed.push(p);
      if (!fs.readFileSync(p.file).equals(p.next)) throw new Error('会话工作目录读回失败');
    }
    const data = registry.rebase(root, target, path.basename(target));
    if (!fs.statSync(target).isDirectory()) throw new Error('重命名目录读回失败');
    console.info('[pi-web projects]', copyOnly ? 'relocated to verified copy' : 'physical rename', root, target, 'sessions=' + prepared.length);
    return { ...data, cwd: target, previousRoot: root, changed: true, sessionIds: affected.map(s => s.id), backups: [registryBackup, ...prepared.map(p => p.backup)].filter(Boolean), preserved: true };
  } catch (error) {
    for (const p of committed.reverse()) {
      try { if (!fs.readFileSync(p.file).equals(p.next)) throw new Error('concurrent write; use backup ' + p.backup); atomicWrite(p.file, p.original); }
      catch (e) { console.error('[pi-web projects] rename session rollback failed', p.backup, e); }
    }
    if (originalRegistry) { try { atomicWrite(registry.file, originalRegistry); } catch (e) { console.error('[pi-web projects] registry rollback failed', registryBackup, e); } }
    if (renamed) { try { fs.renameSync(target, root); } catch (e) { console.error('[pi-web projects] directory rollback failed', { root, target }, e); } }
    throw error;
  }
}
