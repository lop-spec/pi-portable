import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSystemProxy, readSystemProxy, createSystemProxyFollower } from '../src/system-proxy.mjs';
import { detectEgress } from '../src/egress-autodetect.mjs';
const registry = (server, enabled = '0x1') => `\n ProxyEnable REG_DWORD ${enabled}\n ProxyServer REG_SZ ${server}\n`;

test('reads HTTPS-specific or unified endpoints, IPv6, and explicit system-direct', () => {
  assert.equal(parseSystemProxy(registry('127.0.0.1:7899')).port, 7899);
  const value = parseSystemProxy(registry('http=127.0.0.1:18799;https=proxy.lan:7899;socks=localhost:1080'));
  assert.equal(value.host, 'proxy.lan'); assert.equal(value.port, 7899);
  assert.equal(parseSystemProxy(registry('[::1]:7899')).host, '::1');
  assert.equal(parseSystemProxy(registry('127.0.0.1:18799', '0x0')).mode, 'direct');
});
test('invalid, unsupported, and PAC-only configurations are explicit errors', () => {
  for (const text of ['', registry('socks=localhost:1080'), registry('https://proxy:443'), registry('bad:70000'), registry('')+' AutoConfigURL REG_SZ https://example.test/proxy.pac\n'].slice(0,4)) assert.throws(()=>parseSystemProxy(text));
  assert.throws(()=>parseSystemProxy(registry('', '0x0')+' AutoConfigURL REG_SZ https://example.test/proxy.pac\n'), /pac-not-supported/);
});
test('registry query is hidden, bounded, and does not launch a shell', async () => {
  const v = await readSystemProxy({platform:'win32',run:async(file,args,opts)=>{
    assert.equal(file,'reg.exe');assert.equal(args[0],'query');assert.equal(opts.windowsHide,true);assert.equal(opts.timeout,2500);
    return {stdout:registry('127.0.0.1:7899')};
  }});assert.equal(v.port,7899);
  assert.equal(await readSystemProxy({platform:'linux',run:()=>assert.fail('unexpected subprocess')}),null);
});
test('follows 18799 -> 7899 -> direct without restart and retains last endpoint on failure with a reason', async () => {
  let current=parseSystemProxy(registry('127.0.0.1:18799')),calls=0;const logs=[];
  const f=createSystemProxyFollower({read:async()=>{calls++;if(current instanceof Error)throw current;return current;},log:s=>logs.push(s)});
  await f.refresh();assert.equal(f.snapshot().port,18799);
  current=parseSystemProxy(registry('127.0.0.1:7899'));await f.refresh();assert.equal(f.snapshot().port,7899);
  current=new Error('system-proxy-endpoint-invalid');await f.refresh();assert.equal(f.snapshot().port,7899);assert.match(logs.at(-1),/endpoint-invalid.*retained/);
  current=parseSystemProxy(registry('', '0x0'));await f.refresh();assert.equal(f.snapshot().port,0);assert.equal(calls,4);f.stop();
});
test('overlapping polls coalesce', async () => {
  let release,calls=0;const f=createSystemProxyFollower({read:async()=>{calls++;await new Promise(r=>release=r);return parseSystemProxy(registry('localhost:7899'));},log:()=>{}});
  const a=f.refresh(),b=f.refresh();release();await Promise.all([a,b]);assert.equal(calls,1);
});
test('system endpoint supersedes saved stale port without modifying user egress file', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-system-egress-'));
  const p=path.join(root,'egress.json'),raw=JSON.stringify({mode:'proxy',port:18799});fs.writeFileSync(p,raw);
  const prev=process.env.CODEX_FOLLOW_SYSTEM_PROXY;process.env.CODEX_FOLLOW_SYSTEM_PROXY='1';
  try { const v=await detectEgress(root,{systemProxy:async()=>parseSystemProxy(registry('localhost:7899'))});assert.equal(v.port,7899);assert.equal(fs.readFileSync(p,'utf8'),raw); }
  finally { if(prev===undefined)delete process.env.CODEX_FOLLOW_SYSTEM_PROXY;else process.env.CODEX_FOLLOW_SYSTEM_PROXY=prev;fs.unlinkSync(p);fs.rmdirSync(root); }
});
