import {backgroundConfig} from './pi-background-config.mjs';
import {createWorkerBridge} from './pi-background-worker.mjs';

export function parseBackgroundInvitation(href) {
  const url = new URL(href);
  const relay = new URL(url.searchParams.get('mcpRelayUrl'));
  if (url.protocol !== 'chrome-extension:' || url.hostname !== backgroundConfig.extensionId || url.pathname !== '/connect.html' || relay.protocol !== 'ws:' || !['127.0.0.1','[::1]'].includes(relay.hostname)) throw new Error('Rejected non-local extension connection invitation');
  if (url.searchParams.get('protocolVersion') !== '2') throw new Error('Unsupported extension protocol version');
  let clientName;
  try { clientName = JSON.parse(url.searchParams.get('client') || '{}').name; }
  catch { throw new Error('Invalid client metadata'); }
  return {relayUrl:relay.href,clientName:clientName || 'Pi Thorium'};
}

export function startBackgroundService(connect) {
  const bridge = createWorkerBridge({openConnection:async href => {
    const result = await connect(parseBackgroundInvitation(href));
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({});
    await bridge.event({kind:'single-tab-state',at:Date.now(),tabId:result.tabId,tabCount:tabs.length,
      connectionTabCount:tabs.filter(t=>t.url?.split(/[?#]/,1)[0]===chrome.runtime.getURL('connect.html')).length,
      playwrightGroupCount:groups.filter(g=>g.title==='Playwright'||g.title?.startsWith('Playwright · ')).length,
      activeTabs:tabs.filter(t=>t.active).map(t=>({tabId:t.id,windowId:t.windowId}))
    }).catch(error=>console.error('[pi-background] single-tab-state-not-delivered',error.message));
    return result;
  }});
  const start = () => { void bridge.start(); };
  chrome.runtime.onInstalled.addListener(start);
  chrome.runtime.onStartup.addListener(start);
  start();
  const focusEvent = event => bridge.event({at:Date.now(),...event}).catch(error=>console.error('[pi-background] focus-event-not-delivered',error.message));
  chrome.tabs.onActivated.addListener(info=>focusEvent({kind:'tab-activated',...info}));
  chrome.windows.onFocusChanged.addListener(windowId=>focusEvent({kind:'window-focused',windowId}));
}
