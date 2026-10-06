#!/usr/bin/env node
// Exports the rewritten front-end from an integrated dev checkout into redesign templates.
// node tools/export-piweb-redesign.mjs --source <dev checkout> --base <commit with the overlay applied, before the rewrite>
// Every file changed between --base and the working tree (minus dev-only files) becomes a template;
// its pinned base is the --base content, i.e. what integrate() produces before integrateRedesign().
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REDESIGN_ROOT } from './patch-piweb-redesign.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const source = path.resolve(arg('--source') || '');
const base = arg('--base');
if (!source || !base) throw new Error('usage: export-piweb-redesign.mjs --source <dev checkout> --base <commit>');
const DEV_ONLY = [/^tsconfig\.json$/, /^\.next/, /(^|\/)_历史版本\//, /\.bak-/, /^\.pi-portable-overlay\.json$/, /^next-env\.d\.ts$/, /^tsconfig\.tsbuildinfo$/];
// Dev-checkout scaffolding that must never ship: the preview-build distDir switch in next.config.ts.
const DEV_SWITCH = /\n {2}\/\/ dev-only \(redesign preview builds\)[^\n]*\n {2}\.\.\.\(process\.env\.PI_NEXT_DIST_DIR[^\n]*/u;
const stripDevOnly = (name, content) => name === 'next.config.ts' ? content.replace(DEV_SWITCH, '') : content;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => value.replaceAll('\r\n', '\n');
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20 });

const changed = git('diff', '--name-status', '--no-renames', base, '--').trim().split('\n').filter(Boolean)
  .concat(git('ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean).map(name => `A\t${name}`))
  .map(line => { const [status, name] = line.split('\t'); return { status, name: name.replaceAll('\\', '/') }; })
  .filter(({ name }) => !DEV_ONLY.some(rule => rule.test(name)));
const deleted = changed.filter(item => item.status === 'D');
if (deleted.length) throw new Error(`deleting upstream files is not supported by the redesign overlay: ${deleted.map(item => item.name).join(', ')}`);

fs.rmSync(path.join(REDESIGN_ROOT, 'files'), { recursive: true, force: true });
const files = {};
for (const { status, name } of changed.sort((a, b) => a.name.localeCompare(b.name))) {
  const content = stripDevOnly(name, normalize(fs.readFileSync(path.join(source, name), 'utf8')));
  if (content.includes('PI_NEXT_DIST_DIR')) throw new Error(`${name}: dev-only preview switch survived stripping`);
  let baseSha = null;
  if (status !== 'A') baseSha = sha(normalize(git('show', `${base}:${name}`)));
  const out = path.join(REDESIGN_ROOT, 'files', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);
  files[name] = { baseSha, sha: sha(content) };
}
fs.writeFileSync(path.join(REDESIGN_ROOT, 'manifest.json'), JSON.stringify({ base, files }, null, 2) + '\n');
console.log(JSON.stringify({ exported: Object.keys(files).length, added: Object.values(files).filter(f => !f.baseSha).length }));
