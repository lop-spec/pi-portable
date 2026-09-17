import fs from 'node:fs';
import path from 'node:path';
const validId=id=>typeof id==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id);
// Operational identity only. Native CLIs own the dialogue/history and compaction.
export function reviewSessionBinding(work){
  const file=path.join(work,'review-session.json');
  let saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(saved&&!validId(saved.id))throw Error('Invalid fixed review session identity: '+file);
  return {
    get id(){return saved?.id},
    args(kind){
      if(!saved)return kind==='astra'?['--continue']:[]; // Adopt existing Pi history; first Claude run creates its one dialogue.
      if(kind==='astra'){
        if(!saved.file||!fs.existsSync(saved.file))throw Error('Pinned Astra review session is missing; refusing to create another dialogue');
        return ['--session',saved.file];
      }
      if(kind==='fable')return ['--resume',saved.id];
      throw Error('Unknown reviewer kind');
    },
    bind(id,sessionFile){
      if(!validId(id))throw Error('Native CLI returned no valid review session ID');
      if(saved&&saved.id!==id)throw Error('Review session changed unexpectedly: '+saved.id+' -> '+id);
      if(!saved){
        const value={id,...(sessionFile?{file:sessionFile}:{})};
        fs.mkdirSync(work,{recursive:true});const tmp=file+'.'+process.pid+'.tmp';
        fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);
        saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.id!==id)throw Error('Review session identity readback mismatch');
      }
      return saved.id;
    }
  };
}
