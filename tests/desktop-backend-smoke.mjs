import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFetch } from '../src/desktop/local-http.mjs';

const packageRoot = fs.realpathSync(process.argv[2]);
const live = process.argv[3] && path.resolve(process.argv[3]);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-desktop-smoke-'));
const data = path.join(fixture, 'data');
const appHome = path.join(fixture, 'profile');
const agentDir = path.join(data, '.pi', 'agent');
const baseRoot = path.join(fixture, 'projects');
fs.mkdirSync(baseRoot, { recursive: true });
fs.mkdirSync(path.join(agentDir,'sessions'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'web-projects.json'), JSON.stringify({version:1, baseRoot, inbox:path.join(baseRoot,'inbox'), managed:false, projects:[], hidden:[]}));
if (live) {
  fs.mkdirSync(path.join(agentDir,'extensions'), { recursive: true });
  for (const name of ['codex-file-auth.json','extensions/codex-file-auth.ts']) fs.copyFileSync(path.join(live,name),path.join(agentDir,name));
  const provider = JSON.parse(fs.readFileSync(path.join(live,'models.json'),'utf8')).providers['openai-codex'];
  delete provider.apiKey;
  delete provider.headers;
  const modelId = 'gpt-6.2-sol';
  fs.writeFileSync(path.join(agentDir,'models.json'), JSON.stringify({providers:{'openai-codex':provider}}));
  fs.writeFileSync(path.join(agentDir,'settings.json'), JSON.stringify({defaultProvider:'openai-codex',defaultModel:modelId,transport:'auto'}));
}
const pipe = `\\\\.\\pipe\\piweb-desktop-smoke-${randomUUID()}`;
const secret = randomUUID();
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/desktop/backend.mjs', import.meta.url))], { windowsHide:true, stdio:['ignore','inherit','inherit','ipc'] });
const exit = new Promise(resolve => child.once('exit', resolve));
try {
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker timeout')), 18000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`worker exit ${code}`)); });
    child.once('message', event => { clearTimeout(timeout); if (event.type === 'ready') resolve(event); else reject(new Error(JSON.stringify(event))); });
  });
  child.send({ data, packageRoot, pipe, secret, accountHomes: live ? (process.argv[4] || path.resolve(live, '..', '..', 'homes')) : undefined, egress: live ? 10808 : 1, appHome });
  await ready;
  const read = (suffix, key = secret) => localFetch(`https://piweb.invalid${suffix}`, {signal: AbortSignal.timeout(6000)}, {socketPath:pipe}, {extraHeaders:{'x-pi-desktop-key':key}});
  const unauthorized = await read('/', 'incorrect');
  assert.equal(unauthorized.status, 403);
  const html = await read('/'); assert.equal(html.status, 200);
  const content = await html.text();
  const asset = content.match(/src="(\/_next\/static\/[^"]+\.js)"/u)?.[1];
  assert.ok(asset, 'no JavaScript in served document');
  for (const suffix of [asset, '/api/sessions', '/api/projects']) {
    const response = await read(suffix);
    const body = await response.text();
    assert.equal(response.status, 200, `${suffix} ${body.slice(0, 220)}`);
    assert.ok(body.length, suffix);
  }
  const tcp = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding:'utf8', windowsHide:true });
  assert.ok(!tcp.split(/\r?\n/u).some(line => new RegExp(`LISTENING\\s+${child.pid}\\s*$`).test(line)));
  console.log(`PASS: portless production Pi Web produced HTML, JS, session API and project API ${live ? 'in a clean fixture' : 'with unreachable proxy'}; wrong IPC key rejected; no TCP listener.`);
  console.log(`Fixture: ${fixture}`);
  if (live) {
    const call = async (route, body) => {
      const result = await localFetch(`https://piweb.invalid${route}`, {method:'POST',headers:{'content-type':'application/json',origin:'https://piweb.invalid'},body:JSON.stringify(body),signal:AbortSignal.timeout(18000)}, {socketPath:pipe}, {extraHeaders:{'x-pi-desktop-key':secret}});
      const json = await result.json();
      assert.ok(result.ok && json.success, `${route}: ${JSON.stringify(json).slice(0, 350)}`);
      return json;
    };
    const {sessionId} = await call('/api/agent/new',{type:'ensure_session',cwd:baseRoot,provider:'openai-codex',modelId:'gpt-6.2-sol'});
    const controller = new AbortController();
    try {
      const response = await localFetch(`https://piweb.invalid/api/agent/${sessionId}/events`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(40000)])},{socketPath:pipe},{extraHeaders:{'x-pi-desktop-key':secret}});
      assert.equal(response.status,200);
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/u);
      const marker='PI_DESKTOP_OK';
      const command = call(`/api/agent/${sessionId}`, {type:'prompt',message:`【测试任务】只回复 ${marker}，不要使用任何工具。`});
      let events='';
      const reader = response.body.getReader();
      const decoder=new TextDecoder();
      while (!events.includes('"type":"agent_end"')) {
        const next = await reader.read();
        if (next.done) break;
        events += decoder.decode(next.value,{stream:true});
      }
      await command;
      assert.match(events, new RegExp(`"(?:delta|text)":"${marker}`,'u'), events.slice(-900));
      const bridgeLog = fs.readFileSync(path.join(appHome,'runtime-data','codex-responses-proxy.log'),'utf8');
      assert.match(bridgeLog, /-> POST 200[^\r\n]*\begress=10808\b/u, 'No internal bridge 200 via configured proxy');
      console.log('PASS: real Pi agent prompt and SSE response via the in-process Codex bridge and the configured proxy.');
    } finally { controller.abort(); }
  }
} finally {
  if (child.connected) child.disconnect();
  // The IPC link is also the worker's parent-lifetime signal.
  await Promise.race([exit, new Promise(resolve => { setTimeout(() => { child.kill(); resolve(); }, 1500).unref(); })]);
}
