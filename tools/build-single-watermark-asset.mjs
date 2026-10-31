// Prepare a CI-only update asset from the SDK installed in the staged app.
// Never point this tool at an installed app: it patches the supplied staging tree.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchInstalledPrompt, resolveSdk } from './patch-pi-native-policy.mjs';
import { patchInstalledSingleWatermark, transformations } from './patch-pi-single-watermark.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [stageArg, outArg, backupsArg] = process.argv.slice(2);
assert.ok(stageArg && outArg && backupsArg, 'Usage: node build-single-watermark-asset.mjs <staged-app> <new-asset-dir> <new-backup-dir>');
assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'CI commit SHA is required');
const stage = fs.realpathSync(stageArg), out = path.resolve(outArg), backups = path.resolve(backupsArg);
const within = (root, child) => {
  const relative = path.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
assert.ok(!within(stage, out) && !within(stage, backups) && out !== stage && backups !== stage && out !== backups && !within(out, backups) && !within(backups, out), 'asset and backup must be outside the staged app and separate');
assert.ok(!fs.existsSync(out) && !fs.existsSync(backups), 'asset and backup directories must be new');
const web = path.join(stage, 'node_modules/@agegr/pi-web');
assert.ok(fs.existsSync(path.join(web, 'package.json')), 'staged Pi Web missing');
const sdk = resolveSdk(web);
assert.ok(within(stage, sdk), 'SDK must be physically inside the staged app');
const version = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version;
assert.ok(typeof version === 'string' && version, 'SDK version missing');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const safeRelative = (root, file) => {
  const rel = path.relative(root, file);
  assert.ok(within(root, file) && within(root, fs.realpathSync(file)), `File escapes staging root: ${rel}`);
  return rel.split(path.sep).join('/');
};
const targets = transformations(sdk).map(({ file }) => ({ file, relative: safeRelative(sdk, file) }));
assert.equal(new Set(targets.map(x => x.relative)).size, targets.length, 'duplicate SDK patch targets');
// Backup helper selects the nearest history directory. Create one per affected
// directory so backup filenames cannot collide, then move them outside stage.
const prompt = path.join(sdk, 'dist/core/system-prompt.js');
safeRelative(sdk, prompt);
const historyDirs = [...new Set([...targets.map(x => path.dirname(x.file)), path.dirname(prompt)])]
  .map(dir => path.join(dir, '_历史版本'));
for (const dir of historyDirs) assert.ok(!fs.existsSync(dir), `unexpected existing CI backup directory: ${dir}`);
for (const dir of historyDirs) fs.mkdirSync(dir);
const promptPatch = patchInstalledPrompt(sdk);
assert.equal(patchInstalledPrompt(sdk, { check: true }).status, 'already-patched', 'native prompt patch not applied');
assert.equal(patchInstalledSingleWatermark(sdk, { check: true }).status, 'pending', 'expected a fresh SDK before the watermark patch');
for (const item of targets) { item.beforeSha256 = sha(item.file); item.beforeBytes = fs.statSync(item.file).size; }
const patch = patchInstalledSingleWatermark(sdk);
assert.equal(patch.status, 'patched');
assert.equal(patch.changed, targets.length);
assert.equal(patchInstalledSingleWatermark(sdk, { check: true }).status, 'already-patched');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(backups, { recursive: true });
const files = [];
function addFile(source, relative, extra = {}) {
  assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'), `unsafe asset path: ${relative}`);
  const destination = path.join(out, ...relative.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const digest = sha(source);
  assert.equal(sha(destination), digest, `asset readback mismatch: ${relative}`);
  files.push({ path: relative, bytes: fs.statSync(source).size, sha256: digest, ...extra });
}
for (const item of targets) {
  addFile(item.file, `sdk/${item.relative}`, { beforeSha256: item.beforeSha256, beforeBytes: item.beforeBytes });
}
const extension = path.join(repo, 'assets/pi-async-compaction');
const integrity = JSON.parse(fs.readFileSync(path.join(extension, 'upstream-integrity.json'), 'utf8'));
const names = ['index.ts', 'compaction-only.ts', 'cached-summary.ts', 'reasoning-context.ts', 'config.json', 'package.json', 'README.md', 'upstream-integrity.json', ...Object.keys(integrity.sha256).map(name => `upstream/${name}`)];
assert.equal(new Set(names).size, names.length, 'duplicate extension files');
for (const [name, expected] of Object.entries(integrity.sha256)) {
  assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
  assert.equal(sha(path.join(extension, 'upstream', ...name.split('/'))), expected, `unreviewed extension source: ${name}`);
}
for (const name of names) addFile(path.join(extension, ...name.split('/')), `async-compaction/${name}`);
for (const name of ['index.ts', 'LICENSE.txt']) addFile(path.join(repo, 'assets/codex-imagegen', name), `codex-imagegen/${name}`);
for (const dir of historyDirs) {
  const relative = path.relative(sdk, dir);
  const destination = path.join(backups, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(dir, destination);
  assert.ok(!fs.existsSync(dir) && fs.existsSync(destination), `backup relocation failed: ${relative}`);
}
const manifest = { schema: 1, commit: process.env.GITHUB_SHA, sdkVersion: version, nativePrompt: 'required', nativePromptPatchedInStage: promptPatch.status, files };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'staged', commit: manifest.commit, sdkVersion: version, sdkTargets: targets.length, extensionFiles: names.length, pluginFiles: 2, asset: out, backups, nativePrompt: promptPatch.status }));
