// Windows Internet Settings is the single source of truth. No port scanning or
// proxy failover when following the system; an unavailable proxy must stay visible.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function parseSystemProxy(text) {
  const values = Object.fromEntries(String(text).split(/\r?\n/).flatMap(line => {
    const m = line.match(/^\s*(ProxyEnable|ProxyServer|AutoConfigURL)\s+REG_\w+\s+(.*?)\s*$/i);
    return m ? [[m[1].toLowerCase(), m[2]]] : [];
  }));
  if (!Object.hasOwn(values, 'proxyenable')) throw new Error('system-proxy-enable-missing');
  if (Number(values.proxyenable) !== 1) {
    if (values.autoconfigurl) throw new Error('system-proxy-pac-not-supported');
    return { mode: 'direct', host: '', port: 0, source: 'windows-system-proxy' };
  }
  const raw = values.proxyserver || '';
  const mappings = Object.fromEntries(raw.split(';').map(x => x.trim().split('=')));
  const address = raw.includes('=') ? mappings.https || mappings.http : raw.trim();
  if (!address) throw new Error('system-proxy-https-endpoint-missing');
  let url;
  try { url = new URL(address.includes('://') ? address : `http://${address}`); }
  catch { throw new Error('system-proxy-endpoint-invalid'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') throw new Error('system-proxy-endpoint-unsupported');
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('system-proxy-port-invalid');
  return { mode: 'proxy', host: url.hostname.replace(/^\[|\]$/g, ''), port, source: 'windows-system-proxy' };
}

export async function readSystemProxy({ platform = process.platform, run = exec } = {}) {
  if (platform !== 'win32') return null;
  const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
    windowsHide: true, timeout: 2500, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  return parseSystemProxy(stdout);
}

export function createSystemProxyFollower({ read = readSystemProxy, log = console.error, intervalMs = 5000, onChange = () => {} } = {}) {
  let value = null, inFlight = null, timer = null;
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await read();
        if (!next) { log('system-proxy unavailable: unsupported-platform; legacy egress retained'); return value; }
        const changed = !value || value.host !== next.host || value.port !== next.port || value.mode !== next.mode;
        value = { ...next, key: next.source, at: Date.now() };
        if (changed) { log(`system-proxy changed: ${next.mode === 'direct' ? 'direct' : `${next.host}:${next.port}`}`); onChange(value); }
        return value;
      } catch (error) {
        // Parser errors are fixed messages; never emit raw registry contents or PAC URLs.
        const reason = /^system-proxy-[a-z-]+$/.test(error?.message || '') ? error.message : error?.code || 'registry-read-failed';
        log(`system-proxy refresh failed: ${reason}; ${value ? 'last system endpoint retained' : 'legacy egress retained'}`);
        return value;
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return {
    refresh, snapshot: () => value,
    async start() { await refresh(); if (!timer) { timer = setInterval(refresh, intervalMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
