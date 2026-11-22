import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { GOAL_ORIGIN, goalFetch, isGoalUrl } from '../../src/desktop/goal-transport.mjs';
import { installDesktopLinks } from '../../src/desktop/links.mjs';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pi-goal-electron-')));
app.commandLine.appendSwitch('no-proxy-server');
const log = message => { if (process.env.PI_GOAL_ELECTRON_LOG) fs.appendFileSync(process.env.PI_GOAL_ELECTRON_LOG, `${message}\n`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const parentOrigin = 'https://piweb.invalid';
const source = fs.readFileSync(new URL('../../src/piweb-archive-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('// Long-goal board:');
const end = source.indexOf('// File-preview links', start);
assert.ok(start >= 0 && end > start);
const goalUi = source.slice(start, end);
const parentPage = `<!doctype html><html><head><style>[hidden]{display:none!important}</style></head><body><script>window.__piUiSlots={register(c){document.body.append(c.host)}};</script><script>${goalUi}</script></body></html>`;
const boardPage = `<!doctype html><html><body><h1>test board</h1><script>
(async()=>{const s=await(await fetch('/api/session')).json();const d=await(await fetch('/api/overview')).json();
const p=await fetch('/api/act',{method:'POST',headers:{'content-type':'application/json','x-goal-token':s.token},body:'{}'});
window.testResult={writable:s.writable,count:d.goals.length,post:p.status,origin:location.origin};parent.postMessage({type:'goal-board-mode',writable:s.writable},'*')})()
</script></body></html>`;
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ method: req.method, url: req.url, origin: req.headers.origin, token: req.headers['x-goal-token'] });
  if (req.url.startsWith('/?')) { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(boardPage); }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/health') { res.setHeader('access-control-allow-origin', '*'); return res.end('{"ok":true}'); }
  if (req.url === '/api/session') return res.end('{"writable":true,"token":"fixture-token"}');
  if (req.url === '/api/overview') return res.end('{"goals":[{},{}]}');
  if (req.url === '/api/act') { res.statusCode = req.headers.origin === `http://127.0.0.1:${port}` && req.headers['x-goal-token'] === 'fixture-token' ? 400 : 403; return res.end('{}'); }
  res.statusCode = 404; res.end('{}');
});
let port, win;
const real = process.env.PI_GOAL_REAL === '1';
void app.whenReady().then(async () => {
 try {
  // The regular regression starts offline; the optional real run is read-only.
  log('app ready');
  if (real) port = 30170;
  else {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
    await new Promise(resolve => server.close(resolve));
  }
  win = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  win.webContents.on('console-message', (_event, _level, message) => log(`console ${message}`));
  installDesktopLinks(win.webContents, {origin:parentOrigin, openExternal:async()=>{}, openLocal:async()=>{}, onError:error=>{throw error;}});
  const ses = win.webContents.session;
  ses.webRequest.onBeforeRequest((details, cb) => cb({cancel: !(details.url.startsWith(parentOrigin + '/') || isGoalUrl(details.url) || /^(?:data|blob):/.test(details.url))}));
  ses.protocol.handle('https', request => {
    if (isGoalUrl(request.url)) return goalFetch(request, {port});
    if (request.url === parentOrigin + '/') return new Response(parentPage, {headers:{'content-type':'text/html; charset=utf-8'}});
    return new Response(null, {status:403});
  });
  await win.loadURL(parentOrigin + '/'); log('page loaded');
  await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"长目标看板\"]').click()");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#pi-goal-board a').href"), 'http://127.0.0.1:30170/');
  if (real) {
    let board;
    for (let i = 0; i < 75; i++) {
      await pause(200);
      const frame = win.webContents.mainFrame.frames.find(f => f.url.startsWith(GOAL_ORIGIN + '/'));
      if (frame) {
        try { board = await frame.executeJavaScript("(async()=>{const r=await fetch('/api/overview');const d=await r.json();return {status:r.status,version:d.version,count:d.goals?.length,rendered:!!document.querySelector('#main')?.innerText.includes('目标')}})()"); } catch {}
        if (board?.rendered && board.count > 0) break;
      }
    }
    assert.equal(board?.status, 200); assert.ok(board.count > 0 && board.rendered);
    assert.match(await win.webContents.executeJavaScript("document.querySelector('#pi-goal-board').innerText"), /可操作/);
    log(`real board ${JSON.stringify(board)}`);
    console.log(`PASS real read-only board: ${board.version}, ${board.count} goals rendered`);
    return;
  }
  await pause(300);
  const waiting = await win.webContents.executeJavaScript("document.querySelector('#pi-goal-board').innerText");
  log(`waiting=${waiting}`); assert.match(waiting, /自动重连/);
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  let result;
  for (let i = 0; i < 60; i++) {
    await pause(200);
    const frame = win.webContents.mainFrame.frames.find(f => f.url.startsWith(GOAL_ORIGIN + '/'));
    if (frame) { try { result = await frame.executeJavaScript('window.testResult || null'); } catch {} }
    if (result) break;
  }
  log(`result=${JSON.stringify(result)} requests=${JSON.stringify(requests)}`); assert.deepEqual(result, {writable:true,count:2,post:400,origin:GOAL_ORIGIN});
  assert.equal(await win.webContents.executeJavaScript("fetch('https://goal.piweb.invalid/api/session').then(r=>r.status===403,()=>true)"), true, 'Pi Web parent must not read board CSRF token');
  assert.equal(await win.webContents.executeJavaScript("fetch('https://goal.piweb.invalid/api/session',{referrer:'https://goal.piweb.invalid/'}).then(r=>r.status===403,()=>true)"), true, 'parent cannot spoof the board referrer');
  assert.equal(await win.webContents.executeJavaScript("(()=>{try{return !!document.querySelector('iframe').contentWindow.document.body}catch{return false}})()"), false, 'board frame must remain cross-origin');
  assert.ok(requests.some(r => r.method === 'POST' && r.url === '/api/act' && r.origin === `http://127.0.0.1:${port}`));
  console.log('PASS Electron overlay: offline -> automatic reconnect -> isolated board -> protected POST');
} catch (error) {
  log(`ERROR ${error?.stack || error}`); console.error(error?.stack || error); process.exitCode = 1;
} finally {
  win?.destroy(); if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  log('exiting'); app.exit(process.exitCode || 0);
 }
});
