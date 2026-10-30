// Only explicit user choices write this preference. Historical session reads never do.
export const THINKING_PREFERENCE_KEY = 'pi-last-thinking-level';
/** @param {string} id */
const pendingKey = id => `pi-pending-thinking:${id}`;
/** @param {string | null | undefined} id */
export function readPendingThinking(id) {
  try { return id ? validThinkingPreference(globalThis.localStorage?.getItem(pendingKey(id))) : null; }
  catch { return null; }
}
/** @param {string} id @param {string} level */
export function savePendingThinking(id, level) {
  if (!id || !validThinkingPreference(level)) return;
  try { globalThis.localStorage?.setItem(pendingKey(id), level); } catch {}
}
/** @param {string} id @param {string} level */
export function clearPendingThinking(id, level) {
  try {
    if (readPendingThinking(id) === level) globalThis.localStorage?.removeItem(pendingKey(id));
  } catch {}
}
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
