import {backgroundConfig} from './pi-background-config.mjs';
import {pinConnectionTabs} from './pi-background-pin.mjs';
import {createWorkerBridge} from './pi-background-worker.mjs';

export async function openBackgroundConnection(href) {
  const url=new URL(href);
  const relay=new URL(url.searchParams.get('mcpRelayUrl'));
  if(url.protocol!=='chrome-extension:'||url.hostname!==backgroundConfig.extensionId||url.pathname!=='/connect.html'||relay.protocol!=='ws:'||!['127.0.0.1','[::1]'].includes(relay.hostname))throw new Error('Rejected non-local extension connection invitation');
  const windows=await chrome.windows.getAll({windowTypes:['normal']});
  if(!windows.length)throw new Error('No existing normal Thorium window; refusing to open a window');
  const window=windows.find(w=>w.focused)||windows[0];
  const tab=await chrome.tabs.create({windowId:window.id,url:url.href,active:false,pinned:true});
  console.info('[pi-background] opened background connection tab',tab.id);
  return {success:true,tabId:tab.id};
}
const bridge=createWorkerBridge({openConnection:openBackgroundConnection});
const start=()=>{
  void bridge.start();
  void pinConnectionTabs().catch(error=>console.error('[pi-background] connection-page-pin-failed',error.message));
};
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
start();
const focusEvent=event=>bridge.event({at:Date.now(),...event}).catch(error=>console.error('[pi-background] focus-event-not-delivered',error.message));
chrome.tabs.onActivated.addListener(info=>focusEvent({kind:'tab-activated',...info}));
chrome.windows.onFocusChanged.addListener(windowId=>focusEvent({kind:'window-focused',windowId}));
