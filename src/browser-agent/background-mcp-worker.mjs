import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {patchBackgroundBootstrap} from './background-mcp-patch.mjs';
import {backgroundConfig} from './vendor/playwright-extension/pi-background-config.mjs';
const [bundle,outputDir]=process.argv.slice(2);
const token=process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
const log=message=>console.error('[pi-background] '+String(message).replaceAll(token||'__missing_token__','<redacted>'));
globalThis.__piOpenBackgroundExtension=async url=>{
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const response=await fetch(backgroundConfig.baseUrl+'/connect',{method:'POST',headers,body:JSON.stringify({url}),signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error(`Background bootstrap rejected invitation (${response.status})`);
  const {id}=await response.json();
  log('background invitation queued '+id);
  for(let attempt=0;attempt<50;attempt++){
    await new Promise(resolve=>setTimeout(resolve,300));
    const state=await fetch(backgroundConfig.baseUrl+'/ticket/'+id,{headers,signal:AbortSignal.timeout(2000)});
    if(!state.ok)throw new Error('Background invitation disappeared');
    const result=await state.json();
    if(result.status==='opened'){log('background tab ready '+result.tabId);return;}
    if(result.status==='failed')throw new Error(result.error||'Extension rejected background connection');
  }
  throw new Error('Background extension did not accept the invitation; no foreground fallback was attempted');
};
try {
  const source=patchBackgroundBootstrap(await fs.readFile(bundle,'utf8'));
  const module={exports:{}};
  // Evaluate the trusted, installed Apache-licensed bundle with its original module paths.
  // No dependency files are overwritten, and no browser process is launched by this entrypoint.
  new Function('require','module','exports','__filename','__dirname',source)(createRequire(bundle),module,module.exports,bundle,path.dirname(bundle));
  const server=await module.exports.tools.createConnection({extension:true,sharedBrowserContext:true,outputDir});
  const transport={
    async start(){this.reader=createInterface({input:process.stdin,crlfDelay:Infinity});this.reader.on('line',line=>{if(!line.trim())return;try{this.onmessage?.(JSON.parse(line));}catch(error){this.onerror?.(error);}});this.reader.on('close',()=>this.onclose?.());},
    send(message){return new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolve()));},
    async close(){this.reader?.close();},
  };
  await server.connect(transport);
  log('official MCP loaded with background-only bootstrap');
}catch(error){log('startup-failed: '+error.stack);process.exitCode=1;}
