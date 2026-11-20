import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { desktopLink, installDesktopLinks } from '../src/desktop/links.mjs';

const origin = 'https://piweb.invalid';
test('preserves web URLs, standard link schemes and the private preview URL', () => {
  for (const url of ['http://127.0.0.1:8080/?a=%23#part', 'https://example.test/a#x', 'mailto:support@example.test', 'tel:+8612345']) {
    assert.deepEqual(desktopLink(url, origin), { kind: 'external', url });
  }
  for (const url of [`${origin}/api/files/a.pdf?type=read#page=2`, `${origin}/api/sessions/id/export?inline=1`]) {
    assert.deepEqual(desktopLink(url, origin), { kind: 'local', url });
  }
  for (const url of ['file:///C:/Windows/example.txt', 'javascript:void(0)', 'data:text/html,test', 'blob:https://piweb.invalid/1', 'custom:thing', 'https://user:pass@example.test/', 'http://piweb.invalid/', 'https://piweb.invalid:89/', 'mailto:', 'https://example.test/\nx', 'about:blank']) {
    assert.equal(desktopLink(url, origin), null, url);
  }
});

function fixture() {
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.setWindowOpenHandler = handler => { contents.popup = (url, postBody) => handler({ url, postBody }); };
  const calls = [], errors = new EventEmitter();
  let at = 100;
  installDesktopLinks(contents, {
    origin, now: () => at,
    openExternal: async url => { calls.push(['OS', url]); if (url.endsWith('/failure')) throw new Error('launch failed'); },
    openLocal: async url => { calls.push(['local', url]); },
    onError: error => errors.emit('failure', error.message),
  });
  return { contents, calls, errors, advance: ms => { at += ms; } };
}
const link = 'http://example.test:8080/a?q=1#b';
function navigate(contents, url, { type = 'will-navigate', initiator = contents.mainFrame } = {}) {
  let blocked = false;
  contents.emit(type, { url, initiator, isMainFrame: true, preventDefault() { blocked = true; } });
  return blocked;
}

test('regular clicks, new-tab links and keyboard (but not automatic launches) dispatch outside', async () => {
  const { contents, calls, advance } = fixture();
  assert.deepEqual(contents.popup(link), { action: 'deny' });
  assert.equal(navigate(contents, link), true);
  contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'right' });
  contents.popup(link);
  contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'middle' });
  contents.popup(link, { data: 'do not replay POST' });
  contents.popup(link);
  contents.popup(link); // one OS launch per native gesture
  contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
  assert.equal(navigate(contents, link, { initiator: {} }), true);
  assert.equal(navigate(contents, link), true);
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' });
  contents.popup('mailto:help@example.test');
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' });
  advance(2_000);
  contents.popup(link);
  await Promise.resolve();
  assert.deepEqual(calls, [['OS', link], ['OS', link], ['OS', 'mailto:help@example.test']]);
});

test('local preview popups stay private; unsupported schemes and redirects never leave the app', async () => {
  const { contents, calls, errors } = fixture();
  const preview = `${origin}/api/files/a.pdf?type=read#page=3`;
  assert.equal(navigate(contents, `${origin}/?session=id`), false);
  assert.deepEqual(contents.popup(preview), { action: 'deny' });
  assert.deepEqual(contents.popup('file:///C:/tmp/a.pdf'), { action: 'deny' });
  assert.equal(navigate(contents, link, { type: 'will-redirect' }), true);
  contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
  const failure = once(errors, 'failure');
  contents.popup('https://example.test/failure');
  assert.deepEqual(await failure, ['launch failed']);
  assert.deepEqual(calls, [['local', preview], ['OS', 'https://example.test/failure']]);
});
