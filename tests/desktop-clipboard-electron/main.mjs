import { app, BrowserWindow, Menu } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pi-clipboard-electron-')));
app.commandLine.appendSwitch('no-proxy-server');
const out = data => {
  if (process.env.PI_CLIPBOARD_ELECTRON_LOG) fs.appendFileSync(process.env.PI_CLIPBOARD_ELECTRON_LOG, JSON.stringify(data) + '\n');
};
// Run the shipped selection event handler in Chromium without touching the Windows clipboard.
const source = process.env.PI_CLIPBOARD_SOURCE || new URL('../../assets/piweb-overlay/feishu-copy/clipboard.ts', import.meta.url);
let code = stripTypeScriptTypes(fs.readFileSync(source, 'utf8'));
code = code.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const start = code.indexOf('const markdownProcessor =');
const end = code.indexOf('/** HTML is for Feishu/Docs;');
assert.ok(start >= 0 && end > start);
code = code.slice(0, start) + code.slice(end);

void app.whenReady().then(async () => {
  let win;
  try {
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({ show:false, webPreferences:{offscreen:true, sandbox:true, contextIsolation:true} });
    const {session} = win.webContents;
    session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    session.setPermissionCheckHandler(() => false);
    session.protocol.handle('https', () => new Response(`<!doctype html><meta charset=utf-8>
      <div class="markdown-body"><h2>处理结论</h2><p>结果：<strong><a href="https://www.feishu.cn/">加粗链接</a></strong></p>
      <ol start="3"><li>上个条目</li><li>列表正文</li></ol><table><tbody><tr><td colspan="2">表格正文</td></tr></tbody></table>
      <button>界面按钮</button></div>
      <pre class="file-source-view"><span class="file-source-line"><span class="file-line-number">1</span>  SELECT 1;</span><span class="file-source-line"><span aria-hidden="true">2</span>  SELECT 2;</span></pre>
      <textarea>不拦截输入框</textarea>`, {headers:{'Content-Type':'text/html;charset=UTF-8'}}));
    await win.loadURL('https://piweb.invalid/');
    const result = await win.webContents.executeJavaScript(`(() => {${code}
      const stop = installSelectionCopy();
      const select = (css, inside = false) => {
        const node = document.querySelector(css);
        const range = document.createRange();
        if (inside) { range.setStart(node.firstChild,1); range.setEnd(node.firstChild,3); }
        else range.selectNodeContents(node);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      };
      const copy = (target = 'body') => {
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});
        document.querySelector(target).dispatchEvent(event);
        return {html:data.getData('text/html'),text:data.getData('text/plain'),handled:event.defaultPrevented};
      };
      select('a',true); const inline = copy();
      select('h2',true); const heading = copy();
      select('li:last-child',true); const list = copy();
      select('td',true); const table = copy();
      select('.markdown-body'); const whole = copy(); const input = copy('textarea');
      select('.file-source-view'); const file = copy();
      stop();
      return {inline,heading,list,table,whole,input,file};
    })()`);
    out(result);
    assert.match(result.inline.html, /<strong[^>]*><a href="https:\/\/www\.feishu\.cn\/"/);
    assert.equal(result.inline.text, '粗链');
    assert.match(result.heading.html, /<h2[^>]*>理结<\/h2>/);
    assert.match(result.list.html, /<ol start="4"[^>]*><li[^>]*>表正<\/li>/);
    assert.match(result.table.html, /<table[^>]*><tbody><tr><td colspan="2"[^>]*>格正<\/td>/);
    assert.doesNotMatch(result.whole.html + result.whole.text, /界面按钮/);
    assert.equal(result.input.handled, false);
    assert.equal(result.file.text, '  SELECT 1;\n  SELECT 2;');
    assert.match(result.file.html, /<pre[^>]*>/);
    out({pass:true});
    win.destroy();
    app.exit(0);
  } catch (error) { out({error:error.stack}); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); }
});
