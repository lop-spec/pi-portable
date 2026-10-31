// Source integration and config-store contract, no browser or provider access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { integrateSingleWatermark } from '../tools/patch-piweb-single-watermark.mjs';
const upstream = process.env.PIWEB_TEST_SOURCE || path.resolve(import.meta.dirname, '../upstream');
const overlay = path.resolve(import.meta.dirname, '../assets/piweb-overlay/redesign/files');
const names = ['components/ModelsConfig.tsx', 'lib/model-catalog.ts', 'lib/models-config-store.ts', 'components/AppShell.tsx', 'lib/rpc-manager.ts', 'lib/subagent-runtime.ts'];
const stateFile = path.join(upstream, '.pi-portable-overlay.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const readBase = name => {
  const record = state?.files?.[name];
  if (record && !record.backup) throw Error(`Not present in upstream: ${name}`);
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  if (record && hash(fs.readFileSync(path.join(upstream, name))) !== record.patchedSha) throw Error(`Integrated source drift: ${name}`);
  const content = fs.readFileSync(record?.backup || path.join(upstream, name), 'utf8');
  if (record && hash(content) !== record.baseSha) throw Error(`Upstream backup drift: ${name}`);
  return content;
};
const files = new Map(names.map(n => [n, (n === 'components/AppShell.tsx' ? fs.readFileSync(path.join(overlay, n), 'utf8') : readBase(n)).replaceAll('\r\n', '\n')]));
const change = (name, before, after, count = 1) => {
  const source = files.get(name); assert.equal(source.split(before).length - 1, count, `${name}: anchor`);
  files.set(name, source.replaceAll(before, after));
};
integrateSingleWatermark({ change });
assert.doesNotMatch(files.get(names[0]), /contextWindow/);
assert.doesNotMatch(files.get(names[1]), /contextWindow/);
assert.match(files.get(names[2]), /stripContextWindows\(data\)/);
assert.match(files.get(names[3]), /contextUsage\?\.tokens != null \? formatCompact\(contextUsage\.tokens\)/);
assert.doesNotMatch(files.get(names[3]), /pw-tb-usage-meter|usageContextTooltip|usageContextPending/);
assert.equal((files.get(names[4]).match(/additionalExtensionPaths: \[resolve\(agentDir, "extensions\/lop-async-compaction\/compaction-only\.ts"\)\]/g) || []).length, 2);
assert.match(files.get(names[5]), /noExtensions: !profile\.loadExtensions,[\s\S]*?!profile\.loadExtensions \? \{ additionalExtensionPaths:/);
const ts = createRequire(path.join(upstream, 'package.json'))('typescript');
for (const [name, source] of files) {
  const result = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true, fileName: name });
  const errors = (result.diagnostics || []).filter(x => x.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(x => ts.flattenDiagnosticMessageText(x.messageText, '\n')), [], `${name}: TS syntax`);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-store-'));
try {
  fs.writeFileSync(path.join(tmp, 'store.ts'), files.get('lib/models-config-store.ts'));
  fs.writeFileSync(path.join(tmp, 'atomic-file.ts'), `import fs from 'node:fs'; export function writePrivateFileAtomicSync(p: string, s: string) { fs.writeFileSync(p,s); }`);
  fs.writeFileSync(path.join(tmp, 'models-cache.ts'), 'export function invalidateModelsCache() {}');
  const sdk = process.env.PI_TEST_HOST;
  assert.ok(sdk, 'PI_TEST_HOST must point to the tested SDK');
  const { createJiti } = createRequire(path.join(sdk, 'package.json'))('jiti');
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { '@earendil-works/pi-coding-agent': path.join(sdk, 'dist/index.js') } });
  const store = await jiti.import(path.join(tmp, 'store.ts'));
  const dest = path.join(tmp, 'models.json');
  const source = { providers: { example: { baseUrl: 'https://example.invalid', contextWindow: 1, models: [{ id: 'one', contextWindow: 272000, maxTokens: 128000, input: ['text'] }], modelOverrides: { one: { contextWindow: 1050000, reasoning: true } } } }, extra: 'unchanged' };
  store.writeModelsConfig(source, dest);
  const out = JSON.parse(fs.readFileSync(dest));
  assert.deepEqual(out, { providers: { example: { baseUrl: 'https://example.invalid', models: [{ id: 'one', maxTokens: 128000, input: ['text'] }], modelOverrides: { one: { reasoning: true } } } }, extra: 'unchanged' });
  assert.equal(source.providers.example.models[0].contextWindow, 272000, 'input object remains unchanged');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log('PASS: model UI, token-only stats, stale-client sanitization, chat-only loading and TS syntax');
