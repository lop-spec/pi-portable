import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSdk, patchInstalledPrompt } from '../tools/patch-pi-native-policy.mjs';
import { patchInstalledSingleWatermark, transformations } from '../tools/patch-pi-single-watermark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [appArg, assetArg, backupArg] = process.argv.slice(2);
assert.ok(appArg && assetArg && backupArg, 'Usage: node single-watermark-asset.mjs <staged-app> <asset-dir> <backup-dir>');
const app = fs.realpathSync(appArg), asset = fs.realpathSync(assetArg), backups = fs.realpathSync(backupArg);
const sdk = resolveSdk(path.join(app, 'node_modules/@agegr/pi-web'));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(asset, 'manifest.json'), 'utf8'));
assert.equal(manifest.schema, 1);
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
if (process.env.GITHUB_SHA) assert.equal(manifest.commit, process.env.GITHUB_SHA);
assert.equal(manifest.nativePrompt, 'required');
assert.equal(manifest.sdkVersion, JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version);
assert.equal(patchInstalledPrompt(sdk, { check: true }).status, 'already-patched');
assert.equal(patchInstalledSingleWatermark(sdk, { check: true }).status, 'already-patched');
assert.ok(Array.isArray(manifest.files));
const byName = new Map();
for (const entry of manifest.files) {
  assert.match(entry.path, /^(sdk|async-compaction|codex-imagegen)\/[A-Za-z0-9._/@-]+(?:\/[A-Za-z0-9._@-]+)*$/);
  assert.ok(!entry.path.split('/').includes('..') && !byName.has(entry.path), `unsafe or duplicate path: ${entry.path}`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  const file = path.join(asset, ...entry.path.split('/'));
  assert.ok(fs.lstatSync(file).isFile());
  assert.equal(fs.statSync(file).size, entry.bytes, `asset size: ${entry.path}`);
  assert.equal(digest(file), entry.sha256, `asset digest: ${entry.path}`);
  byName.set(entry.path, entry);
}
const expected = new Set();
for (const { file } of transformations(sdk)) {
  const relative = path.relative(sdk, file).split(path.sep).join('/');
  const name = `sdk/${relative}`, entry = byName.get(name);
  assert.ok(entry, `missing SDK target: ${name}`);
  assert.equal(digest(file), entry.sha256, `staged SDK differs: ${name}`);
  assert.match(entry.beforeSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(entry.sha256, entry.beforeSha256, `SDK target did not change: ${name}`);
  const dir = path.join(backups, path.dirname(relative), '_历史版本');
  const original = path.basename(relative);
  const copies = fs.readdirSync(dir).filter(item => item.startsWith(`${original}.bak-`));
  assert.ok(copies.some(item => {
    const candidate = path.join(dir, item);
    return fs.statSync(candidate).size === entry.beforeBytes && digest(candidate) === entry.beforeSha256;
  }), `verified before-image backup missing: ${name}`);
  assert.ok(!fs.existsSync(path.join(path.dirname(file), '_历史版本')), `backup leaked into staged SDK: ${name}`);
  expected.add(name);
}
const extension = path.join(root, 'assets/pi-async-compaction');
const integrity = JSON.parse(fs.readFileSync(path.join(extension, 'upstream-integrity.json'), 'utf8'));
const names = ['index.ts', 'compaction-only.ts', 'cached-summary.ts', 'reasoning-context.ts', 'config.json', 'package.json', 'README.md', 'upstream-integrity.json', ...Object.keys(integrity.sha256).map(name => `upstream/${name}`)];
for (const name of names) {
  const key = `async-compaction/${name}`, entry = byName.get(key);
  assert.ok(entry, `missing extension file: ${key}`);
  assert.equal(entry.sha256, digest(path.join(extension, ...name.split('/'))), `extension source mismatch: ${key}`);
  expected.add(key);
}
for (const [name, hash] of Object.entries(integrity.sha256)) assert.equal(byName.get(`async-compaction/upstream/${name}`).sha256, hash, `upstream integrity mismatch: ${name}`);
const config = JSON.parse(fs.readFileSync(path.join(asset, 'async-compaction/config.json'), 'utf8'));
assert.equal(config.startTokens, 800000);
assert.equal(config.thinkingMode, 'request');
for (const name of ['index.ts', 'LICENSE.txt']) {
  const key = `codex-imagegen/${name}`, entry = byName.get(key);
  assert.ok(entry, `missing plugin file: ${key}`);
  assert.equal(entry.sha256, digest(path.join(root, 'assets/codex-imagegen', name)), `plugin source mismatch: ${key}`);
  expected.add(key);
}
assert.deepEqual([...byName.keys()].sort(), [...expected].sort(), 'asset manifest contains unexpected or missing entries');
const found = [];
function walk(dir, prefix = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    assert.ok(item.name !== '_历史版本' && !item.name.includes('.bak-'), `backup in asset: ${rel}`);
    if (item.isDirectory()) walk(path.join(dir, item.name), rel);
    else { assert.ok(item.isFile(), `non-regular asset: ${rel}`); found.push(rel); }
  }
}
walk(asset);
assert.deepEqual(found.sort(), [...expected, 'manifest.json'].sort(), 'asset contains unexpected or unlisted files');
console.log(JSON.stringify({ pass: true, commit: manifest.commit, sdkFiles: transformations(sdk).length, extensionFiles: names.length, pluginFiles: 2, beforeImagesVerified: true, noBackupsInAsset: true }));
