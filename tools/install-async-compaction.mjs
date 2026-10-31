// Install reviewed source as a native extensions/*/index.ts package, atomically. Does not edit Pi settings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.PI_ASYNC_COMPACTION_SOURCE || path.join(repo, 'assets/pi-async-compaction');
if (!path.isAbsolute(source)) throw Error('Absolute extension source directory required');
const agent = process.argv[2] || process.env.PI_CODING_AGENT_DIR;
if (!agent || !path.isAbsolute(agent)) throw Error('Absolute managed agent directory required');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'upstream-integrity.json'), 'utf8'));
const files = ['index.ts', 'compaction-only.ts', 'cached-summary.ts', 'reasoning-context.ts', 'config.json', 'package.json', 'README.md', 'upstream-integrity.json', ...Object.keys(manifest.sha256).map(f => `upstream/${f}`)];
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for (const [file, patch] of Object.entries(manifest.localPatches || {})) {
  if (!manifest.sha256[file] || !/^[a-f0-9]{64}$/.test(patch.baseSha256 || '') || patch.baseSha256 === manifest.sha256[file] || !patch.reason) throw Error('Invalid local upstream patch declaration: ' + file);
}
for (const [file, hash] of Object.entries(manifest.sha256)) if (sha(path.join(source, 'upstream', file)) !== hash) throw Error('Unreviewed upstream content: ' + file);
const target = path.join(agent, 'extensions/lop-async-compaction');
if (fs.existsSync(target)) {
  for (const file of files) if (!fs.existsSync(path.join(target, file)) || sha(path.join(source, file)) !== sha(path.join(target, file))) throw Error('Existing extension differs; back up and review before an update: ' + file);
  console.log(JSON.stringify({ status: 'already-current', target, files: files.length }));
} else {
  const stage = path.join(agent, 'data', `.async-compaction-install-${process.pid}`);
  if (fs.existsSync(stage)) throw Error('Staging path already exists');
  fs.mkdirSync(stage, { recursive: true });
  for (const file of files) {
    const destination = path.join(stage, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, file), destination);
    if (sha(path.join(source, file)) !== sha(destination)) throw Error('Readback failed: ' + file);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(stage, target);
  console.log(JSON.stringify({ status: 'installed', target, files: files.length, entrySha256: sha(path.join(target, 'index.ts')), config: JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')) }));
}
