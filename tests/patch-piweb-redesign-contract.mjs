import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { integrateRedesign, readRedesignManifest, REDESIGN_ROOT } from '../tools/patch-piweb-redesign.mjs';

// Mechanism contract of the front-end rewrite templates (tools/patch-piweb-redesign.mjs): every template pins the
// sha256 of the file it was derived from and of itself; any drift refuses integration with zero writes.
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const repo = fileURLToPath(new URL('../', import.meta.url));

/** A throw-away template root with one modified file, one new file and its manifest. */
function fixture(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-contract-'));
  const base = { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' };
  const templates = { 'a.ts': 'export const a = 2;\n', 'c/new.ts': 'export const c = 3;\n' };
  const manifest = {
    base: 'fixture',
    files: {
      'a.ts': { baseSha: sha(base['a.ts']), sha: sha(templates['a.ts']) },
      'c/new.ts': { baseSha: null, sha: sha(templates['c/new.ts']) },
    },
  };
  const ctx = { root, base, templates, manifest };
  mutate(ctx);
  for (const [name, text] of Object.entries(ctx.templates)) {
    const file = path.join(root, 'files', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(ctx.manifest, null, 2));
  return ctx;
}

/** An in-memory upstream that records every write. */
function memory(initial) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  return {
    files,
    writes,
    api: {
      get: name => { if (!files.has(name)) throw new Error(`${name} not found`); return files.get(name); },
      set: (name, value) => { writes.push(name); files.set(name, value); },
    },
  };
}

test('applies the pinned templates over their pinned bases and adds new files', () => {
  const { root, base, templates } = fixture();
  const mem = memory(base);
  assert.deepEqual(integrateRedesign(mem.api, root), ['a.ts', 'c/new.ts']);
  assert.equal(mem.files.get('a.ts'), templates['a.ts']);
  assert.equal(mem.files.get('c/new.ts'), templates['c/new.ts']);
  assert.equal(mem.files.get('b.ts'), base['b.ts'], 'files outside the manifest are untouched');
});

test('CRLF checkouts are compared and written as LF', () => {
  const { root, base, templates } = fixture();
  const mem = memory({ ...base, 'a.ts': base['a.ts'].replaceAll('\n', '\r\n') });
  integrateRedesign(mem.api, root);
  assert.equal(mem.files.get('a.ts'), templates['a.ts']);
});

test('a changed base (upstream or an earlier overlay step) throws and writes nothing', () => {
  const { root, base } = fixture();
  const mem = memory({ ...base, 'a.ts': base['a.ts'] + '// drifted\n' });
  assert.throws(() => integrateRedesign(mem.api, root), /a\.ts: upstream\/overlay changed under the redesign template.*zero writes/);
  assert.deepEqual(mem.writes, []);
});

test('a failure on a later file still leaves earlier files unwritten', () => {
  // Order matters: a.ts validates fine, the manifest's second entry is the broken one.
  const { root, base } = fixture(ctx => {
    ctx.base['b.ts'] = 'export const b = 1;\n';
    ctx.templates['b.ts'] = 'export const b = 9;\n';
    ctx.manifest.files['b.ts'] = { baseSha: sha('export const b = 1;\n'), sha: sha(ctx.templates['b.ts']) };
  });
  const mem = memory({ ...base, 'b.ts': 'export const b = 0;\n' });
  assert.throws(() => integrateRedesign(mem.api, root), /b\.ts: upstream\/overlay changed/);
  assert.deepEqual(mem.writes, [], 'a.ts must not be written before b.ts has been validated');
  assert.equal(mem.files.get('a.ts'), base['a.ts']);
});

test('a base file that does not exist throws and writes nothing', () => {
  const { root } = fixture();
  const mem = memory({ 'b.ts': 'x' });
  assert.throws(() => integrateRedesign(mem.api, root), /a\.ts: redesign base missing.*zero writes/);
  assert.deepEqual(mem.writes, []);
});

test('a missing template throws and writes nothing', () => {
  const { root, base } = fixture();
  fs.rmSync(path.join(root, 'files', 'c/new.ts'));
  const mem = memory(base);
  assert.throws(() => integrateRedesign(mem.api, root), /c\/new\.ts: redesign template missing.*zero writes/);
  assert.deepEqual(mem.writes, []);
});

test('a template whose hash differs from the manifest throws and writes nothing', () => {
  const { root, base } = fixture();
  fs.appendFileSync(path.join(root, 'files', 'a.ts'), '// edited after export\n');
  const mem = memory(base);
  assert.throws(() => integrateRedesign(mem.api, root), /a\.ts: redesign template hash mismatch.*zero writes/);
  assert.deepEqual(mem.writes, []);
});

test('a new file (baseSha null) meeting an existing upstream file of the same name throws and writes nothing', () => {
  const { root, base } = fixture();
  const mem = memory({ ...base, 'c/new.ts': 'export const upstream = true;\n' });
  assert.throws(() => integrateRedesign(mem.api, root), /c\/new\.ts: redesign adds this file but upstream already has it.*zero writes/);
  assert.deepEqual(mem.writes, []);
  assert.equal(mem.files.get('c/new.ts'), 'export const upstream = true;\n');
});

test('a template root without a manifest is a no-op', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-empty-'));
  const mem = memory({ 'a.ts': 'x' });
  assert.deepEqual(integrateRedesign(mem.api, root), []);
  assert.deepEqual(mem.writes, []);
});

