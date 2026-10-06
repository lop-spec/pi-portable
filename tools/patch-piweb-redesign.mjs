// Source integration: front-end rewrite (lop 2026-10-06「重写前端页面，尤其是左侧项目管理和对话过程摘要输出
// 不够美观易读」). The rewritten components replace whole files, so they ship as templates under
// assets/piweb-overlay/redesign/ and are applied last. Every template pins the sha256 of the file it was
// derived from (the output of the upstream ref plus all earlier overlay steps); a mismatch means upstream
// or an earlier step changed underneath, and integration refuses with zero writes instead of silently
// discarding that change. New files pin null and must not exist upstream.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REDESIGN_ROOT = fileURLToPath(new URL('../assets/piweb-overlay/redesign/', import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => value.replaceAll('\r\n', '\n');

export function readRedesignManifest(root = REDESIGN_ROOT) {
  const file = path.join(root, 'manifest.json');
  if (!fs.existsSync(file)) return { files: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {{ get: (name: string) => string, set: (name: string, value: string) => void }} api */
export function integrateRedesign({ get, set }, root = REDESIGN_ROOT) {
  const manifest = readRedesignManifest(root);
  /** @type {string[]} */
  const applied = [];
  for (const [name, entry] of Object.entries(manifest.files || {})) {
    let current = null;
    try { current = get(name); } catch (error) { if (entry.baseSha) throw new Error(`${name}: redesign base missing (${error instanceof Error ? error.message : String(error)}); zero writes`); }
    if (entry.baseSha === null && current !== null) throw new Error(`${name}: redesign adds this file but upstream already has it; zero writes`);
    if (entry.baseSha && sha(normalize(current ?? '')) !== entry.baseSha) throw new Error(`${name}: upstream/overlay changed under the redesign template (expected base ${entry.baseSha.slice(0, 12)}); re-merge before integrating; zero writes`);
    const file = path.join(root, 'files', name);
    if (!fs.existsSync(file)) throw new Error(`${name}: redesign template missing; zero writes`);
    const next = normalize(fs.readFileSync(file, 'utf8'));
    if (sha(next) !== entry.sha) throw new Error(`${name}: redesign template hash mismatch; zero writes`);
    set(name, next);
    applied.push(name);
  }
  return applied;
}
