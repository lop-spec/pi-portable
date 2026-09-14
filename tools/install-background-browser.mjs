// Install/update only the managed unpacked extension; never launch a browser,
// edit its Preferences, transfer credentials, or bypass its first-load consent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolveDailyBrowserExecutable} from '../src/browser-agent/daily-browser.mjs';
import {ensureBackgroundBroker} from '../src/browser-agent/background-client.mjs';
import {patchBackgroundBootstrap} from '../src/browser-agent/background-mcp-patch.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FILES=['LICENSE','manifest.json','connect.html','status.html','pi-background.html',
  'pi-background-config.mjs','pi-background-worker.mjs','pi-background-service.mjs','pi-background-tab.mjs','pi-background-pin.mjs','pi-background-offscreen.mjs',
  'lib/background.mjs','lib/ui/authToken.css','lib/ui/authToken.js','lib/ui/connect.js','lib/ui/status.js','lib/ui/icon-16.png','lib/ui/icon-32.png',
  'icons/icon-16.png','icons/icon-32.png','icons/icon-48.png','icons/icon-128.png'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new Error('Invalid local JSON: '+file);}}
export function planBackgroundInstall({browser,dataRoot,playwrightModule,userHome=os.userInfo().homedir}) {
  if(!['thorium','quark'].includes(browser))throw new Error('Choose --browser thorium or quark');
  if(!dataRoot||!path.isAbsolute(dataRoot))throw new Error('An absolute --data-root is required');
  const name=browser==='quark'?'Quark':'Thorium';
  const extensionDir=path.join(userHome,'AppData','Local',name,'Extensions','playwright-background');
  const agentDir=path.join(dataRoot,'browser-agent');
  const configFile=path.join(agentDir,'browser-config.json'),authFile=path.join(agentDir,'extension-auth.json');
  const pairingFile=path.join(extensionDir,'pi-background-pairing.json');
  const config=json(configFile)??{},auth=json(authFile),pairing=json(pairingFile);
  if(typeof config!=='object'||Array.isArray(config)||config.browser&&config.browser!==browser)throw new Error('Existing browser selection differs; refusing to overwrite machine-specific state');
  for(const value of [auth,pairing])if(value&&!/^[A-Za-z0-9_-]{43}$/.test(value.token))throw new Error('Invalid existing pairing; refusing credential replacement');
  if(auth&&pairing&&auth.token!==pairing.token)throw new Error('Existing local pairing mismatch; refusing credential replacement');
  const module=playwrightModule??config.playwrightModule;
  if(module) {
    if(!path.isAbsolute(module)||!fs.statSync(module).isFile())throw new Error('Configured Playwright module must be an existing absolute file');
    patchBackgroundBootstrap(fs.readFileSync(path.join(path.dirname(module),'lib/coreBundle.js'),'utf8'));
  }
  const token=auth?.token??pairing?.token??randomBytes(32).toString('base64url');
  const files=FILES.map(rel=>({file:path.join(extensionDir,rel),bytes:fs.readFileSync(path.join(root,'src/browser-agent/vendor/playwright-extension',rel))}));
  files.push({file:configFile,bytes:Buffer.from(JSON.stringify({...config,browser,...module?{playwrightModule:module}:{}},null,2)+'\n')});
  // Existing credential files are not rewritten, including unrelated metadata.
  if(!auth)files.push({file:authFile,bytes:Buffer.from(JSON.stringify({token})+'\n')});
  if(!pairing)files.push({file:pairingFile,bytes:Buffer.from(JSON.stringify({token})+'\n')});
  const changes=files.filter(({file,bytes})=>!fs.existsSync(file)||!fs.readFileSync(file).equals(bytes));
  return {browser,name,dataRoot,extensionDir,authFile,pairingFile,token,files,changes};
}
function runNode(args){const r=spawnSync(process.execPath,args,{windowsHide:true,shell:false,encoding:'utf8',timeout:15000});if(r.status!==0)throw new Error('Backup failed; no files changed: '+(r.error?.message||r.stdout||r.stderr));process.stdout.write(r.stdout);}
export function applyBackgroundInstall(plan) {
  const old=plan.changes.filter(x=>fs.existsSync(x.file)).map(x=>x.file);
  if(old.length)runNode([path.join(root,'tools/backup.mjs'),...old,'--label','background-browser-install']);
  for(const {file,bytes} of plan.changes){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o600});}
  if(process.platform==='win32')for(const file of [plan.authFile,plan.pairingFile]) {
    const r=spawnSync('icacls.exe',[file,'/inheritance:r','/grant:r',`${os.userInfo().username}:(F)`],{windowsHide:true,shell:false,encoding:'utf8',timeout:5000});
    if(r.status!==0)throw new Error('Pairing ACL setup failed: '+file+' '+(r.error?.message||r.stderr));
  }
  for(const {file,bytes} of plan.files)if(sha(fs.readFileSync(file))!==sha(bytes))throw new Error('Readback mismatch: '+file);
  if(json(plan.authFile).token!==plan.token||json(plan.pairingFile).token!==plan.token)throw new Error('Local pairing verification failed');
  console.log(JSON.stringify({installed:true,browser:plan.name,extensionDir:plan.extensionDir,version:json(path.join(plan.extensionDir,'manifest.json')).version,changedFiles:plan.changes.length,verifiedFiles:plan.files.length,credentials:'machine-local; not printed'}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);const browser=args[args.indexOf('--browser')+1],dataRoot=args[args.indexOf('--data-root')+1];
    if(!args.includes('--browser')||!args.includes('--data-root'))throw new Error('Usage: node tools/install-background-browser.mjs --browser quark|thorium --data-root <absolute Pi data path>');
    const playwrightModule=args.includes('--playwright-module')?args[args.indexOf('--playwright-module')+1]:undefined;
    const plan=planBackgroundInstall({browser,dataRoot,playwrightModule});
    if(!resolveDailyBrowserExecutable({id:browser}))throw new Error(`Daily ${plan.name} executable not found; refusing install in another browser`);
    applyBackgroundInstall(plan);
    const health=await ensureBackgroundBroker({dataRoot,authFile:plan.authFile,token:plan.token,requireExtension:false});
    console.log(JSON.stringify({brokerReady:true,extensionConnected:Date.now()-health.lastPoll<6000}));
    console.log(`First install: in ${plan.name}'s extension manager, enable Developer mode, Load unpacked, select ${plan.extensionDir}. Existing install: Reload this extension once. No browser restart is needed.`);
  } catch(e){console.error('[browser-install] '+e.message);process.exitCode=1;}
}