test('the committed manifest pins its base commit and every template by sha256', () => {
  const manifest = readRedesignManifest();
  assert.match(manifest.base, /^[a-f0-9]{7,40}$/);
  const names = Object.keys(manifest.files);
  assert.ok(names.length > 0, 'the rewrite ships at least one template');
  for (const name of names) {
    const entry = manifest.files[name];
    assert.match(entry.sha, /^[a-f0-9]{64}$/, name);
    assert.ok(entry.baseSha === null || /^[a-f0-9]{64}$/.test(entry.baseSha), `${name}: baseSha is null (new file) or a sha256`);
    const file = path.join(REDESIGN_ROOT, 'files', name);
    assert.ok(fs.existsSync(file), `${name}: template exists`);
    assert.equal(sha(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')), entry.sha, `${name}: template matches its pinned hash`);
  }
  const onDisk = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) item.isDirectory() ? walk(path.join(dir, item.name)) : onDisk.push(path.relative(path.join(REDESIGN_ROOT, 'files'), path.join(dir, item.name)).replaceAll('\\', '/')); };
  walk(path.join(REDESIGN_ROOT, 'files'));
  assert.deepEqual(onDisk.sort(), [...names].sort(), 'no template is shipped without a manifest entry, and vice versa');
});

// Against the pinned official checkout (CI: upstream/): the whole integration, base drift and idempotence.
const source = [process.env.PIWEB_SOURCE, path.join(repo, 'upstream'), path.join(repo, '../scratch/pi-web-upstream-main')].find(dir => dir && fs.existsSync(path.join(dir, 'components/ChatInput.tsx')));
const skip = !source && 'official source checkout required (PIWEB_SOURCE)';
const stateFile = source && path.join(source, '.pi-portable-overlay.json');
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const read = name => fs.readFileSync(state?.files[name]?.backup || path.join(source, name), 'utf8');

test('integrate() twice gives byte-identical results, and every manifest file ends as its template', { skip }, () => {
  const first = integrate(read);
  const second = integrate(read);
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  for (const [name, value] of first) assert.equal(second.get(name), value, `${name} differs between two runs`);
  for (const [name, entry] of Object.entries(readRedesignManifest().files)) assert.equal(sha(first.get(name)), entry.sha, `${name} is the pinned template`);
});

test('integrate() refuses a drifted base of a templated file with zero writes', { skip }, () => {
  const [name] = Object.entries(readRedesignManifest().files).find(([, entry]) => entry.baseSha) ?? [];
  assert.ok(name, 'at least one template replaces an existing file');
  // The base of a template is the output of every earlier overlay step, so an upstream change in this file (or in
  // the anchors an earlier step edits) must surface as a refusal, never as a silently discarded change.
  const drifted = file => file === name ? read(file) + '\n// upstream drift\n' : read(file);
  assert.throws(() => integrate(drifted), error => error instanceof Error && /zero writes/.test(error.message));
});
