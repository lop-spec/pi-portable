import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PiWebUiProxy } from '../src/piweb-ui-proxy.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-test-filter-'));
const agentDir = path.join(root, '.pi', 'agent');
const sessionRoot = path.join(agentDir, 'sessions');
fs.mkdirSync(sessionRoot, { recursive: true });
const registry = path.join(agentDir, 'recent-test-sessions.json');

const sessions = [
  { id: 'historical-test', firstMessage: 'offline benchmark' },
  { id: 'historical-child', relation: { kind: 'subagent', parentSessionId: 'historical-test' } },
  { id: 'marked-test', firstMessage: '【测试任务】 protocol check' },
  { id: 'marked-child', relation: { kind: 'subagent', parentSessionId: 'marked-test' } },
  { id: 'work', firstMessage: '测试的会话不要显示，但这是正常工作讨论' },
];
const source = { sessions, runningSessionIds: sessions.map(session => session.id), marker: 'keep' };
const raw = Buffer.from(JSON.stringify(source));

try {
  fs.writeFileSync(registry, JSON.stringify({ version: 1, ids: ['historical-test'] }));
  const proxy = new PiWebUiProxy({ dataRoot: root, sessionRoot, archiveUiSource: '', sessionReadOffload: false });

  test('UI session list excludes registered/marked test families and preserves ordinary discussion', () => {
    const entry = proxy.sessionListEntry('full', raw);
    assert.deepEqual(entry.body.sessions.map(session => session.id), ['work']);
    assert.deepEqual(entry.body.runningSessionIds, ['work']);
    assert.equal(entry.body.marker, 'keep');
    assert.deepEqual(JSON.parse(entry.persistRaw.toString('utf8')), entry.body);
    assert.equal(entry.sourceBody.sessions.length, 5);
  });

  test('test registry changes invalidate the memo without restarting the proxy', () => {
    const before = proxy.sessionListEntry('full', raw);
    fs.writeFileSync(registry, JSON.stringify({ version: 1, ids: [] }));
    const after = proxy.sessionListEntry('full', raw);
    assert.notEqual(after, before);
    assert.deepEqual(after.body.sessions.map(session => session.id), ['historical-test', 'historical-child', 'work']);
    assert.deepEqual(after.body.runningSessionIds, ['historical-test', 'historical-child', 'work']);
  });
} finally {
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}
