import http from 'node:http';
import { Readable, duplexPair } from 'node:stream';
import { createGunzip, createBrotliDecompress, createUnzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// Transport the real HTTP parser, including SSE and cancellation, without using an OS socket.
export function memoryConnection(server) {
  return () => {
    const [client, accepted] = duplexPair();
    for (const s of [client, accepted]) {
      s.setTimeout = () => s;
      s.setNoDelay = () => s;
      s.setKeepAlive = () => s;
      s.ref = s.unref = () => s;
      s.on('error', () => {});
    }
    client.once('close', () => accepted.destroy());
    accepted.once('close', () => client.destroy());
    server.emit('connection', accepted);
    return client;
  };
}

// Electron's protocol handler can omit Chromium's Origin header. Restore it
// only for these same-origin controls, using the browser-owned referrer.
export function desktopMutationOrigin(request, origin) {
  if (request.method !== 'POST' || request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') return null;
  if (request.mode !== 'cors' && request.mode !== 'same-origin') return null;
  const target = new URL(request.url);
  if (target.origin !== origin || !['/api/open-local-file', '/__pi_account_auto_reset'].includes(target.pathname)) return null;
  try { return new URL(request.referrer).origin === origin ? origin : null; }
  catch { return null; }
}

const outside = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
export async function localFetch(source, init, endpoint, { extraHeaders = {}, host } = {}) {
  const request = new Request(source, init);
  const url = new URL(request.url);
  if (request.signal.aborted) throw request.signal.reason;
  const headers = Object.fromEntries([...request.headers].filter(([name]) => !outside.has(name)));
  const opts = { ...endpoint, method: request.method, path: url.pathname + url.search,
    headers: { ...headers, ...extraHeaders, host: host || url.host, connection: 'close', 'accept-encoding': 'identity' }, signal: request.signal };
  return new Promise((resolve, reject) => {
    const outgoing = http.request(opts, (incoming) => {
      const output = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        if (!outside.has(incoming.rawHeaders[i].toLowerCase())) output.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      let stream = incoming;
      const decode = { gzip: createGunzip, br: createBrotliDecompress, deflate: createUnzip }[output.get('content-encoding')];
      if (decode) {
        stream = decode();
        incoming.on('error', err => stream.destroy(err)).pipe(stream);
        stream.once('close', () => { if (!incoming.complete) incoming.destroy(); });
        output.delete('content-encoding'); output.delete('content-length');
      }
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
      if (empty) stream.resume();
      const result = new Response(empty ? null : Readable.toWeb(stream), { status: incoming.statusCode, statusText: incoming.statusMessage, headers: output });
      if (!empty) stream.once('close', () => { if (!incoming.complete) outgoing.destroy(); });
      resolve(result);
    });
    outgoing.on('error', reject);
    if (request.body) pipeline(Readable.fromWeb(request.body), outgoing).catch(reject);
    else outgoing.end();
  });
}
