// Claude-style model menu (lop 2026-09-29): the primary models are listed directly and every
// other model sits under "更多模型". Which models are primary is chosen in the menu itself
// (star on each row) and kept server-side in <agentDir>/web-model-menu.json, so every
// browser and the phone see the same menu. A model can also be hidden (lop 2026-10-04): hidden
// models leave "更多模型" and are listed in its third level "隐藏模型". Pure functions only:
// shared by the route and the client component.
export const DEFAULT_PRIMARY_MODELS = Object.freeze([
  'openai-codex/gpt-6-astra',
  'openai-codex/gpt-6-luna',
  'openai-codex/gpt-6-sol',
  'pi-chatgpt-web/chatgpt-web-instant',
  'pi-chatgpt-web/chatgpt-web-astra',
]);
const MAX_PRIMARY = 100, MAX_HIDDEN = 300, MAX_KEY = 200;
/** "一键归档超过 N 天的对话" in the 更多模型 panel. */
export const ARCHIVE_OLDER_DAYS = 7;

export const modelMenuKey = option => `${option.provider}/${option.modelId}`;

function cleanKeys(list, max) {
  const seen = new Set(), keys = [];
  for (const key of list) {
    if (typeof key !== 'string' || !key.includes('/') || key.length > MAX_KEY || seen.has(key)) continue;
    seen.add(key); keys.push(key);
    if (keys.length >= max) break;
  }
  return keys;
}

/** A stored menu, or the defaults when nothing was chosen yet. Unknown shapes are rejected. */
export function normalizeModelMenu(value) {
  if (value === null || value === undefined) return { primary: [...DEFAULT_PRIMARY_MODELS], hidden: [], custom: false };
  if (!Array.isArray(value.primary)) throw new Error('model menu: primary must be an array of "provider/modelId" keys');
  if (value.hidden !== undefined && !Array.isArray(value.hidden)) throw new Error('model menu: hidden must be an array of "provider/modelId" keys');
  const primary = cleanKeys(value.primary, MAX_PRIMARY);
  // The star wins over the eye: a pinned model is never hidden, so the menu cannot hide its own primary list.
  const hidden = cleanKeys(value.hidden ?? [], MAX_HIDDEN).filter(key => !primary.includes(key));
  return { primary, hidden, custom: true };
}

/**
 * Primary models in the chosen order, the rest in the given order, split into "更多模型" and the
 * hidden ones ("隐藏模型"). When none of the chosen models is available (renamed, disabled, nothing
 * pinned) every model is shown directly, so the menu can never hide all of them.
 */
export function splitModelMenu(options, primaryKeys, hiddenKeys = []) {
  const byKey = new Map(options.map(option => [modelMenuKey(option), option]));
  const primary = primaryKeys.map(key => byKey.get(key)).filter(Boolean);
  if (!primary.length) return { primary: options, more: [], hidden: [], fallback: true };
  const chosen = new Set(primary.map(modelMenuKey)), hide = new Set(hiddenKeys);
  const rest = options.filter(option => !chosen.has(modelMenuKey(option)));
  return { primary, more: rest.filter(option => !hide.has(modelMenuKey(option))), hidden: rest.filter(option => hide.has(modelMenuKey(option))), fallback: false };
}

/**
 * Where the "更多模型" side panel goes, from the menu's box and the visible viewport. It has to
 * fit on screen with its real width: 2026-09-30 the check assumed 240 px while the panel grows to
 * ~390 px, so with the selector in the right control group the panel ran off the right edge and
 * the pin stars at the row ends were unreachable. Prefers the right side, then the left; when
 * neither has room for a readable panel it returns null and the caller lists the models inline.
 */
export const SIDE_PANEL = Object.freeze({ want: 340, max: 380, min: 220, gap: 4, edge: 8 });
export function placeSidePanel(anchor, viewport, size = SIDE_PANEL) {
  const right = viewport.width - anchor.right - size.gap - size.edge;
  const left = anchor.left - size.gap - size.edge;
  const side = right >= size.want ? 'right' : left >= size.want ? 'left' : right >= left ? 'right' : 'left';
  const room = side === 'right' ? right : left;
  if (room < size.min) return null;
  // One shape for both sides: the client type-checks this .mjs return value, and a union hides left/right.
  return { side, maxWidth: Math.min(size.max, room), left: anchor.right + size.gap, right: viewport.width - anchor.left + size.gap };
}

/**
 * The third level ("隐藏模型") opens beyond the second-level panel, in the direction that panel
 * opened, so it never covers the main menu. Same shape as placeSidePanel; null when there is no
 * room for a readable panel and the caller lists the hidden models inside the second level instead.
 */
export function placeNestedPanel(parent, viewport, side, size = SIDE_PANEL) {
  const room = side === 'right' ? viewport.width - parent.right - size.gap - size.edge : parent.left - size.gap - size.edge;
  if (room < size.min) return null;
  return { side, maxWidth: Math.min(size.max, room), left: parent.right + size.gap, right: viewport.width - parent.left + size.gap };
}

/** Pin a model (appended at the end) or unpin it. */
export const togglePrimaryModel = (primaryKeys, key) => primaryKeys.includes(key) ? primaryKeys.filter(k => k !== key) : [...primaryKeys, key];

/** The star: pin or unpin. Pinning a hidden model brings it back out of 隐藏模型. */
export const pinModel = (menu, key) => ({ primary: togglePrimaryModel(menu.primary, key), hidden: menu.hidden.filter(k => k !== key) });

/** The eye: hide a model (and unpin it), or show a hidden one again in 更多模型. */
export const hideModel = (menu, key) => menu.hidden.includes(key)
  ? { primary: menu.primary, hidden: menu.hidden.filter(k => k !== key) }
  : { primary: menu.primary.filter(k => k !== key), hidden: [...menu.hidden, key] };

/** What the "一键归档超过 N 天的对话" button shows after the proxy answers; failures and skips are never silent. */
export function archiveOlderSummary(result, days = ARCHIVE_OLDER_DAYS) {
  const archived = Number(result?.groupCount) || 0, running = Number(result?.skippedRunning) || 0, failed = Number(result?.failed) || 0;
  const parts = [archived ? `已归档 ${archived} 个对话` : `没有超过 ${days} 天的对话`];
  if (running) parts.push(`${running} 个运行中已跳过`);
  if (failed) parts.push(`${failed} 个归档失败`);
  return { text: parts.join('，'), error: failed > 0 };
}
