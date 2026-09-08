import {backgroundConfig} from './pi-background-config.mjs';
let token=localStorage.getItem('auth-token');
if(!token){
  try {const pairing=await (await fetch('pi-background-pairing.json')).json();if(!/^[A-Za-z0-9_-]{43}$/.test(pairing.token))throw new Error('Invalid pairing token');token=pairing.token;localStorage.setItem('auth-token',token);console.info('[pi-background] paired this extension profile');}
  catch(error){console.error('[pi-background] pairing-unavailable',error.message);}
}
const headers=()=>({Authorization:`Bearer ${token}`,'Content-Type':'application/json'});
let lastFailure='';
const seen=new Map();
async function post(route,body){const response=await fetch(backgroundConfig.baseUrl+route,{method:'POST',headers:headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error(`Bootstrap HTTP ${response.status}`);}
chrome.runtime.onMessage.addListener((message,sender)=>{
  if(sender.id===chrome.runtime.id&&message.type==='pi-focus-event'&&token)post('/event',message.event).catch(error=>console.error('[pi-background] focus-event-delivery-failed',error.message));
});
async function poll(){
  try {
    if(!token)throw new Error('Extension auth token is not configured');
    const response=await fetch(backgroundConfig.baseUrl+'/poll',{headers:headers(),signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error(`Bootstrap HTTP ${response.status}`);
    const {tickets}=await response.json();
    if(lastFailure){console.info('[pi-background] bootstrap-reconnected');lastFailure='';}
    for(const ticket of tickets){
      if(seen.has(ticket.id))continue;
      const url=new URL(ticket.url);
      if(url.searchParams.get('token')!==token)throw new Error('Invitation token does not match this profile');
      const result=await chrome.runtime.sendMessage({type:'pi-background-connect',url:ticket.url});
      await post('/ack',{id:ticket.id,...result});
      seen.set(ticket.id,Date.now());
    }
    for(const [id,time] of seen)if(Date.now()-time>300000)seen.delete(id);
  }catch(error){if(error.message!==lastFailure){lastFailure=error.message;console.error('[pi-background] bootstrap-unavailable',lastFailure);}}
  setTimeout(poll,1000);
}
poll();
