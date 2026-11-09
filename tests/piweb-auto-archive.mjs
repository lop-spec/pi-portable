import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAutoArchive, saveAutoArchive, archiveDay, runAutoArchive } from '../assets/piweb-overlay/redesign/files/lib/portable-auto-archive.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-archive-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const at = hour => new Date(2026, 9, 25, hour, 0, 0);
let calls = 0;
const fetchImpl = async (url, init) => {
  if (url.endsWith('/api/sessions?force=1')) return { ok: true, json: async () => ({ sessions: [{ id: 'old', modified: '2026-01-01T00:00:00Z' }], archive: { view: 'active' } }) };
  if (url.endsWith('/api/sessions?force=1&archiveView=archived')) return { ok: true, json: async () => ({ sessions: [], archive: { view: 'archived' } }) };
  if (url.endsWith('/api/agent/running')) return { ok: true, json: async () => ({ runningSessionIds: [] }) };
  assert.equal(url, 'http://127.0.0.1:30141/api/sessions/old/archive');
  assert.equal(init.method, 'POST');
  calls++;
  return { ok: true, json: async () => ({ ok: true, archived: true, created: true, sessionIds: ['old'] }) };
};
test('default on; persisted switches; invalid/corrupt config fails closed', () => {
  assert.deepEqual(readAutoArchive(temp), { enabled: true, days: 7, hour: 5 });
  assert.equal(saveAutoArchive(temp, false).enabled, false);
  assert.equal(readAutoArchive(temp).enabled, false);
  assert.throws(() => saveAutoArchive(temp, 'false'));
  fs.writeFileSync(path.join(temp, 'web-auto-archive.json'), '{broken');
  assert.throws(() => readAutoArchive(temp));
  saveAutoArchive(temp, true);
});
test('local 05:00 boundary, once per day, persistent across invocations', async () => {
  assert.equal(archiveDay(at(4)), '2026-10-24');
  assert.equal(archiveDay(at(5)), '2026-10-25');
  const args = { agentDir: temp, now: at(5), fetchImpl };
  assert.equal((await runAutoArchive(args)).groupCount, 1);
  assert.equal((await runAutoArchive(args)).skipped, 'already-ran');
  assert.equal(calls, 1);
  saveAutoArchive(temp, false);
  assert.equal((await runAutoArchive({ ...args, now: new Date(2026, 9, 26, 6) })).skipped, 'disabled');
  assert.equal(calls, 1);
  saveAutoArchive(temp, true);
  await runAutoArchive({ ...args, now: new Date(2026, 9, 26, 6) });
  assert.equal(calls, 2);
});
test('HTTP/partial failure does not mark the day done; retry is safe', async () => {
  const now = new Date(2026, 9, 27, 5);
  await assert.rejects(runAutoArchive({ agentDir: temp, now, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }) }) }));
  await assert.rejects(runAutoArchive({ agentDir: temp, now, fetchImpl: async (url, init) => url.endsWith('/old/archive') ? ({ ok: false, status: 500, json: async () => ({ error: 'archive failed' }) }) : fetchImpl(url, init) }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'web-auto-archive-last-run.json'))).day, '2026-10-26');
  assert.equal((await runAutoArchive({ agentDir: temp, now, fetchImpl })).groupCount, 1);
});
test('UI owns switch in Settings, not model menu; task uses verified silent host', () => {
  const base = new URL('../assets/piweb-overlay/redesign/files/components/', import.meta.url);
  const settings = fs.readFileSync(new URL('SettingsPanel.tsx', base), 'utf8');
  const models = fs.readFileSync(new URL('PortableModelList.tsx', base), 'utf8');
  assert.match(settings, /<AutoArchiveSetting \/>/);
  assert.match(settings, /ConfigSwitch checked=\{enabled\}/);
  assert.match(settings, /每天凌晨 5 点/);
  assert.doesNotMatch(models, /ArchiveOlderButton|一键归档超过/);
  const task = fs.readFileSync(new URL('../tools/install-auto-archive-task.ps1', import.meta.url), 'utf8');
  assert.match(task, /New-SilentScheduledTaskAction/);
  assert.match(task, /-Daily -At '05:00'/);
  assert.match(task, /silent-autostart.mjs/);
});
