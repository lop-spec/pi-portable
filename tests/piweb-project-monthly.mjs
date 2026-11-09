import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiWebUiProxy } from '../src/piweb-ui-proxy.mjs';
import { readAutoArchive, runAutoArchive } from '../assets/piweb-overlay/redesign/files/lib/portable-auto-archive.mjs';
const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-month-'));
fs.mkdirSync(path.join(agent, 'sessions'));
fs.writeFileSync(path.join(agent, 'web-projects.json'), JSON.stringify({ version: 1, projects: [], hidden: [], managed: true, monthly: true }));
test.after(() => fs.rmSync(agent, { recursive: true, force: true }));

test('monthly storage does not override the seven-day inactivity policy', () => {
  const rows = [
    { id: 'sep', modified: '2026-09-30T12:00:00Z' },
    { id: 'oct', modified: '2026-10-05T12:00:00Z' },
    { id: 'boundary', modified: '2026-10-13T12:00:00Z' },
    { id: 'recent', modified: '2026-10-19T12:00:00Z' },
  ];
  const ctx = { sessionRoot: path.join(agent, 'sessions'), now: () => Date.parse('2026-10-20T12:00:00Z') };
  const plan = PiWebUiProxy.prototype.archiveOlderPlan.call(ctx, rows, rows, { days: 7, running: new Set(), keep: new Set() });
  assert.deepEqual(plan.families.map(f => f.rootId), ['sep', 'oct']);
  const busy = PiWebUiProxy.prototype.archiveOlderPlan.call(ctx, rows, rows, { days: 7, running: new Set(['sep']), keep: new Set() });
  assert.deepEqual(busy.families.map(f => f.rootId), ['oct']);
  assert.equal(busy.skipped.running, 1);
});

test('the existing daily 05:00 job uses seven-day family APIs without invoking a model', async () => {
  assert.deepEqual(readAutoArchive(agent), { enabled: true, days: 7, hour: 5 });
  const calls = [];
  const result = await runAutoArchive({ agentDir: agent, now: new Date('2026-10-20T12:00:00Z'), fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    const body = url.endsWith('/api/sessions?force=1')
      ? { sessions: [{ id: 'old', modified: '2026-09-01T00:00:00Z' }], archive: { view: 'active' } }
      : url.includes('archiveView=archived') ? { sessions: [], archive: { view: 'archived' } }
      : url.endsWith('/api/agent/running') ? { runningSessionIds: [] }
      : { ok: true, archived: true, created: true, sessionIds: ['old'] };
    return { ok: true, json: async () => body };
  } });
  assert.equal(result.days, 7);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.policy, undefined);
  assert.deepEqual(calls.filter(c => c.method === 'POST'), [{ url: 'http://127.0.0.1:30141/api/sessions/old/archive', method: 'POST' }]);
  assert.ok(calls.every(c => !c.url.includes('/api/agent/new') && !c.url.includes('__pi_archive_older')));
});
