import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, backupFile, commitSessionHeaders, directoryPath, prepareSessionHeader, projectKey, restoreSessionHeaders, writeHeaderJournal } from './portable-project-store.mjs';
import { pathWithin, validateProjectDeletion } from './portable-context-store.mjs';

export function projectLeafTarget(root, name) {
  root = directoryPath(root);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name) || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) throw new Error('请输入有效的末级文件夹名称（不能包含路径分隔符、保留名称或末尾空格/点）');
  return path.join(path.dirname(root), name.trim());
}

// The route holds both project locks and every affected session lock. No copy,
// deletion or history relocation: folder rename + native cwd headers only, and a header is
// rewritten without reading the history behind it (see portable-project-store.mjs).
export function renamePhysicalProject(options) { return changeProjectRoot(options); }
export function relocateCopiedProject(options) { return changeProjectRoot({ ...options, copyOnly: true }); }
async function changeProjectRoot({ root, name, registry, sessions, sessionRoot, knownRoots, protectedRoots = [], copyOnly = false, target: copiedTarget }) {
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
  // Every backup and every preflight completes before changing the directory. A session's backup
  // is the journal of its original header lines: the header is the only thing that changes.
  const registryBackup = originalRegistry ? backupFile(registry.file) : null;
  const journal = prepared.length ? writeHeaderJournal(sessionRoot, prepared) : null;
  let renamed = false;
  try {
    if (!copyOnly) { fs.renameSync(root, target); renamed = true; }
    await commitSessionHeaders(prepared, journal);
    const data = registry.rebase(root, target, path.basename(target));
    if (!fs.statSync(target).isDirectory()) throw new Error('重命名目录读回失败');
    console.info('[pi-web projects]', copyOnly ? 'relocated to verified copy' : 'physical rename', root, target, 'sessions=' + prepared.length);
    return { ...data, cwd: target, previousRoot: root, changed: true, sessionIds: affected.map(s => s.id), backups: [registryBackup, journal].filter(Boolean), preserved: true };
  } catch (error) {
    await restoreSessionHeaders(prepared, journal);
    if (originalRegistry) { try { atomicWrite(registry.file, originalRegistry); } catch (e) { console.error('[pi-web projects] registry rollback failed', registryBackup, e); } }
    if (renamed) { try { fs.renameSync(target, root); } catch (e) { console.error('[pi-web projects] directory rollback failed', { root, target }, e); } }
    throw error;
  }
}
