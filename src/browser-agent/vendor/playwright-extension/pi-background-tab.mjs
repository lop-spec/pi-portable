// A machine-local tab identity survives MCP disconnects and extension worker reloads.
// Never adopt an ordinary user page just because its title or URL happens to match.
export const FIXED_TAB_KEY = 'pi-background-fixed-tab';
// IndexedDB is available in MV3 workers without new extension permissions.
export const tabIdentityStorage = {
  async access(write, value) {
    const db = await new Promise((resolve,reject) => {
      const request = indexedDB.open('pi-background-tab',1);
      request.onupgradeneeded = () => request.result.createObjectStore('identity');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Fixed-tab identity database is blocked'));
    });
    try {
      return await new Promise((resolve,reject) => {
        const transaction = db.transaction('identity',write?'readwrite':'readonly');
        const store = transaction.objectStore('identity');
        const request = write ? store.put(value,FIXED_TAB_KEY) : store.get(FIXED_TAB_KEY);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Fixed-tab identity transaction failed'));
      });
    } finally { db.close(); }
  },
  get() { return this.access(false); },
  set(value) { return this.access(true,value); },
};
export function createFixedTabStore(api = chrome, storage = tabIdentityStorage) {
  const isConnection = tab => tab.url?.split(/[?#]/, 1)[0] === api.runtime.getURL('connect.html');
  return {
    async ensure() {
      const saved = await storage.get();
      let tab;
      if (Number.isInteger(saved)) {
        try { tab = await api.tabs.get(saved); }
        catch (error) { console.info('[pi-background] fixed-tab-missing; recovering', saved, error.message); }
      }
      if (!tab) {
        const candidates = (await api.tabs.query({})).filter(isConnection);
        // Preserve the active tab when migrating the old Welcome-page pile.
        tab = candidates.sort((a,b) => Number(b.active)-Number(a.active) || a.id-b.id)[0];
        if (!tab) {
          const windows = await api.windows.getAll({windowTypes:['normal']});
          if (!windows.length) throw new Error('No existing normal Thorium window; refusing to open a window');
          tab = await api.tabs.create({windowId:(windows.find(w=>w.focused)||windows[0]).id,url:'about:blank',active:false,pinned:true});
          console.info('[pi-background] created missing fixed tab', tab.id);
        }
        await storage.set(tab.id);
      }
      if (isConnection(tab)) {
        await api.tabs.update(tab.id,{url:'about:blank'});
        const deadline = Date.now()+5000;
        do {
          tab = await api.tabs.get(tab.id);
          if (tab.url==='about:blank' && tab.status!=='loading') break;
          if (Date.now()>=deadline) throw new Error('Fixed tab did not finish retiring its connection page');
          await new Promise(resolve=>setTimeout(resolve,25));
        } while (true);
      }
      if (!tab.pinned) tab = await api.tabs.update(tab.id,{pinned:true});
      return tab;
    },
  };
}

// Only stale extension-owned Welcome pages are disposable. Preserve every normal
// website and recheck each candidate to avoid closing a page the user navigated.
export async function retireConnectionPages(fixedTabId, api = chrome) {
  const ownUrl = api.runtime.getURL('connect.html');
  let removed = 0;
  for (const candidate of await api.tabs.query({url:ownUrl+'*'})) {
    if (candidate.id === fixedTabId) continue;
    let tab;
    try { tab = await api.tabs.get(candidate.id); }
    catch (error) { console.info('[pi-background] stale-page-already-gone', candidate.id, error.message); continue; }
    if (tab.url?.split(/[?#]/,1)[0] !== ownUrl || tab.active) {
      console.info('[pi-background] stale-page-preserved; active-or-navigated', candidate.id);
      continue;
    }
    await api.tabs.remove(tab.id);
    removed++;
  }
  console.info('[pi-background] retired stale connection pages', removed);
  return removed;
}
