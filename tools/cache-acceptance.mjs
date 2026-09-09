// Paid, opt-in cache acceptance. Immutable payload, full provider usage, cold call included.
// node tools/cache-acceptance.mjs --payload file.json --out run-dir [--url http://127.0.0.1:8794/v1/responses]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1];};
const payloadFile=arg('payload'),out=arg('out');
if(!payloadFile||!out)throw new Error('--payload and --out required; no implicit paid calls');
fs.mkdirSync(out,{recursive:true});
const logFile=path.join(out,'requests.jsonl');
if(fs.existsSync(logFile))throw new Error('Output already contains requests; refusing to reset the denominator');
const body=fs.readFileSync(payloadFile,'utf8'),payload=JSON.parse(body),payloadHash=crypto.createHash('sha256').update(body).digest('hex');
const extraHeaders=arg('headers')?JSON.parse(fs.readFileSync(arg('headers'),'utf8')):{};
if(Object.keys(extraHeaders).some(k=>!['session-id','x-client-request-id','accept'].includes(k)))throw new Error('Only non-secret Codex session headers are accepted');
const url=arg('url','http://127.0.0.1:8794/v1/responses');
if(!/^http:\/\/127\.0\.0\.1:\d+\//.test(url))throw new Error('Only the local managed bridge is allowed');
const target=.95,minRequests=Number(arg('min-requests','25')),maxRequests=Number(arg('max-requests','100'));
const inputBudget=Number(arg('input-budget','600000')),outputBudget=Number(arg('output-budget','5000'));
let sumInput=0,sumCache=0,sumOutput=0,failures=0,passed=false,n=0,stopReason=null;
const report=()=>({requests:n,failures,inputTokens:sumInput,cachedInputTokens:sumCache,outputTokens:sumOutput,hitRate:sumInput?sumCache/sumInput:0,target,passed,payloadHash,model:payload.model,reasoning:payload.reasoning,includesColdStart:true,originator:arg('originator','evox'),stopReason});
fs.writeFileSync(path.join(out,'contract.json'),JSON.stringify({target,minRequests,maxRequests,inputBudget,outputBudget,includesColdStart:true,immutablePayload:true,requiresCompletedUsage:true,requiresExactModel:true,requiresText:'OK',url,payloadHash},null,2));
for(n=1;n<=maxRequests;n++){
 const started=Date.now();let usage=null,responseModel=null,text='',responseId=null,error=null,status=null,terminal=false,providerFailure=false;
 try {
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer local-cache-acceptance-probe','originator':arg('originator','evox'),'OpenAI-Beta':'responses=experimental',...extraHeaders},body,signal:AbortSignal.timeout(90000)});status=res.status;
  if(!res.ok){await res.arrayBuffer();throw new Error('HTTP '+status);}
  let pending='';const decoder=new TextDecoder();
  const consume=line=>{if(!line.startsWith('data:'))return;const data=line.slice(5).trim();if(!data||data==='[DONE]')return;let e;try{e=JSON.parse(data);}catch{return;}
   if(e.type==='response.output_text.delta')text+=e.delta||'';
   if(e.type==='response.failed'||e.type==='error'){providerFailure=true;error='provider '+e.type;}
   if((e.type==='response.completed'||e.type==='response.done')&&e.response){terminal=true;usage=e.response.usage;responseModel=e.response.model;responseId=e.response.id;if(!text)text=(e.response.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text||'').join('');}
  };
  for await(const chunk of res.body){pending+=decoder.decode(chunk,{stream:true});let p;while((p=pending.indexOf('\n'))>=0){consume(pending.slice(0,p).replace(/\r$/,''));pending=pending.slice(p+1);}}consume(pending);
  if(!terminal||!usage)throw new Error('missing completed provider usage');
  if(responseModel!==payload.model)throw new Error('model mismatch: '+responseModel);
  if(text.trim()!=='OK')throw new Error('non-minimal output');
  if(providerFailure)throw new Error(error);
 }catch(e){error=e.message;}
 const input=usage?.input_tokens,cache=usage?.input_tokens_details?.cached_tokens,output=usage?.output_tokens;
 if(usage){if(!Number.isFinite(input)||!Number.isFinite(cache)||!Number.isFinite(output)||input<=0||cache<0||cache>input){error='invalid provider usage';}else{sumInput+=input;sumCache+=cache;sumOutput+=output;}}
 if(error)failures++;
 const row={n,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,status,error,responseId,responseModel,inputTokens:input??null,cachedInputTokens:cache??null,outputTokens:output??null,reasoningTokens:usage?.output_tokens_details?.reasoning_tokens??null,hitRate:sumInput?sumCache/sumInput:0,cumulativeInput:sumInput,cumulativeCache:sumCache,payloadHash};
 fs.appendFileSync(logFile,JSON.stringify(row)+'\n');console.log(JSON.stringify(row));
 passed=failures===0&&n>=minRequests&&sumInput>0&&sumCache/sumInput>=target;
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report(),null,2));
 if(passed||failures||sumInput>=inputBudget||sumOutput>=outputBudget||(n>=Number(arg('zero-hit-limit','8'))&&sumCache===0)){
  stopReason=passed?'target-met':failures?'request-failed':sumInput>=inputBudget||sumOutput>=outputBudget?'budget-limit':'zero-hit-limit';break;
 }
 if(n<maxRequests)await new Promise(r=>setTimeout(r,Number(arg('delay-ms','1500'))));
}
if(n>maxRequests)n=maxRequests;
if(!passed&&!stopReason)stopReason='max-requests';
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report(),null,2));
console.log(JSON.stringify({final:true,...report()}));process.exitCode=passed?0:1;
