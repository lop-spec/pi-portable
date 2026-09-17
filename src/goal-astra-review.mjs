import fs from 'node:fs';
import path from 'node:path';
import {ROOT,HERE,site,run,entries,textOf} from './goal-inspect.mjs';
import {reviewSessionBinding} from './goal-review-session.mjs';
export function astraCli(){
  const runtime=path.dirname(site().data);
  const webPackage=fs.realpathSync(path.join(runtime,'app/node_modules/@agegr/pi-web/package.json'));
  const pkgFile=path.resolve(path.dirname(webPackage),'../../@earendil-works/pi-coding-agent/package.json');
  const pkg=JSON.parse(fs.readFileSync(pkgFile,'utf8'));
  const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin.pi;
  const cli=path.resolve(path.dirname(pkgFile),bin);if(!fs.existsSync(cli))throw Error('Active Pi CLI entry missing');return cli;
}
export async function astraReview(prompt,log){
  const work=path.join(site().data,'goal-review','astra-cli'),sessionDir=path.join(work,'sessions');fs.mkdirSync(sessionDir,{recursive:true});
  const auth=path.join(site().agent,'extensions','codex-file-auth.ts');if(!fs.existsSync(auth))throw Error('Native Codex authentication extension not found; no auth fallback');
  const env={...process.env,PI_CODING_AGENT_DIR:site().agent,PI_PORTABLE_DATA:site().data,PI_PORTABLE_HOME:ROOT};
  // Isolate only review tools, NOT login state. No tools/extensions are installed into ordinary sessions.
  const binding=reviewSessionBinding(work);
  const args=[astraCli(),'--print','--mode','json','--provider','openai-codex','--model','gpt-6-astra','--thinking','low',...binding.args('astra'),'--session-dir',sessionDir,'--name','长目标巡检 · Astra low · '+HERE,'--no-extensions','--extension',auth,'--extension',path.join(ROOT,'src/goal-review-tool.mjs'),'--tools','goal_inspect','--no-skills'];
  let final,id,lastActivity=Date.now();
  const heartbeat=setInterval(()=>log('review-progress',{profile:'astra',reviewSession:id,lastActivity}),20000);
  log('review-started',{profile:'astra',model:'gpt-6-astra',effort:'low',transport:'native-cli',sessionDir});
  try{
    const r=await run(process.execPath,args,{env,cwd:work,input:prompt,timeout:35*60000,onLine:line=>{
      let e;try{e=JSON.parse(line)}catch{return}lastActivity=Date.now();
      if(e.type==='session')id=e.id;
      if(e.type==='message_end'&&e.message?.role==='assistant')final=e.message;
      if(e.type==='tool_execution_start')log('review-tool',{profile:'astra',tool:e.toolName,op:e.args?.op,path:e.args?.path,sessionId:e.args?.id,offset:e.args?.offset});
      if(e.type==='tool_execution_end'&&e.isError)log('review-tool-failed',{profile:'astra',tool:e.toolName,reason:textOf(e.result).slice(0,400)});
    }});
    if(!final||['error','aborted','length'].includes(final.stopReason))throw Error('Astra review did not complete: '+(final?.errorMessage||final?.stopReason||r.err.slice(-500)));
    if(final.model!=='gpt-6-astra')throw Error('Astra response model mismatch: '+final.model);
    const file=fs.readdirSync(sessionDir).find(f=>f.endsWith('_'+id+'.jsonl'));if(!file)throw Error('Native review session file not found');
    binding.bind(id,path.join(sessionDir,file));
    log('review-session',{profile:'astra',reviewSession:id});
    const all=entries(path.join(sessionDir,file));const effort=all.findLast(e=>e.type==='thinking_level_change')?.thinkingLevel;
    if(effort!=='low')throw Error('Astra thinking-level transcript mismatch: '+effort);
    return {text:textOf(final),reviewSession:id,model:final.model,effort};
  }finally{clearInterval(heartbeat)}
}
