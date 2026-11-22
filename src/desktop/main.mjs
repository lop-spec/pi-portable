import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFetch } from './local-http.mjs';
import { installDesktopLinks } from './links.mjs';
import { goalFetch, isGoalUrl } from './goal-transport.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smoke = process.argv.includes('--desktop-smoke');
const profileSwitch = process.argv.find(arg => arg.startsWith('--desktop-profile='))?.slice('--desktop-profile='.length);
const appHome = path.resolve(profileSwitch || process.env.PI_DESKTOP_PROFILE || path.join(app.getPath('appData'), 'PiWebDesktop'));
fs.mkdirSync(appHome, { recursive: true });
app.setPath('userData', appHome);
app.commandLine.appendSwitch('no-proxy-server'); // only the separate Codex worker uses the user's proxy
app.commandLine.appendSwitch('disable-background-networking');
let config;
try { config = JSON.parse(fs.readFileSync(path.join(appHome, 'desktop.json'), 'utf8').replace(/^\uFEFF/u, '')); }
catch (error) {
  if (!smoke) dialog.showErrorBox('Pi Web', '桌面版配置无法读取：' + path.join(appHome, 'desktop.json'));
  throw error;
}
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
    Menu.setApplicationMenu(null); // remove the native File/Edit/View row, not the window title bar
    win = new BrowserWindow({ title: 'Pi Web', width: 1160, height: 800, show: false,
      webPreferences: { partition: 'persist:piweb', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, ...(smoke ? { offscreen: true } : {}) } });
    const contents = win.webContents;
    const session = contents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedUrl(details.url) && !isGoalUrl(details.url) && !/^(?:data|blob):/u.test(details.url) }));
    session.protocol.handle('https', async (request) => {
      if (isGoalUrl(request.url)) return goalFetch(request);
      if (!allowedUrl(request.url)) return new Response(null, { status: 403 });
      try { return await localFetch(request, undefined, { socketPath: pipe }, { extraHeaders: { 'x-pi-desktop-key': secret } }); }
      catch { return new Response('本地 Pi 内核连接失败', { status: 502 }); }
    });
    const reportLinkError = error => {
      audit(`link open failed: ${error?.code || error?.name || 'error'}`);
      if (!smoke && !win.isDestroyed()) void dialog.showMessageBox(win, { type: 'warning', message: '无法打开链接', detail: '请检查系统默认浏览器或对应的查看程序。' });
    };
    const linkCheck = [];
    const openExternal = smoke ? async url => { linkCheck.push(url); } : url => shell.openExternal(url);
    const previews = new Set();
    const openLocal = async url => {
      const target = new URL(url);
      const pdf = /^\/api\/files\/.*\.pdf$/iu.test(target.pathname) && target.searchParams.get('type') === 'read';
      const preview = new BrowserWindow({ parent: win, title: 'Pi Web', width: 1040, height: 760, show: false,
        webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, plugins: pdf } });
      previews.add(preview);
      preview.once('closed', () => previews.delete(preview));
      installDesktopLinks(preview.webContents, { origin, openExternal, openLocal, onError: reportLinkError });
      try {
        await preview.loadURL(url);
        if (!smoke && !preview.isDestroyed()) preview.show();
      } catch (error) {
        if (!preview.isDestroyed()) preview.destroy();
        if (error.code !== 'ERR_ABORTED') throw error; // Chromium may hand off downloads instead of rendering
      }
    };
    installDesktopLinks(contents, { origin, openExternal, openLocal, onError: reportLinkError });
    win.once('ready-to-show', () => { if (!smoke && !win.isDestroyed()) win.show(); });
    await win.loadURL(`${origin}/`);
    audit(`ready main=${process.pid} worker=${pid}${smoke ? ' smoke' : ''}`);
    if (smoke) {
      const result = await contents.executeJavaScript(`(async () => {
        const r = await fetch('/api/sessions');
        const p = await fetch('/api/projects');
        const q = await fetch('/__pi_account_usage', { cache: 'no-store' });
        const j = await r.json(), quota = await q.json();
        return { sessionsStatus:r.status, projectsStatus:p.status, json:typeof j === 'object', document:document.body?.innerText.length > 30, scripts:document.scripts.length,
          quotaStatus:q.status, quotaShape:Array.isArray(quota.accounts), quotaUi:window.__piAccountUsageUiVersion };
      })()`);
      const menuRemoved = Menu.getApplicationMenu() === null && !win.isMenuBarVisible();
      audit(`smoke ${JSON.stringify({ ...result, menuRemoved })}`);
      if (result.sessionsStatus !== 200 || result.projectsStatus !== 200 || !result.json || !result.document || result.scripts < 2 || !menuRemoved || result.quotaStatus !== 200 || !result.quotaShape || !result.quotaUi) throw new Error('desktop smoke: page, local API, quota or native menu failed');
      const { smokeDesktopLinks } = await import('./links-smoke.mjs');
      audit(`links smoke ${JSON.stringify(await smokeDesktopLinks(contents, origin, linkCheck, previews))}`);
      if (process.argv.includes('--desktop-goal-smoke')) {
        const { smokeDesktopGoal } = await import('./goal-smoke.mjs');
        audit(`goal smoke ${JSON.stringify(await smokeDesktopGoal(contents))}`);
      }
      app.quit();
    }
  }).catch(error => {
    audit(`failed ${error.message}`);
    if (!smoke) dialog.showErrorBox('Pi Web', error.message);
    shutdown();
    app.exit(1);
  });
}
