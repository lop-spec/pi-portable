// Claude-style model menu (lop 2026-09-29): the primary models are listed directly and every
// other model sits under "更多模型". Which models are primary is chosen in the menu itself
// (star on each row) and kept server-side in <agentDir>/web-model-menu.json, so every
// browser and the phone see the same menu. Pure functions only: shared by the route and
// the client component.
export const DEFAULT_PRIMARY_MODELS = Object.freeze([
  'openai-codex/gpt-6-astra',
  'openai-codex/gpt-6-luna',
  'openai-codex/gpt-6-sol',
  'pi-chatgpt-web/chatgpt-web-instant',
  'pi-chatgpt-web/chatgpt-web-astra',
]);
const MAX_PRIMARY = 100, MAX_KEY = 200;

export const modelMenuKey = option => `${option.provider}/${option.modelId}`;

/** A stored menu, or the defaults when nothing was chosen yet. Unknown shapes are rejected. */
export function normalizeModelMenu(value) {
  if (value === null || value === undefined) return { primary: [...DEFAULT_PRIMARY_MODELS], custom: false };
  if (!Array.isArray(value.primary)) throw new Error('model menu: primary must be an array of "provider/modelId" keys');
  const seen = new Set(), primary = [];
  for (const key of value.primary) {
    if (typeof key !== 'string' || !key.includes('/') || key.length > MAX_KEY || seen.has(key)) continue;
    seen.add(key); primary.push(key);
    if (primary.length >= MAX_PRIMARY) break;
  }
  return { primary, custom: true };
}

/**
 * Primary models in the chosen order, and the rest in the given order. When none of the
 * chosen models is available (renamed, disabled, nothing pinned) every model is shown
 * directly, so the menu can never hide all of them.
 */
export function splitModelMenu(options, primaryKeys) {
  const byKey = new Map(options.map(option => [modelMenuKey(option), option]));
  const primary = primaryKeys.map(key => byKey.get(key)).filter(Boolean);
  if (!primary.length) return { primary: options, more: [], fallback: true };
  const chosen = new Set(primary.map(modelMenuKey));
  return { primary, more: options.filter(option => !chosen.has(modelMenuKey(option))), fallback: false };
}

/** Pin a model (appended at the end) or unpin it. */
export const togglePrimaryModel = (primaryKeys, key) => primaryKeys.includes(key) ? primaryKeys.filter(k => k !== key) : [...primaryKeys, key];
