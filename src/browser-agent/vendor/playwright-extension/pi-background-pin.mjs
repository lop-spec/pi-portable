// Pin only this extension's Welcome/connection pages. Never activate a tab.
export function isConnectionPage(tab, api = chrome) {
  return tab.url?.split(/[?#]/, 1)[0] === api.runtime.getURL('connect.html');
}
export async function pinConnectionTabs(api = chrome) {
  const ownUrl = api.runtime.getURL('connect.html');
  const isConnection = tab => isConnectionPage(tab, api);
  let pinned = 0;
  for (const tab of await api.tabs.query({url: ownUrl + '*'})) {
    if (!isConnection(tab) || tab.pinned) continue;
    // Recheck ownership: the user may have navigated the tab since the query.
    const current = await api.tabs.get(tab.id);
    if (!isConnection(current) || current.pinned) continue;
    await api.tabs.update(tab.id, {pinned: true});
    pinned++;
  }
  console.info('[pi-background] connection pages pinned without activation', pinned);
  return pinned;
}
// Never reload the extension from a connection page: that can interrupt other
// clients and leave the offscreen bridge asleep. Report an outdated worker.
export async function initializePinning() {
  const ready = await chrome.runtime.sendMessage({type: 'pi-connection-pinning-ready'});
  if (!ready?.ready) throw new Error('Loaded worker predates connection pinning; reload the extension once to apply the installed update');
  return pinConnectionTabs();
}
export const pinning = typeof document === 'undefined' ? Promise.resolve(0) : initializePinning().catch(error => {
  console.error('[pi-background] connection-page-pin-failed', error.message);
});
