import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { DEFAULT_PRIMARY_MODELS, modelMenuKey, normalizeModelMenu, placeSidePanel, splitModelMenu, togglePrimaryModel } from '../assets/piweb-overlay/portable-model-menu.mjs';

const option = (provider, modelId, name = modelId) => ({ provider, modelId, name });
const catalogue = [
  option('openai-codex', 'gpt-5.6-sol', 'GPT-5.6 Sol'),
  option('pi-chatgpt-web', 'chatgpt-web-instant', 'GPT-5.6 Sol · 网页'),
  option('openai-codex', 'gpt-5.6-terra', 'GPT-5.6 Terra'),
  option('openai-codex', 'gpt-6-astra', 'GPT-6 Astra'),
  option('pi-chatgpt-web', 'chatgpt-web-astra', 'GPT-6 Astra · 网页 Pro'),
  option('openai-codex', 'gpt-6-luna', 'GPT-6 Luna'),
  option('openai-codex', 'gpt-6-sol', 'GPT-6 Sol'),
  option('pi-qwen-web', 'qwen-web-max', 'Qwen3.8-Max · 网页'),
  option('pi-qwen-web', 'qwen-web-omni-flash', 'Qwen3.8-Omni-Flash · 网页'),
];

test('defaults: GPT-6 Astra, Luna, Sol and the two GPT web models are primary, the rest go under more', () => {
  const menu = normalizeModelMenu(null);
  assert.equal(menu.custom, false);
  const { primary, more, fallback } = splitModelMenu(catalogue, menu.primary);
  assert.equal(fallback, false);
  assert.deepEqual(primary.map(modelMenuKey), [...DEFAULT_PRIMARY_MODELS]);
  assert.deepEqual(more.map(modelMenuKey), ['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra', 'pi-qwen-web/qwen-web-max', 'pi-qwen-web/qwen-web-omni-flash']);
});

test('a stored menu keeps its order, drops duplicates and malformed keys, and rejects a non-list', () => {
  const menu = normalizeModelMenu({ primary: ['pi-qwen-web/qwen-web-max', 'pi-qwen-web/qwen-web-max', 42, 'no-slash', 'x'.repeat(300) + '/y', 'openai-codex/gpt-6-sol'] });
  assert.deepEqual(menu, { primary: ['pi-qwen-web/qwen-web-max', 'openai-codex/gpt-6-sol'], custom: true });
  assert.deepEqual(splitModelMenu(catalogue, menu.primary).primary.map(o => o.modelId), ['qwen-web-max', 'gpt-6-sol']);
  assert.throws(() => normalizeModelMenu({ primary: 'openai-codex/gpt-6-sol' }), /primary must be an array/);
  assert.equal(normalizeModelMenu({ primary: Array.from({ length: 150 }, (_, i) => `p/m${i}`) }).primary.length, 100);
});

test('when no chosen model is available every model is shown directly, never an empty menu', () => {
  assert.deepEqual(splitModelMenu(catalogue, []), { primary: catalogue, more: [], fallback: true });
  assert.equal(splitModelMenu(catalogue, ['gone/model']).fallback, true);
  assert.equal(splitModelMenu([], DEFAULT_PRIMARY_MODELS).primary.length, 0);
});

test('the star pins a model at the end and unpins it again', () => {
  const pinned = togglePrimaryModel(['a/1', 'b/2'], 'c/3');
  assert.deepEqual(pinned, ['a/1', 'b/2', 'c/3']);
  assert.deepEqual(togglePrimaryModel(pinned, 'a/1'), ['b/2', 'c/3']);
});

