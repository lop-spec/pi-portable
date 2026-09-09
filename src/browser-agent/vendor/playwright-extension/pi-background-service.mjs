import {backgroundConfig} from './pi-background-config.mjs';
import {pinConnectionTabs} from './pi-background-pin.mjs';
let creating;
async function ensureOffscreen() {
  const url=chrome.runtime.getURL('pi-background.html');
  if((await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url]})).length)return;
  if(!creating)creating=chrome.offscreen.createDocument({url:'pi-background.html',reasons:['LOCAL_STORAGE'],justification:'Read this extension profile auth token and accept local background-only connection invitations.'}).finally(()=>creating=null);
  await creating;
}
const start=()=>Promise.all([ensureOffscreen(),pinConnectionTabs()]).catch(error=>console.error('[pi-background] background-start-failed',error.message));
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
start();
const focusEvent=event=>chrome.runtime.sendMessage({type:'pi-focus-event',event:{at:Date.now(),...event}}).catch(error=>console.error('[pi-background] focus-event-not-delivered',error.message));
chrome.tabs.onActivated.addListener(info=>focusEvent({kind:'tab-activated',...info}));
chrome.windows.onFocusChanged.addListener(windowId=>focusEvent({kind:'window-focused',windowId}));
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type!=='pi-background-connect')return;
  (async()=>{
    if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('pi-background.html'))throw new Error('Rejected non-offscreen invitation sender');
    const url=new URL(message.url);
    const relay=new URL(url.searchParams.get('mcpRelayUrl'));
    if(url.protocol!=='chrome-extension:'||url.hostname!==backgroundConfig.extensionId||url.pathname!=='/connect.html'||relay.protocol!=='ws:'||!['127.0.0.1','[::1]'].includes(relay.hostname))throw new Error('Rejected non-local extension connection invitation');
    const windows=await chrome.windows.getAll({windowTypes:['normal']});
    if(!windows.length)throw new Error('No existing normal Thorium window; refusing to open a window');
    const window=windows.find(w=>w.focused)||windows[0];
    const tab=await chrome.tabs.create({windowId:window.id,url:url.href,active:false,pinned:true});
    console.info('[pi-background] opened background connection tab',tab.id);
    return {success:true,tabId:tab.id};
  })().then(reply,error=>{console.error('[pi-background] invitation-failed',error.message);reply({success:false,error:error.message});});
  return true;
});
