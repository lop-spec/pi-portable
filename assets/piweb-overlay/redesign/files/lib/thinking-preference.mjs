// Only explicit user choices write this preference. Historical session reads never do.
export const THINKING_PREFERENCE_KEY = 'pi-last-thinking-level';
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** @param {unknown} value */
export function validThinkingPreference(value) {
  return typeof value === 'string' && levels.includes(value) ? value : null;
}
/** @param {Pick<Storage, 'getItem'> | undefined} [storage] */
export function readThinkingPreference(storage) {
  try { return validThinkingPreference((storage ?? globalThis.localStorage)?.getItem(THINKING_PREFERENCE_KEY)); }
  catch { return null; }
}
/** @param {string} level @param {Pick<Storage, 'setItem'> | undefined} [storage] */
export function writeThinkingPreference(level, storage) {
  if (!validThinkingPreference(level)) return false;
  try { (storage ?? globalThis.localStorage)?.setItem(THINKING_PREFERENCE_KEY, level); return true; }
  catch { return false; }
}
