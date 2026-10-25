// Deterministic bounded consolidation. The model supplies only the resulting name.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import { atomicWrite, projectKey, prepareSessionHeader, commitSessionHeaders, restoreSessionHeaders, writeHeaderJournal } from './portable-project-store.mjs';
import { routingLayout, validProjectName, sessionIndex, ensureSessionIndex, sessionAssignments, pathAliases } from './project-routing.mjs';
export const MAX_PROJECTS = 8;
export function projectScope(name) {
 const tags=new Set(),text=String(name).toLowerCase();
 const rules=[['browser',/浏览器|browser|极速/],['pi',/\bpi\b|pi-web|规则|扩展|提示词|模型/],['windows',/windows|桌面|电脑|远程/],['android',/android|安卓|手机|移动应用/],['stock',/股票|回测|投资|量化|金融/],['media',/图像|图文|视频|创意|创作|多媒体|音频|绘画|生成|内容/],['ops',/运维|数据库|数据运维|sql|mysql|mongo|redis/],['life',/生活|购物|选品|社交|旅行|消费|选购|日常/]];
 for(const [tag,re] of rules)if(re.test(text))tags.add(tag);
 if([...tags].some(t=>['browser','pi','windows','android'].includes(t))||/开发|研发|软件|系统|技术/.test(text))tags.add('dev');
 if(/系统/.test(text)){tags.add('windows');tags.add('android');}
 return tags;
}
export function planProjectMerge(data, value) {
 const name=validProjectName(value),wanted=projectScope(name);
 const ranked=data.projects.map(project=>({project,score:[...projectScope(project.name??path.basename(project.root))].reduce((sum,tag)=>sum+(wanted.has(tag)?tag==='dev'?1:4:0),0)}));
 const score=Math.max(0,...ranked.map(p=>p.score));
 if(!score)throw new Error('合并后的名称必须覆盖现有项目的范围；可选范围：'+data.projects.map(p=>p.name??path.basename(p.root)).join('、'));
 const selected=ranked.filter(p=>p.score===score).map(p=>p.project);
 return {name,projects:selected,target:path.join(data.baseRoot,name)};
}
const inside=(root,file)=>{const rel=path.relative(projectKey(root),projectKey(file));return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
export async function mergeManagedProjects({agentDir,name,sessions,projects}) {
 const layout=routingLayout(agentDir),target=path.join(layout.baseRoot,validProjectName(name));
 if(!projects.length)throw Error('没有可合并的项目');
 const selected=new Set(projects.map(p=>p.key));
 if(projects.some(p=>path.dirname(path.resolve(p.root))!==layout.baseRoot))throw Error('只能合并受管的单层项目');
 const existingTarget=layout.data.projects.find(p=>projectKey(p.root)===projectKey(target));
 if(fs.existsSync(target)&&!existingTarget)throw Error('目标目录已存在但未登记，拒绝覆盖');
 if(existingTarget&&!selected.has(existingTarget.key))throw Error('同名目标不在合并范围内');
 const sources=projects.filter(p=>projectKey(p.root)!==projectKey(target));
 if(!sources.length)return {...layout.data,cwd:target,changed:false,sessionIds:[]};
 const assigned=sessionAssignments(agentDir),aliases=pathAliases(agentDir);
 const affected=sessions.filter(s=>projects.some(p=>inside(p.root,s.cwd))||assigned[s.id]&&selected.has(projectKey(assigned[s.id].root)));
 const records=affected.map(s=>({s,real:fs.realpathSync(s.path),target:path.join(target,'会话',path.basename(s.path))}));
 for(const p of projects){const dir=path.join(p.root,'会话');if(fs.existsSync(dir))for(const file of fs.readdirSync(dir).filter(file=>file.endsWith('.jsonl')))if(!records.some(r=>projectKey(r.real)===projectKey(fs.realpathSync(path.join(dir,file)))))throw Error('项目有尚未识别的会话，拒绝遗漏：'+file);}
 const targetNames=new Set();for(const r of records){const key=projectKey(r.target);if(targetNames.has(key))throw Error('会话文件名冲突，拒绝覆盖');targetNames.add(key);if(fs.existsSync(r.target)&&projectKey(r.real)!==key)throw Error('目标已有同名会话，拒绝覆盖');}
 const folders=sources.map(p=>({from:p.root,to:path.join(target,'资料-'+path.basename(p.root))}));
 for(const f of folders)if(fs.existsSync(f.to))throw Error('资料目录冲突，拒绝覆盖：'+f.to);
 const remapCwd=cwd=>{const f=folders.find(f=>inside(f.from,cwd));return f?path.join(f.to,path.relative(f.from,cwd)):cwd;};
 const sessionRoot=path.join(agentDir,'sessions');
 const prepared=affected.map(s=>prepareSessionHeader(s.path,s.id,remapCwd(s.cwd),sessionRoot,false)).filter(p=>p.changed);
 const journal=prepared.length?writeHeaderJournal(sessionRoot,prepared):null;
 const stateFiles=[layout.registry.file,path.join(agentDir,'session-projects.json'),path.join(agentDir,'session-path-aliases.json'),path.join(agentDir,'session-archive.json')];
 const snapshots=stateFiles.map(file=>({file,bytes:fs.existsSync(file)?fs.readFileSync(file):null}));
 const archive=snapshots[3].bytes?JSON.parse(snapshots[3].bytes.toString('utf8')):null;
 const movedFolders=[],movedFiles=[],links=[];
 try{
  fs.mkdirSync(path.join(target,'会话'),{recursive:true});
  for(const f of folders){fs.renameSync(f.from,f.to);movedFolders.push(f);}
  for(const r of records){
   const f=folders.find(f=>inside(f.from,r.real));const current=f?path.join(f.to,path.relative(f.from,r.real)):r.real;
   if(projectKey(current)!==projectKey(r.target)){fs.renameSync(current,r.target);movedFiles.push({from:current,to:r.target});}
  }
  for(const item of prepared)item.file=path.join(target,'会话',path.basename(item.file));
  await commitSessionHeaders(prepared,journal);
  const key=projectKey(target),data={...layout.data,projects:[...layout.data.projects.filter(p=>!selected.has(p.key)),{key,root:target,name:path.basename(target)}],hidden:layout.data.hidden.filter(k=>!selected.has(k))};
  if(data.projects.length>MAX_PROJECTS)throw Error('项目总数仍超过 8 个');
  layout.registry.save(data);
  ensureSessionIndex(agentDir,target,path.join(target,'会话'));
  for(const r of records){
   const previous=assigned[r.s.id];assigned[r.s.id]={...previous,root:target,path:r.target,originalCwd:previous?.originalCwd??r.s.cwd};
   aliases[r.s.path]=r.target;aliases[r.real]=r.target;
   if(archive?.sessions?.[r.s.id])Object.assign(archive.sessions[r.s.id],{relativePath:path.relative(sessionRoot,path.join(sessionIndex(agentDir,target),path.basename(r.target))).split(path.sep).join('/'),cwd:remapCwd(r.s.cwd)});
  }
  for(const [old,value]of Object.entries(aliases)){const match=records.find(r=>projectKey(r.real)===projectKey(value)||projectKey(r.s.path)===projectKey(value));if(match)aliases[old]=match.target;}
  atomicWrite(stateFiles[1],JSON.stringify(assigned,null,2));atomicWrite(stateFiles[2],JSON.stringify(aliases,null,2));if(archive)atomicWrite(stateFiles[3],JSON.stringify(archive,null,2));
  for(const f of folders){const oldSessions=path.join(f.to,'会话');if(fs.existsSync(oldSessions)&&!fs.readdirSync(oldSessions).length)fs.rmdirSync(oldSessions);fs.symlinkSync(path.resolve(f.to),f.from,process.platform==='win32'?'junction':'dir');links.push(f.from);}
  for(const p of sources){const index=sessionIndex(agentDir,p.root);try{if(fs.lstatSync(index).isSymbolicLink())fs.unlinkSync(index);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return {...data,cwd:target,previousRoots:projects.map(p=>p.root),sessionIds:affected.map(s=>s.id),merged:projects.map(p=>p.name??path.basename(p.root)),changed:true,preserved:true};
 }catch(error){
  for(const link of links.reverse())fs.unlinkSync(link);
  await restoreSessionHeaders(prepared,journal);
  for(const f of movedFiles.reverse()){fs.mkdirSync(path.dirname(f.from),{recursive:true});fs.renameSync(f.to,f.from);}
  for(const f of movedFolders.reverse())fs.renameSync(f.to,f.from);
  for(const saved of snapshots){if(saved.bytes)atomicWrite(saved.file,saved.bytes);else fs.rmSync(saved.file,{force:true});}
  if(!existingTarget){try{const index=sessionIndex(agentDir,target);if(fs.lstatSync(index).isSymbolicLink())fs.unlinkSync(index);}catch{}try{fs.rmdirSync(path.join(target,'会话'));fs.rmdirSync(target);}catch{}}
  throw error;
 }
}
