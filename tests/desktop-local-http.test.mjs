import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { desktopFileMenuOrigin, localFetch, memoryConnection } from '../src/desktop/local-http.mjs';

test('desktop restores missing file-menu Origin only from the same-origin protocol referrer', () => {
  const origin = 'https://piweb.invalid';
  const options = { method: 'POST', referrer: origin + '/session', mode: 'cors' };
  const check = (init = {}, suffix = '/api/open-local-file') => desktopFileMenuOrigin(new Request(origin + suffix, { ...options, ...init }), origin);
  assert.equal(check(), origin);
  assert.equal(check({ mode: 'same-origin' }), origin);
  assert.equal(check({ referrer: 'https://outside.invalid/' }), null);
  assert.equal(check({ referrer: '' }), null);
  assert.equal(check({ referrer: '', headers: { referer: origin } }), null);
  assert.equal(check({ headers: { origin: 'null' } }), null);
  assert.equal(check({ headers: { origin: 'https://outside.invalid' } }), null);
  assert.equal(check({ headers: { origin } }), null);
  assert.equal(check({ headers: { 'sec-fetch-site': 'cross-site' } }), null);
  assert.equal(check({ method: 'GET' }), null);
  assert.equal(check({ mode: 'no-cors' }), null);
  assert.equal(check({}, '/api/sessions'), null);
});

test('portless request and streaming without a listener', async () => {
  let release;
  const second = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/events?q=1');
    assert.equal(Buffer.concat(chunks).toString(), 'from Pi');
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: first\n\n');
    await second;
    if (!res.destroyed) res.end('data: last\n\n');
  });
  const response = await localFetch('https://piweb.invalid/events?q=1', {method:'POST', body:'from Pi'}, { createConnection: memoryConnection(server) });
  assert.equal(server.listening, false);
  assert.equal(server.address(), null);
  const reader = response.body.getReader();
  const text = new TextDecoder();
  assert.equal(text.decode((await reader.read()).value), 'data: first\n\n');
  release();
  assert.equal(text.decode((await reader.read()).value), 'data: last\n\n');
  assert.equal((await reader.read()).done, true);
});

test('cancelling a stream tears down the upstream', async () => {
  let response;
  const server = http.createServer((_req, res) => { response = res; res.write('first'); });
  const reply = await localFetch('http://piweb.invalid/sse', undefined, { createConnection: memoryConnection(server) });
  const closed = once(response, 'close');
  await reply.body.cancel();
  await closed;
  assert.equal(response.destroyed, true);
});
