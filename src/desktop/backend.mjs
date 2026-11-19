import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { localFetch, memoryConnection } from './local-http.mjs';

const { data, packageRoot, pipe, secret, accountHomes, egress, appHome } = await new Promise((resolve, reject) => {
  process.once('message', resolve);
  process.once('disconnect', reject);
});
process.once('disconnect', () => process.exit(0));
const agentDir = path.join(data, '.pi', 'agent');
const cache = path.join(appHome, 'runtime-data');
fs.mkdirSync(cache, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  PI_PORTABLE_HOME: appHome, PI_PORTABLE_DATA: cache, PI_CODING_AGENT_DIR: agentDir,
  PI_WEB_HOSTNAME: 'piweb.invalid', PI_DESKTOP_INTERNAL_BRIDGE: '1',
  PI_WEB_PASSWORD: '', CODEX_PROXY_PORT: '8794',
  CODEX_FOLLOW_SYSTEM_PROXY: '0', CODEX_UPSTREAM_PROXY_HOST: '127.0.0.1',
  CODEX_UPSTREAM_PROXY_PORT: String(egress), CODEX_EGRESS_FALLBACK_PORTS: '',
  // No discovery through the old runtime and no direct fallback on offline startup.
  CODEX_EGRESS_STATE_FILE: path.join(cache, 'unused-egress-state.json'),
});
const codexFetchKey = Symbol.for('pi-web.desktop.codex-fetch');
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!/\/pi-ai\/dist\/api\/openai-codex-responses\.js$/u.test(url)) return loaded;
  const source = Buffer.from(loaded.source).toString('utf8');
  const fetchAnchor = '(options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {';
  const transportAnchor = 'const transport = options?.transport || "auto";';
  if (source.split(fetchAnchor).length !== 2 || source.split(transportAnchor).length !== 2) {
    throw new Error('Pi SDK Codex transport contract changed');
  }
  return { ...loaded, source: source.replace(fetchAnchor, 'globalThis[Symbol.for("pi-web.desktop.codex-fetch")](resolveCodexUrl(model.baseUrl), {')
    .replace(transportAnchor, 'const transport = "sse";') };
} });
const requireFromApp = createRequire(path.join(packageRoot, 'package.json'));
const agentName = '@earendil-works/pi-coding-agent';
const agentPackage = requireFromApp.resolve.paths(agentName).map(dir => path.join(dir, agentName, 'package.json')).find(fs.existsSync);
if (!agentPackage) throw new Error('Pi SDK is not installed');
const agentEntry = JSON.parse(fs.readFileSync(agentPackage, 'utf8')).exports['.'].import;
const { SettingsManager } = await import(pathToFileURL(path.join(path.dirname(agentPackage), agentEntry)));
if (typeof SettingsManager?.prototype?.getTransport !== 'function') throw new Error('Pi SDK transport contract changed');
// Keep Codex on the SDK's native SSE path without changing the user's saved transport setting.
SettingsManager.prototype.getTransport = () => 'sse';

// Reuse existing local auth files, but isolate the desktop bridge's mutable cache and logs.
process.env.PI_PORTABLE_DATA = cache;
process.env.CODEX_ACCOUNT_HOMES = accountHomes || path.join(cache, 'not-configured');
const { codexHttpServer } = await import('../bridge/codex-responses-proxy.mjs');
const bridge = { createConnection: memoryConnection(codexHttpServer) };
const web = http.createServer({ requestTimeout: 0 });
const upstream = { createConnection: memoryConnection(web) };
const originalFetch = globalThis.fetch.bind(globalThis);
function fetchRoute(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === 'http://127.0.0.1:8794') return localFetch(input, init, bridge);
  if (url.origin === 'http://127.0.0.1:30140' || url.origin === 'https://piweb.invalid') {
    return localFetch(input, init, upstream, { host: 'piweb.invalid', extraHeaders: { 'x-forwarded-proto': 'https' } });
  }
  return originalFetch(input, init);
}
globalThis[codexFetchKey] = (input, init) => {
  const url = new URL(input);
  if (url.origin !== 'http://127.0.0.1:8794' || url.pathname !== '/v1/codex/responses') {
    throw new Error('桌面版 Codex 仅使用本机登录和已配置代理');
  }
  return localFetch(input, init, bridge);
};
globalThis.fetch = fetchRoute;
const next = requireFromApp('next');
const app = next({ dev: false, dir: packageRoot, hostname: 'piweb.invalid', httpServer: web, customServer: true });
await app.prepare();
const nextHandler = app.getRequestHandler();
web.on('request', (req, res) => void nextHandler(req, res).catch(error => {
  console.error('Pi Web Next request failed:', error?.stack || error);
  if (!res.headersSent) res.writeHead(500);
  if (!res.writableEnded) res.end();
}));
const { PiWebUiProxy } = await import('../piweb-ui-proxy.mjs');
const proxy = new PiWebUiProxy({ dataRoot: data, logFile: path.join(cache, 'desktop-ui.log'), piWebPackageRoot: packageRoot,
  fetchImpl: fetchRoute, webRequest: (opts, cb) => http.request({ ...opts, ...upstream }, cb) });
const expected = Buffer.from(secret);
const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
  const supplied = Buffer.from(String(req.headers['x-pi-desktop-key'] || ''));
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) { res.writeHead(403); res.end(); return; }
  delete req.headers['x-pi-desktop-key'];
  req.headers.host = 'piweb.invalid';
  req.headers['x-forwarded-proto'] = 'https';
  // These optional actions use network-dependent browser login or the legacy relay.
  if (/^\/(?:api\/(?:app-update|push)(?:\/|\?|$)|__pi_account_login(?:\?|$))/u.test(req.url)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '此功能不在 Pi Web 桌面版的 Codex 模式中启用' }));
    return;
  }
  Promise.resolve(proxy.handlePublicProxy(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end();
  });
});
server.on('error', error => {
  process.send?.({ type: 'fatal', message: error.code || 'IPC_LISTEN_FAILED' });
  process.exitCode = 1;
  process.disconnect();
});
server.listen(pipe, () => process.send?.({ type: 'ready', pid: process.pid }));
