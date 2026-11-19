import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFetch } from './local-http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smoke = process.argv.includes('--desktop-smoke');
const appHome = path.resolve(process.env.PI_DESKTOP_PROFILE || path.join(app.getPath('appData'), 'PiWebDesktop'));
fs.mkdirSync(appHome, { recursive: true });
app.setPath('userData', appHome);
app.commandLine.appendSwitch('no-proxy-server'); // only the separate Codex worker uses the user's proxy
app.commandLine.appendSwitch('disable-background-networking');
const config = JSON.parse(fs.readFileSync(path.join(appHome, 'desktop.json'), 'utf8').replace(/^\uFEFF/u, ''));
const { data, packageRoot, node, accountHomes, egress = 10808 } = config;
for (const dir of [data, packageRoot, node, ...[accountHomes].filter(Boolean)]) if (!path.isAbsolute(dir) || !fs.existsSync(dir)) throw new Error('Pi Web 桌面版配置路径不存在');
if (!Number.isInteger(egress) || egress < 1 || egress > 65535) throw new Error('代理配置无效');
const origin = 'https://piweb.invalid';
const allowedUrl = value => { try { return new URL(value).origin === origin; } catch { return false; } };
const pipe = `\\\\.\\pipe\\piweb-desktop-${randomBytes(24).toString('hex')}`;
const secret = randomBytes(32).toString('hex');
let worker, win, closing = false;
const audit = (entry) => fs.appendFileSync(path.join(appHome, 'desktop.log'), `${new Date().toISOString()} ${entry}\n`);
async function startWorker() {
  const fd = fs.openSync(path.join(appHome, 'backend.log'), 'a');
  try {
    worker = spawn(node, [path.join(root, 'src', 'desktop', 'backend.mjs')], {
      windowsHide: true, cwd: root, stdio: ['ignore', fd, fd, 'ipc'],
    });
  } finally { fs.closeSync(fd); }
  const ready = new Promise((resolve, reject) => {
    let timer;
    const fail = reason => { clearTimeout(timer); reject(reason); };
    worker.once('error', fail);
    worker.once('exit', code => {
      if (closing) return;
      audit(`worker exit code=${code}`);
      fail(new Error(`Pi 内核退出（${code}）`));
      if (win) { if (!smoke) dialog.showErrorBox('Pi Web', 'Pi 内核已退出，请重新打开。'); app.exit(1); }
    });
    worker.once('message', event => {
      clearTimeout(timer);
      if (event.type === 'ready') resolve(event.pid);
      else reject(new Error(String(event.message || 'IPC 启动失败')));
    });
    timer = setTimeout(() => reject(new Error('本地 Pi 内核启动超时')), 25000);
  });
  worker.send({ data, packageRoot, pipe, secret, accountHomes, egress, appHome });
  return ready;
}
function shutdown() {
  if (closing) return;
  closing = true;
  if (worker?.connected) worker.disconnect();
}
app.on('will-quit', shutdown);
app.on('window-all-closed', () => app.quit());
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  void app.whenReady().then(async () => {
    const pid = await startWorker();
    win = new BrowserWindow({ title: 'Pi Web', width: 1160, height: 800, show: false,
      webPreferences: { partition: 'persist:piweb', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } });
    const contents = win.webContents;
    const session = contents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedUrl(details.url) && !/^(?:data|blob):/u.test(details.url) }));
    session.protocol.handle('https', async (request) => {
      if (!allowedUrl(request.url)) return new Response(null, { status: 403 });
      try { return await localFetch(request, undefined, { socketPath: pipe }, { extraHeaders: { 'x-pi-desktop-key': secret } }); }
      catch { return new Response('本地 Pi 内核连接失败', { status: 502 }); }
    });
    contents.on('will-navigate', (event, url) => { if (!allowedUrl(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('ready-to-show', () => { if (!smoke && !win.isDestroyed()) win.show(); });
    await win.loadURL(`${origin}/`);
    audit(`ready main=${process.pid} worker=${pid}${smoke ? ' smoke' : ''}`);
    if (smoke) {
      const result = await contents.executeJavaScript(`(async () => {
        const r = await fetch('/api/sessions');
        const p = await fetch('/api/projects');
        const j = await r.json();
        return { sessionsStatus:r.status, projectsStatus:p.status, json:typeof j === 'object', document:document.body?.innerText.length > 30, scripts:document.scripts.length };
      })()`);
      audit(`smoke ${JSON.stringify(result)}`);
      if (result.sessionsStatus !== 200 || result.projectsStatus !== 200 || !result.json || !result.document || result.scripts < 2) throw new Error('desktop smoke: page or local API failed');
      app.quit();
    }
  }).catch(error => {
    audit(`failed ${error.message}`);
    if (!smoke) dialog.showErrorBox('Pi Web', error.message);
    shutdown();
    app.exit(1);
  });
}
