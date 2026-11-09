import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PiWebUiProxy, SessionArchiveStore } from '../src/piweb-ui-proxy.mjs';
import { runAutoArchive } from '../assets/piweb-overlay/redesign/files/lib/portable-auto-archive.mjs';

const now = new Date('2026-11-01T10:00:00Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-archive-live-'));
const sessionRoot = path.join(root, 'sessions');
const dir = path.join(sessionRoot, 'project');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(root, 'web-projects.json'), JSON.stringify({ version: 1, projects: [], hidden: [], managed: true, monthly: true }));
const sessions = [];
function add(id, modified, relation) {
  const file = path.join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id, cwd: root }) + '\n');
  sessions.push({ id, path: file, cwd: root, modified, ...(relation ? { relation } : {}) });
}
add('yesterday', '2026-10-31T15:50:00Z');
add('older', '2026-10-24T09:59:59Z');
add('boundary', '2026-10-25T10:00:00Z');
add('running', '2026-10-20T00:00:00Z');
add('parent', '2026-10-20T00:00:00Z');
add('child', '2026-10-31T20:00:00Z', { kind: 'subagent', parentSessionId: 'parent' });
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(resolve));
let bulkRequests = 0;
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url.startsWith('/api/sessions')) res.end(JSON.stringify({ sessions }));
  else if (req.url === '/api/agent/running') res.end(JSON.stringify({ runningSessionIds: ['running'] }));
  else res.end('{}');
});
const webPort = await listen(upstream);
const probe = http.createServer(); const publicPort = await listen(probe); await close(probe);
const probe2 = http.createServer(); const healthPort = await listen(probe2); await close(probe2);
const proxy = new PiWebUiProxy({ dataRoot: root, sessionRoot, webPort, publicWebPort: publicPort, healthPort, bridgePort: webPort, archiveUiSource: '', now: () => now.getTime() });
proxy.handleArchiveOlder = () => { bulkRequests++; throw new Error('old bulk endpoint must never be used by daily job'); };
await proxy.start();
test.after(async () => { await proxy.close(); await close(upstream); fs.rmSync(root, { recursive: true, force: true }); });

test('05:00 job archives only >7-day-old idle family on the real HTTP proxy', async () => {
  const result = await runAutoArchive({ agentDir: root, now, url: `http://127.0.0.1:${publicPort}` });
  const archive = new SessionArchiveStore(path.join(root, 'session-archive.json'), { sessionRoot });
  assert.deepEqual(archive.partition(sessions).archived.map(s => s.id), ['older']);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.skippedRunning, 1);
  assert.equal(bulkRequests, 0);
  assert.equal(fs.readFileSync(sessions.find(s => s.id === 'yesterday').path, 'utf8').includes('yesterday'), true);
});
