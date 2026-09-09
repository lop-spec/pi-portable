import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-acceptance-contract-'));
const payload=path.join(root,'payload.json');fs.writeFileSync(payload,JSON.stringify({model:'gpt-5.6-sol',reasoning:{effort:'high'},input:[{role:'user',content:'OK'}]}));
async function probe(name,mode){let calls=0;const server=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{'content-type':'text/event-stream'});const usage=mode==='missing'?undefined:{input_tokens:1000,output_tokens:1,input_tokens_details:{cached_tokens:mode==='low'?900:calls===1?0:1000}};res.end('data: '+JSON.stringify({type:'response.completed',response:{id:'mock-'+calls,model:mode==='wrong-model'?'other':'gpt-5.6-sol',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}],usage}})+'\n\n');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const out=path.join(root,name);const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/cache-acceptance.mjs',import.meta.url)),'--payload',payload,'--out',out,'--url',`http://127.0.0.1:${server.address().port}/v1/responses`,'--max-requests','26','--delay-ms','0'],{windowsHide:true,stdio:'ignore'});const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r)});await new Promise(r=>server.close(r));return{code,calls,result:JSON.parse(fs.readFileSync(path.join(out,'summary.json'))),rows:fs.readFileSync(path.join(out,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};}
const cold=await probe('cold-included','normal');assert.equal(cold.code,0);assert.equal(cold.calls,25);assert.equal(cold.result.inputTokens,25000);assert.equal(cold.result.cachedInputTokens,24000);assert.equal(cold.result.hitRate,.96);assert.equal(cold.rows[0].cachedInputTokens,0);console.log('PASS cold start counted; exits only after cumulative target');
for(const mode of ['low','missing','wrong-model']){const r=await probe(mode,mode);assert.equal(r.code,1);assert.equal(r.result.passed,false);assert.ok(r.result.stopReason);console.log('PASS rejects '+mode);}
console.log('PASS 4 acceptance contracts; artifacts '+root);
