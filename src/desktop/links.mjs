// Keep Pi Web on its private origin. Only a short-lived native input may hand
// a URL to the operating system; renderer events alone cannot authorize it.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'irc:', 'ircs:', 'xmpp:']);
const INPUT_WINDOW_MS = 1_500;

export function desktopLink(value, origin) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.origin === origin && url.protocol === 'https:') return { kind: 'local', url: url.href };
  if (url.hostname === new URL(origin).hostname) return null; // never hand the private host to the OS
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
  if (!url.hostname && !url.pathname) return null;
  return { kind: 'external', url: url.href };
}

export function installDesktopLinks(contents, { origin, openExternal, openLocal, onError, now = () => performance.now() }) {
  let inputAt = -Infinity;
  function followExternal(link) {
    if (now() - inputAt > INPUT_WINDOW_MS) return;
    inputAt = -Infinity;
    void Promise.resolve().then(() => openExternal(link.url)).catch(onError);
  }
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseUp' && (mouse.button === 'left' || mouse.button === 'middle')) inputAt = now();
  });
  contents.on('before-input-event', (_event, key) => {
    if ((key.type === 'keyDown' && key.key === 'Enter' && !key.isAutoRepeat)
      || (key.type === 'keyUp' && key.key === ' ')) inputAt = now();
  });
  contents.on('will-navigate', (event, legacyUrl) => {
    const link = desktopLink(event.url ?? legacyUrl, origin);
    if (link?.kind === 'local') return;
    event.preventDefault();
    if (link?.kind === 'external' && (!event.initiator || event.initiator === contents.mainFrame)) followExternal(link);
  });
  contents.on('will-redirect', (event, legacyUrl) => {
    if (event.isMainFrame && desktopLink(event.url ?? legacyUrl, origin)?.kind !== 'local') event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url, postBody }) => {
    if (!postBody) {
      const link = desktopLink(url, origin);
      if (link?.kind === 'external') followExternal(link);
      if (link?.kind === 'local') void Promise.resolve().then(() => openLocal(link.url)).catch(onError);
    }
    // Never accept a renderer-supplied window or opener; a local preview gets
    // its own explicitly locked-down BrowserWindow in the same private session.
    return { action: 'deny' };
  });
}
