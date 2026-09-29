// Gate for scheduled tasks on pi-chat: start only below 2 running conversations; else wait 5 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForPiChatCapacity, piChatConversations, bridgeTokenFile } from '../src/pi-chat-capacity.mjs';

test('waits in 5-minute steps while 4 or more conversations run, then starts', async () => {
  const counts = [5, 4, 3], sleeps = [], events = [];
  const result = await waitForPiChatCapacity({
    task: 'fixture', probe: async () => { const n = counts.shift(); return { count: n, ids: Array.from({ length: n }, (_, i) => 'session-' + i), bySource: {}, errors: [] }; },
    sleep: async ms => { sleeps.push(ms); }, log: (event, data) => events.push({ event, ...data }),
  });
  assert.equal(result.count, 3);
  assert.deepEqual(sleeps, [300000, 300000]);
  assert.deepEqual(events.map(e => e.event), ['pi-chat-busy-wait', 'pi-chat-busy-wait', 'pi-chat-capacity-ok']);
  assert.equal(events.at(-1).checks, 3);
});

test('a conversation seen on several surfaces counts once; only web-model pi-web sessions count; unreadable sources are reported', async () => {
  const token = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-cap-')), 'local-token'); fs.writeFileSync(token, 'tok');
  const server = http.createServer((req, res) => {
    const send = v => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/web/api/agent/running') return send({ runningSessionIds: ['a', 'b', 'c'] });
    if (req.url === '/web/api/agent/a') return send({ data: { model: { provider: 'pi-chatgpt-web' } } });
    if (req.url === '/web/api/agent/b') return send({ data: { model: { provider: 'pi-chatgpt-web' } } });
    if (req.url === '/web/api/agent/c') return send({ data: { model: { provider: 'openai-codex' } } });
    if (req.url === '/bridge/health') return req.headers['x-pi-bridge'] === 'tok' ? send({ activeSessions: ['a', 'cli-task'] }) : (res.writeHead(401), res.end());
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = await piChatConversations({ piWeb: base + '/web', bridge: base + '/bridge', tokenFile: token });
    assert.deepEqual(c.ids.sort(), ['a', 'b', 'cli-task']);
    assert.deepEqual(c.errors, []);
    const down = await piChatConversations({ piWeb: base + '/web', bridge: 'http://127.0.0.1:9', tokenFile: token });
    assert.equal(down.errors.length, 1); assert.match(down.errors[0], /^bridge:/);
    const noToken = await piChatConversations({ piWeb: base + '/web', bridge: base + '/bridge', tokenFile: null });
    assert.match(noToken.errors[0], /^bridge: token not found/);
  } finally { server.close(); }
});

test('the bridge token is found through the pi-web extension link, whichever machine layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-token-'));
  try {
    const pichat = path.join(root, 'pi-chatgpt-web'), agent = path.join(root, 'home', 'data', '.pi', 'agent');
    fs.mkdirSync(path.join(pichat, 'extension'), { recursive: true }); fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
    fs.symlinkSync(path.join(pichat, 'extension'), path.join(agent, 'extensions', 'pi-chatgpt-web'), 'junction');
    // No instance.json and no token: nothing to find.
    assert.equal(bridgeTokenFile({ env: { PI_CODING_AGENT_DIR: agent }, moduleDir: root }), null);
    // Legacy layout: <pi-chat>/data/local-token beside the extension.
    fs.mkdirSync(path.join(pichat, 'data'), { recursive: true }); fs.writeFileSync(path.join(pichat, 'data', 'local-token'), 't');
    assert.equal(bridgeTokenFile({ env: { PI_CODING_AGENT_DIR: agent }, moduleDir: root }), path.resolve(fs.realpathSync(pichat), 'data', 'local-token'));
    // The provider's own instance.json dataRoot wins, wherever it points.
    const dataRoot = path.join(root, 'elsewhere', 'data');
    fs.mkdirSync(path.join(pichat, '.local'), { recursive: true }); fs.writeFileSync(path.join(pichat, '.local', 'instance.json'), JSON.stringify({ dataRoot }));
    const expected = path.join(dataRoot, 'local-token');
    assert.equal(bridgeTokenFile({ env: { PI_CODING_AGENT_DIR: agent }, moduleDir: root }), expected);
    assert.equal(bridgeTokenFile({ env: { PI_PORTABLE_HOME: path.join(root, 'home') }, moduleDir: root }), expected);
    assert.equal(bridgeTokenFile({ env: {}, moduleDir: path.join(root, 'home', 'src') }), expected, 'repo = pi-web home (the peer layout)');
    assert.equal(bridgeTokenFile({ env: { LOCALAPPDATA: path.join(root, 'none') }, moduleDir: root }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
