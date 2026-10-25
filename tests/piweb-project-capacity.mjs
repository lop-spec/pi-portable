import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {ProjectStore,atomicWrite} from '../assets/piweb-overlay/portable-project-store.mjs';
import {STANDARD_PROJECTS,createProject,sessionIndex,sessionAssignments} from '../assets/piweb-overlay/project-routing.mjs';
import {planProjectMerge,mergeManagedProjects} from '../assets/piweb-overlay/project-capacity.mjs';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-capacity-')),agentDir=path.join(root,'agent'),baseRoot=path.join(root,'projects');fs.mkdirSync(path.join(agentDir,'sessions'),{recursive:true});const registry=new ProjectStore(path.join(agentDir,'web-projects.json'));atomicWrite(registry.file,JSON.stringify({version:1,managed:true,projects:[],hidden:[],baseRoot,inbox:path.join(root,'inbox')}));for(const name of STANDARD_PROJECTS)createProject(agentDir,name);return{root,agentDir,baseRoot,registry};}
test('there are exactly eight standard scopes, and a ninth never creates a directory',()=>{const f=fixture();assert.equal(STANDARD_PROJECTS.length,8);assert.throws(()=>createProject(f.agentDir,'全新独立主题'),/8/);assert.equal(fs.existsSync(path.join(f.baseRoot,'全新独立主题')),false);assert.equal(f.registry.read().projects.length,8);});
test('hidden projects count toward the cap, restoration neither loses a name nor creates an extra slot',()=>{const f=fixture(),p=f.registry.read().projects[0];f.registry.remove(p.root);assert.equal(f.registry.read().projects.length,8);assert.equal(f.registry.read().hidden.length,1);assert.throws(()=>f.registry.add(path.join(f.root,'other'),undefined,true),/8/);f.registry.add(p.root);assert.equal(f.registry.read().projects.length,8);assert.equal(f.registry.read().hidden.length,0);});
test('only the resulting name is required to select related projects deterministically',()=>{const f=fixture();assert.deepEqual(planProjectMerge(f.registry.read(),'Windows与Android').projects.map(p=>p.name).sort(),['Android','Windows']);assert.deepEqual(planProjectMerge(f.registry.read(),'多媒体创作').projects.map(p=>p.name),['图像与视频']);assert.throws(()=>planProjectMerge(f.registry.read(),'不相关名称'),/覆盖现有项目/);});
test('merges real folders and transcripts, keeps native cwd relative to source assets, updates IDs/indexes and remains below eight',async()=>{
 const f=fixture(),all=[];const history='{"type":"message","id":"a","message":{"role":"user","content":"历史不变"}}\n';
 for(const [index,name]of ['Windows','Android'].entries()){
  const cwd=path.join(f.baseRoot,name),file=path.join(cwd,'会话','s-'+index+'.jsonl'),id='sid-'+index;
  fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id,cwd})+'\n'+history);fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src/code.txt'),name);
  all.push({id,cwd,path:file});
 }
 const plan=planProjectMerge(f.registry.read(),'Windows与Android');const result=await mergeManagedProjects({agentDir:f.agentDir,name:plan.name,projects:plan.projects,sessions:all});
 assert.equal(f.registry.read().projects.length,7);assert.equal(result.merged.length,2);
 for(const s of all){const file=path.join(result.cwd,'会话',path.basename(s.path)),bytes=fs.readFileSync(file,'utf8'),header=JSON.parse(bytes.split('\n')[0]);assert.equal(bytes.slice(bytes.indexOf('\n')+1),history);assert.equal(header.id,s.id);assert.equal(fs.readFileSync(path.join(header.cwd,'src/code.txt'),'utf8'),path.basename(s.cwd));assert.equal(fs.realpathSync(s.cwd),header.cwd);assert.equal(sessionAssignments(f.agentDir)[s.id].root,result.cwd);assert.equal(path.relative(f.baseRoot,file).split(path.sep).length,3);}
 assert.equal(fs.realpathSync(sessionIndex(f.agentDir,result.cwd)),path.join(result.cwd,'会话'));
 assert.ok(!fs.existsSync(sessionIndex(f.agentDir,all[0].cwd)));
 createProject(f.agentDir,'新任务');assert.equal(f.registry.read().projects.length,8);assert.throws(()=>createProject(f.agentDir,'第九个'),/8/);
});
test('a broader resulting name can merge an incoming topic into one existing scope without creating number nine',async()=>{const f=fixture(),plan=planProjectMerge(f.registry.read(),'多媒体创作');await mergeManagedProjects({agentDir:f.agentDir,name:plan.name,projects:plan.projects,sessions:[]});assert.equal(f.registry.read().projects.length,8);assert.ok(f.registry.read().projects.some(p=>p.name==='多媒体创作'));assert.ok(!f.registry.read().projects.some(p=>p.name==='图像与视频'));});
