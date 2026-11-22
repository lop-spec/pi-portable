import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { GOAL_ORIGIN, goalFetch, isGoalUrl } from '../src/desktop/goal-transport.mjs';

test('goal transport preserves the board origin and token checks', async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') { res.setHeader('access-control-allow-origin', '*'); return res.end('{"ok":true}'); }
    if (req.url === '/api/session') return res.end('{"writable":true,"token":"test-token"}');
    if (req.headers.origin !== `http://127.0.0.1:${server.address().port}` || req.headers['x-goal-token'] !== 'test-token') { res.statusCode = 403; return res.end('{}'); }
    res.statusCode = 400; res.end('{"error":"invalid action"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const get = url => goalFetch(new Request(GOAL_ORIGIN + url, { referrer: `${GOAL_ORIGIN}/` }), { port });
  assert.equal((await goalFetch(new Request(`${GOAL_ORIGIN}/api/session`, { referrer: 'https://piweb.invalid/' }), { port })).status, 403);
  assert.equal((await get('/api/health')).headers.get('access-control-allow-origin'), '*');
  assert.equal((await (await get('/api/session')).json()).writable, true);
  assert.equal(seen[1].headers.host, `127.0.0.1:${port}`);
  const post = (origin, token, route = '/api/act') => goalFetch(new Request(GOAL_ORIGIN + route, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-goal-token': token }, body: '{"v":{}}',
  }), { port });
  assert.equal((await post('https://piweb.invalid', 'test-token')).status, 403);
  assert.equal((await goalFetch(new Request(`${GOAL_ORIGIN}/api/act`, { method: 'POST', referrer: 'https://piweb.invalid/', body: '{}' }), { port })).status, 403);
  assert.equal((await goalFetch(new Request(`${GOAL_ORIGIN}/api/act`, { method: 'POST', referrer: `${GOAL_ORIGIN}/`, headers: { 'x-goal-token': 'test-token' }, body: '{}' }), { port })).status, 400);
  assert.equal((await post(GOAL_ORIGIN, 'wrong')).status, 403);
  assert.equal((await post(GOAL_ORIGIN, 'test-token')).status, 400);
  assert.equal(seen.at(-1).headers.origin, `http://127.0.0.1:${port}`);
  assert.equal(seen.at(-1).body, '{"v":{}}');
  const before = seen.length;
  assert.equal((await post(GOAL_ORIGIN, 'test-token', '/api/session')).status, 405);
  assert.equal(seen.length, before);
});

test('only the exact virtual origin and fixed service are reachable', async () => {
  assert.ok(isGoalUrl(`${GOAL_ORIGIN}/api/health`));
  for (const url of ['https://goal.piweb.invalid:30170/', 'https://goal.piweb.invalid.evil/', 'https://x@goal.piweb.invalid/', 'http://goal.piweb.invalid/', 'https://piweb.invalid/']) assert.equal(isGoalUrl(url), false, url);
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  assert.equal((await goalFetch(new Request(`${GOAL_ORIGIN}/api/health`), { port })).status, 503);
  assert.equal((await goalFetch(new Request(`${GOAL_ORIGIN}/api/act`, { method: 'DELETE' }), { port })).status, 405);
});
