import {backgroundConfig} from './pi-background-config.mjs';

// Chrome 110+: an extension API call resets the service-worker idle timer.
// Keep the local invitation bridge alive without an offscreen document or tab.
export function createWorkerBridge({openConnection, api=chrome, request=fetch, later=setTimeout}) {
  let started=false, token, pairing, lastFailure='';
  const seen=new Map();
  async function getToken() {
    if(token)return token;
    if(!pairing)pairing=(async()=>{
      const response=await request(api.runtime.getURL('pi-background-pairing.json'));
      if(!response.ok)throw new Error('Machine-local pairing file is unavailable');
      const data=await response.json();
      if(!/^[A-Za-z0-9_-]{43}$/.test(data.token))throw new Error('Invalid machine-local pairing token');
      token=data.token;return token;
    })().finally(()=>{pairing=null;});
    return pairing;
  }
  async function send(route,body) {
    const secret=await getToken();
    const response=await request(backgroundConfig.baseUrl+route,{
      method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(3000),
    });
    if(!response.ok)throw new Error('Background broker HTTP '+response.status);
    return response.json();
  }
  async function tick() {
    let delay=1000;
    try {
      await api.runtime.getPlatformInfo();
      const {tickets}=await send('/poll');
      if(lastFailure){console.info('[pi-background] worker-bridge-recovered');lastFailure='';}
      for(const ticket of tickets){
        if(seen.has(ticket.id))continue;
        if(new URL(ticket.url).searchParams.get('token')!==token)throw new Error('Invitation token does not match this machine');
        let result;
        try {result=await openConnection(ticket.url);}
        catch(error){console.error('[pi-background] invitation-failed',error.message);result={success:false,error:error.message};}
        await send('/ack',{id:ticket.id,...result});
        seen.set(ticket.id,Date.now());
      }
      for(const [id,time] of seen)if(Date.now()-time>300000)seen.delete(id);
    } catch(error) {
      lastFailure=error.message;delay=5000;
      console.error('[pi-background] worker-bridge-unavailable',lastFailure);
    } finally {later(tick,delay);}
  }
  return {
    async start(){if(started)return;started=true;await tick();},
    async event(event){await send('/event',event);},
  };
}
