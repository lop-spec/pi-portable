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
// Only identities persist; leases belong to live connections. A worker restart must
// still consult Chrome's debugger state before treating a saved identity as idle.
// 'about:blank', 'connect' (our own connection page) or the page origin. Only the lease
// holder may navigate a pooled tab, so a different origin at the next acquire than the
// one recorded at release means the user or another client took the tab over.
export function originOf(url, connectionUrl) {
  if (!url || url === 'about:blank') return 'about:blank';
  if (connectionUrl && url.split(/[?#]/,1)[0] === connectionUrl) return 'connect';
  try { return new URL(url).origin; } catch { return url; }
}
export function createFixedTabPool(api = chrome, storage = tabIdentityStorage) {
  let ids, origins = {}, dirty = false, tail = Promise.resolve();
  const leases = new Map();
  const validId = id => Number.isInteger(id) && id >= 0;
  async function acquire(owner) {
    if (owner === undefined || owner === null) throw new Error('A background tab lease owner is required');
    if (!ids) {
      const saved = await storage.get();
      if (saved == null) ids = [];
      else if (validId(saved)) { ids = [saved]; dirty = true; }
      else if (saved.version === 2 && Array.isArray(saved.tabIds) && saved.tabIds.every(validId)) {
        ids = [...new Set(saved.tabIds)];
        origins = saved.origins && typeof saved.origins === 'object' ? Object.fromEntries(Object.entries(saved.origins).filter(([id,origin]) => ids.includes(Number(id)) && typeof origin === 'string')) : {};
      }
      else throw new Error('Invalid background tab pool identity; refusing to overwrite it');
    }
    const [tabs, targets] = await Promise.all([api.tabs.query({}), api.debugger.getTargets()]);
    const live = new Map(tabs.map(tab => [tab.id, tab]));
    if (leases.has(owner)) {
      const owned = live.get(leases.get(owner));
      if (!owned) throw new Error('Owned background tab was closed; reconnect to acquire another');
      return owned;
    }
    const remaining = ids.filter(id => live.has(id));
    if (remaining.length !== ids.length) {
      console.info('[pi-background] pruned closed pool identities', ids.length - remaining.length);
      ids = remaining; dirty = true;
      for (const id of Object.keys(origins)) if (!live.has(Number(id))) delete origins[id];
    }
    const reserved = new Set(leases.values());
    const attached = new Set(targets.filter(target => target.attached).map(target => target.tabId));
    const ownConnectionUrl = api.runtime.getURL('connect.html');
    let tab;
    const abandoned = [];
    for (const id of ids) {
      const candidate = live.get(id);
      const url = candidate.pendingUrl || candidate.url || '';
      const origin = originOf(url, ownConnectionUrl);
      const reason = reserved.has(id) ? 'leased' : attached.has(id) ? 'debugger-attached' : candidate.active ? 'user-active' : candidate.discarded ? 'discarded' :
        !(/^(https?:\/\/|about:blank$)/.test(url) || origin === 'connect') ? 'unsupported-page' :
        origins[id] !== undefined ? (origin === origins[id] ? null : 'foreign-navigation') :
        (origin === 'about:blank' || origin === 'connect' ? null : 'unrecorded-history');
      // A tab someone else navigated is theirs now: drop the identity, never clear the page.
      if (reason === 'foreign-navigation' || reason === 'unrecorded-history') { abandoned.push(id); console.info('[pi-background] pool-tab-abandoned', id, reason, origin); continue; }
      if (reason) { console.info('[pi-background] pool-tab-not-idle', id, reason); continue; }
      tab = candidate; break;
    }
    if (abandoned.length) { ids = ids.filter(id => !abandoned.includes(id)); for (const id of abandoned) delete origins[id]; dirty = true; }
    if (!tab) {
      const windows = await api.windows.getAll({windowTypes:['normal']});
      if (!windows.length) throw new Error('No existing normal browser window; refusing to launch a browser or window');
      tab = await api.tabs.create({windowId:(windows.find(w=>w.focused)||windows[0]).id,url:'about:blank',active:false,pinned:true});
      ids.push(tab.id); origins[tab.id] = 'about:blank'; dirty = true;
      console.info('[pi-background] created background pool tab; no idle owned tab', tab.id);
    }
    // Persist even a newly created identity before granting a lease. On write
    // failure keep it in memory so a retry cannot create an orphan on every call.
    if (dirty) { await storage.set({version:2,tabIds:ids,origins}); dirty = false; }
    tab = await api.tabs.get(tab.id);
    if (tab.active) throw new Error('Background tab became user-active during allocation; refusing to take it over');
    if (tab.url?.split(/[?#]/,1)[0] === ownConnectionUrl) {
      tab = await api.tabs.update(tab.id,{url:'about:blank'});
      console.info('[pi-background] retired idle legacy connection page', tab.id);
    }
    if (!tab.pinned) tab = await api.tabs.update(tab.id,{pinned:true});
    // Record where the tab is handed over too, so a client that dies without releasing
    // still gets its unchanged tab back instead of leaking it.
    const leasedOrigin = originOf(tab.pendingUrl || tab.url || '', ownConnectionUrl);
    if (origins[tab.id] !== leasedOrigin) { origins[tab.id] = leasedOrigin; await storage.set({version:2,tabIds:ids,origins}); }
    leases.set(owner, tab.id);
    console.info('[pi-background] leased background pool tab', tab.id);
    return tab;
  }
  return {
    acquire(owner) {
      // Serialize allocation only, not browser work performed by independent clients.
      const pending = tail.then(() => acquire(owner)).catch(error => {
        console.error('[pi-background] pool-acquire-failed', error.message);
        throw error;
      });
      tail = pending.then(() => {}, () => {});
      return pending;
    },
    release(owner) {
      if (!leases.has(owner)) return false;
      const tabId = leases.get(owner);
      console.info('[pi-background] released background pool tab', tabId);
      leases.delete(owner);
      // Remember where the tab was left; serialized behind allocations so the next
      // acquire sees it. A failed record only makes the tab look foreign, never ours.
      tail = tail.then(async () => {
        let tab; try { tab = await api.tabs.get(tabId); } catch { return; }
        origins[tabId] = originOf(tab.pendingUrl || tab.url || '', api.runtime.getURL('connect.html'));
        await storage.set({version:2,tabIds:ids,origins});
      }).catch(error => console.error('[pi-background] release-record-failed', error.message));
      return true;
    },
  };
}

export function createFixedTabStore(api = chrome, storage = tabIdentityStorage) {
  const isConnection = tab => tab.url?.split(/[?#]/, 1)[0] === api.runtime.getURL('connect.html');
  return {
    async ensure() {
      const saved = await storage.get();
      if (saved && typeof saved === 'object') {
        console.error('[pi-background] legacy fixed-tab code cannot consume pool identities; reload required');
        throw new Error('Background tab pool identity requires the updated extension; reload after active sessions disconnect');
      }
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