// Source integration against the pinned official checkout (CI: upstream/).
const repo = fileURLToPath(new URL('../', import.meta.url));
const source = [process.env.PIWEB_SOURCE, path.join(repo, 'upstream'), path.join(repo, '../scratch/pi-web-upstream-main'), path.join(repo, '../pi-web-upstream-main')].find(dir => dir && fs.existsSync(path.join(dir, 'components/ModelSelector.tsx')));
test('ModelSelector renders the primary list with "更多模型" and a server-kept menu', { skip: !source && 'official source checkout required (PIWEB_SOURCE)' }, () => {
  const stateFile = path.join(source, '.pi-portable-overlay.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const files = integrate(name => fs.readFileSync(state?.files[name]?.backup || path.join(source, name), 'utf8'));
  const selector = files.get('components/ModelSelector.tsx');
  assert.match(selector, /^"use client";\nimport \{ PortableModelList \} from "\.\/PortableModelList";/);
  assert.match(selector, /<PortableModelList\s+options=\{sortedOptions\}\s+filtered=\{filteredOptions\}\s+filterActive=\{!!filter\.trim\(\)\}/);
  assert.doesNotMatch(selector, /modelsByProvider\.map\(\(group, index\)/, 'the flat provider list is replaced');
  assert.match(selector, /\{modelsByProvider\.length === 0 \? \(/, 'the empty/no-match message stays');
  assert.match(selector, /className="pw-model-row"/);
  assert.match(selector, /trailing\?: ReactNode/);
  assert.match(selector, /aria-label=\{ariaLabel \?\? `当前模型：\$\{currentName\}`\}/, 'earlier overlay edits still apply');
  const route = files.get('app/api/model-menu/route.ts');
  assert.match(route, /web-model-menu\.json/);
  assert.match(route, /projectMutationAllowed\(req\)/);
  assert.match(route, /export async function PUT/);
  assert.equal(files.get('lib/portable-model-menu.mjs'), fs.readFileSync(path.join(repo, 'assets/piweb-overlay/portable-model-menu.mjs'), 'utf8').replaceAll('\r\n', '\n'));
  const list = files.get('components/PortableModelList.tsx');
  assert.match(list, /更多模型/);
  // The side panel is placed from its real width, never from a guessed 240 px.
  assert.match(list, /placeSidePanel\(moreRect, \{ width: viewportWidth \}\)/);
  assert.doesNotMatch(list, /\+ 4 \+ 240 <= viewportWidth/);
  assert.match(list, /className="pw-model-side"/);
  assert.match(list, /maxWidth: 150/, 'the current model name must not widen the menu');
});

test('the side panel stays on screen: right when it fits, left when the right edge is too close, inline when neither fits', () => {
  const inView = (place, anchor, width) => {
    const box = place.side === 'right' ? { l: place.left, r: place.left + place.maxWidth } : { l: width - place.right - place.maxWidth, r: width - place.right };
    return box.l >= 0 && box.r <= width && (place.side === 'right' ? box.l >= anchor.right : box.r <= anchor.left);
  };
  // lop's screenshot: menu 1252-1660 on a 2000 px screen; the old check picked the right side and ran off the edge.
  const wide = { left: 1252, right: 1660 };
  const flipped = placeSidePanel(wide, { width: 2000 });
  assert.equal(flipped.side, 'left');
  assert.ok(inView(flipped, wide, 2000));
  // Room on the right: keep the old placement.
  const roomy = { left: 300, right: 700 };
  assert.equal(placeSidePanel(roomy, { width: 1600 }).side, 'right');
  assert.equal(placeSidePanel(roomy, { width: 1600 }).left, 704);
  // Every menu position on every common width either fits or falls back to the inline list.
  for (const width of [1024, 1280, 1366, 1440, 1600, 1920, 2560]) for (let right = 260; right <= width - 8; right += 37) {
    const anchor = { left: right - 290, right };
    const place = placeSidePanel(anchor, { width });
    if (place) assert.ok(inView(place, anchor, width), `width ${width} menu ends at ${right}: ${JSON.stringify(place)}`);
  }
  // A narrow window with no side wide enough for a readable panel lists the models inline instead.
  assert.equal(placeSidePanel({ left: 40, right: 330 }, { width: 400 }), null);
  // Only a cramped side left: clamp to it rather than overflow.
  const cramped = placeSidePanel({ left: 8, right: 300 }, { width: 600 });
  assert.equal(cramped.side, 'right');
  assert.ok(cramped.maxWidth <= 600 - 300 - 12);
});
