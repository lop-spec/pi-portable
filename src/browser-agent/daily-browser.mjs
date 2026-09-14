import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolveThoriumExecutable} from '../thorium-browser.mjs';

// This file selects an explicitly paired daily browser, not a launch/fallback chain.
// Machine-local selection is never synchronized together with source code.
export function readDailyBrowserSelection({dataRoot, userHome=os.userInfo().homedir}={}) {
  const file=path.join(dataRoot,'browser-agent','browser-config.json');
  let config={};
  try {config=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error) {
    if(error.code!=='ENOENT') {
      console.error('[browser] daily-browser-config-invalid: '+error.message);
      throw new Error('Invalid machine-local browser configuration; refusing another browser');
    }
  }
  const id=config?.browser??'thorium';
  if(!config || typeof config!=='object' || Array.isArray(config) || !['thorium','quark'].includes(id)) {
    console.error('[browser] daily-browser-config-unsupported');
    throw new Error('browser-config.json browser must be thorium or quark; no fallback is allowed');
  }
  if(config.playwrightModule!==undefined && (typeof config.playwrightModule!=='string'||!path.isAbsolute(config.playwrightModule))) {
    console.error('[browser] playwright-module-config-invalid');
    throw new Error('Configured playwrightModule must be an absolute file path');
  }
  const name=id==='quark'?'Quark':'Thorium';
  return {id,name,profileDir:path.join(userHome,'AppData','Local',name,'User Data'),playwrightModule:config.playwrightModule};
}

export async function resolveDailyPlaywrightModule(selection,resolve) {
  if(selection.playwrightModule) {
    try {if(!fs.statSync(selection.playwrightModule).isFile())throw new Error('not a file');}
    catch(error) {
      console.error('[browser] configured-playwright-unavailable: '+(error.code||error.message));
      throw new Error('Configured Playwright module is unavailable; refusing version fallback');
    }
  }
  return resolve(selection.playwrightModule);
}

export function queryQuarkAppPath({run=spawnSync,platform=process.platform}={}) {
  if(platform!=='win32')return null;
  for(const hive of ['HKCU','HKLM']) {
    const result=run('reg.exe',['query',`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\quark.exe`,'/ve'],{windowsHide:true,shell:false,encoding:'utf8',timeout:3000});
    if(result.error)throw new Error('Quark App Paths lookup failed: '+result.error.message);
    if(result.status!==0)continue; // An absent key is normal; no other browser is selected.
    const match=result.stdout.match(/REG_SZ\s+([^\r\n]+)/);
    if(match)return match[1].trim().replace(/^"(.*)"$/,'$1');
  }
  return null;
}

export function resolveDailyBrowserExecutable(selection,{env=process.env,exists=fs.existsSync,userHome=os.userInfo().homedir,queryAppPath=queryQuarkAppPath}={}) {
  if(selection.id==='thorium')return resolveThoriumExecutable({env,exists,userHome});
  if(selection.id!=='quark')throw new Error('Unsupported daily browser');
  const registered=queryAppPath();
  const roots=[path.join(userHome,'AppData','Local'),env.ProgramFiles||'C:/Program Files',env['ProgramFiles(x86)']||'C:/Program Files (x86)'];
  const candidates=[registered,...roots.flatMap(root=>[path.join(root,'Quark','quark.exe'),path.join(root,'Quark','Application','quark.exe')])].filter(Boolean);
  return candidates.find(file=>exists(file))??null;
}
