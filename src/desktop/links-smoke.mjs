import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Exercises native Electron navigation and input without starting the real browser.
export async function smokeDesktopLinks(contents, origin, launches, previews) {
  const http = 'http://127.0.0.1:8080/path?q=%23#section';
  const https = 'https://example.test/path#part';
  const preview = `${origin}/api/projects?desktop-link-smoke=1#part`;
  const start = contents.getURL();
  function inject(href, mode) {
    return contents.executeJavaScript(`(() => {
      document.getElementById('desktop-link-smoke')?.remove();
      const a = document.createElement('a');
      a.id = 'desktop-link-smoke'; a.href = ${JSON.stringify(href)};
      a.textContent = 'Open'; a.rel = 'noopener noreferrer';
      a.style.cssText = 'position:fixed;left:10px;top:10px;width:150px;height:70px;z-index:2147483647;background:white;';
      if (${JSON.stringify(mode)} === 'blank') a.target = '_blank';
      if (${JSON.stringify(mode)} === 'script') a.addEventListener('click', e => { e.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer'); });
      document.body.append(a); a.focus();
      return document.elementFromPoint(30, 30)?.id === a.id;
    })()`);
  }
  async function waitFor(predicate, name) {
    for (let i = 0; i < 40 && !predicate(); i++) await delay(100);
    assert.ok(predicate(), name);
  }
  async function mouse() {
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', x: 30, y: 30, clickCount: 1 });
    await delay(45);
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', x: 30, y: 30, clickCount: 1 });
  }
  await contents.executeJavaScript(`void window.open(${JSON.stringify(https)}, '_blank')`);
  await delay(100);
  assert.deepEqual(launches, []);
  assert.ok(await inject(http, 'blank'));
  await mouse();
  await waitFor(() => launches.length === 1, 'target=_blank HTTP click');
  assert.ok(await inject(https, 'self'));
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(() => launches.length === 2, 'same-window HTTPS keyboard link');
  assert.ok(await inject(https, 'script'));
  await mouse();
  await waitFor(() => launches.length === 3, 'trusted window.open (document links)');
  assert.deepEqual(launches, [http, https, https]);
  async function testPreview(url) {
    await contents.executeJavaScript(`void window.open(${JSON.stringify(url)}, '_blank', 'noopener,noreferrer')`);
    await waitFor(() => [...previews].some(window => !window.isDestroyed() && window.webContents.getURL() === url && !window.webContents.isLoading()), 'same-origin preview window');
    return [...previews].find(window => !window.isDestroyed() && window.webContents.getURL() === url);
  }
  await testPreview(preview);
  let filePreviews = false;
  if (process.env.PI_DESKTOP_SMOKE_FILES) {
    const root = process.env.PI_DESKTOP_SMOKE_FILES.replace(/\\/gu, '/').split('/').map(encodeURIComponent).join('/');
    const urlFor = (file, hash = '') => `${origin}/api/files/${root}/${file}?type=read${hash}`;
    const png = await testPreview(urlFor('link.png'));
    assert.equal(await png.webContents.executeJavaScript('document.contentType'), 'image/png');
    const pdf = await testPreview(urlFor('link.pdf', '#page=1'));
    assert.equal(await pdf.webContents.executeJavaScript('document.contentType'), 'application/pdf');
    filePreviews = true;
  }
  assert.equal(contents.getURL(), start);
  for (const window of previews) if (!window.isDestroyed()) window.destroy();
  return { blankHttp: true, sameWindowHttps: true, documentPopup: true, localPreview: true, automaticExternalBlocked: true, filePreviews };
}
