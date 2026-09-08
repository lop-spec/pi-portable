import http from 'node:http';
import fs from 'node:fs/promises';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {backgroundConfig} from './vendor/playwright-extension/pi-background-config.mjs';
const {token}=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Invalid local extension token');
const origin=`chrome-extension://${backgroundConfig.extensionId}`;
const base=new URL(backgroundConfig.baseUrl);
const tickets=new Map(), events=[];
let sequence=0,lastPoll=0;
const log=(event,details={})=>console.log(JSON.stringify({at:new Date().toISOString(),event,...details}));
const authorized=req=>{const provided=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);return provided.length===expected.length&&timingSafeEqual(provided,expected);};
const server=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});res.end(JSON.stringify(value));};
  try {
    if(req.headers.host!==base.host||req.headers.origin&&req.headers.origin!==origin){log('rejected-origin');return reply(403,{error:'Origin rejected'});}
    if(req.method==='OPTIONS')return reply(200,{});
    if(!authorized(req)){log('rejected-auth');return reply(401,{error:'Extension authentication required'});}
    const url=new URL(req.url,base);
    let body={};
    if(req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(text.length>12000)return reply(413,{error:'Request too large'});}body=JSON.parse(text||'{}');}
    if(url.pathname==='/health')return reply(200,{service:'pi-background-browser',protocol:backgroundConfig.protocol,pid:process.pid,lastPoll});
    if(url.pathname==='/connect'&&req.method==='POST'){
      const connect=new URL(body.url),relay=new URL(connect.searchParams.get('mcpRelayUrl'));
      if(connect.protocol!=='chrome-extension:'||connect.hostname!==backgroundConfig.extensionId||connect.pathname!=='/connect.html'||connect.searchParams.get('token')!==token||relay.protocol!=='ws:'||!['127.0.0.1','[::1]'].includes(relay.hostname))return reply(400,{error:'Invalid extension invitation'});
      const id=randomUUID();tickets.set(id,{id,url:connect.href,status:'waiting',created:Date.now()});log('invitation-queued',{id});return reply(200,{id});
    }
    if(url.pathname==='/poll'){
      lastPoll=Date.now();
      for(const [id,t] of tickets)if(Date.now()-t.created>45000){if(t.status==='waiting')log('invitation-expired',{id});tickets.delete(id);}
      return reply(200,{tickets:[...tickets.values()].filter(t=>t.status==='waiting').map(({id,url})=>({id,url}))});
    }
    if(url.pathname==='/ack'&&req.method==='POST'){
      const t=tickets.get(body.id);if(!t)return reply(404,{error:'Invitation expired'});
      t.status=body.success?'opened':'failed';t.error=body.error?.slice(0,300);t.tabId=body.tabId;
      log('invitation-'+t.status,{id:t.id,tabId:t.tabId,reason:t.error});return reply(200,{ok:true});
    }
    if(url.pathname.startsWith('/ticket/')){const t=tickets.get(url.pathname.slice(8));return t?reply(200,{status:t.status,error:t.error,tabId:t.tabId}):reply(404,{error:'Invitation not found'});}
    if(url.pathname==='/event'&&req.method==='POST'){
      if(!['tab-activated','window-focused'].includes(body.kind))return reply(400,{error:'Invalid event'});
      events.push({seq:++sequence,at:body.at,kind:body.kind,tabId:body.tabId,windowId:body.windowId});if(events.length>300)events.shift();return reply(200,{ok:true});
    }
    if(url.pathname==='/diagnostics')return reply(200,{sequence,lastPoll,events});
    log('unknown-route',{path:url.pathname});reply(404,{error:'Unknown route'});
  }catch(error){log('request-failed',{reason:error.message.replaceAll(token,'<redacted>')});reply(500,{error:'Background broker request failed'});}
});
server.on('error',error=>{log('listen-failed',{reason:error.code});process.exitCode=1;});
server.listen(Number(base.port),base.hostname,()=>log('listening',{pid:process.pid,address:backgroundConfig.baseUrl}));
