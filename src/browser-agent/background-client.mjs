import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {backgroundConfig} from './vendor/playwright-extension/pi-background-config.mjs';
export async function brokerRequest(route,token,options={}) {
  const response=await fetch(backgroundConfig.baseUrl+route,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(1500)});
  if(!response.ok)throw new Error(`Background broker HTTP ${response.status}`);
  return response.json();
}
export async function ensureBackgroundBroker({dataRoot,authFile,token,requireExtension=true}) {
  let state;
  try {state=await brokerRequest('/health',token);}catch(error){
    if(error.message.startsWith('Background broker HTTP'))throw error;
    const logFile=path.join(dataRoot,'browser-agent','background-broker.log');
    await fs.mkdir(path.dirname(logFile),{recursive:true});
    const log=await fs.open(logFile,'a');
    try {
      const child=spawn(process.execPath,[fileURLToPath(new URL('./background-broker.mjs',import.meta.url)),authFile],{windowsHide:true,detached:true,shell:false,stdio:['ignore',log.fd,log.fd]});
      child.on('error',error=>console.error('[browser] background-broker-start-failed: '+error.message));
      child.unref();
    }finally{await log.close();}
    for(let attempt=0;attempt<20;attempt++){await new Promise(resolve=>setTimeout(resolve,150));try{state=await brokerRequest('/health',token);break;}catch{}}
  }
  if(state?.service!=='pi-background-browser'||state.protocol!==backgroundConfig.protocol)throw new Error('Background broker unavailable or incompatible; refusing foreground fallback');
  if(requireExtension){
    for(let attempt=0;Date.now()-state.lastPoll>6000&&attempt<20;attempt++){await new Promise(resolve=>setTimeout(resolve,200));state=await brokerRequest('/health',token);}
    if(Date.now()-state.lastPoll>6000)throw new Error('The Pi Background extension is not connected. Install/reload the managed unpacked extension; no foreground or native-CDP fallback will be used.');
  }
  return state;
}
