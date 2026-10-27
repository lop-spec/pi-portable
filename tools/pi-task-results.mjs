#!/usr/bin/env node
// Scheduled output is retained in archive, never routed into a user project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../assets/piweb-overlay/portable-project-store.mjs';
export const isAutomationCwd = cwd => /(?:^|\/)\.pi\/agent\/automations(?:\/|$)/i.test(String(cwd ?? '').replaceAll('\\', '/'));
export async function archiveAutomationResult({ id, defer = false, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = defer ? 900 : 1, agentDir = process.env.PI_CODING_AGENT_DIR }) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id ?? '')) throw new Error('Invalid automation session ID');
  let validated = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (!validated) {
        const response = await fetchImpl('http://127.0.0.1:30140/api/sessions?force=1', { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Object.assign(new Error('Session catalogue unavailable'), { retryable: true });
        const session = (await response.json()).sessions?.find(s => s.id === id);
        if (!session) throw Object.assign(new Error('Automation session not visible yet'), { retryable: true });
        if (!isAutomationCwd(session.cwd)) throw new Error('Refusing to archive a non-automation conversation');
        validated = true;
      }
      const response = await fetchImpl(`http://127.0.0.1:30141/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.archived) throw Object.assign(new Error(result.error ?? 'Automation archive failed'), { retryable: [404, 409, 503].includes(response.status) });
      if (agentDir) atomicWrite(path.join(agentDir, 'automation-results', id + '.json'), JSON.stringify({ ...result, archivedAt: result.archivedAt || new Date().toISOString() }, null, 2));
      return result;
    } catch (error) {
      if (!defer || !error.retryable && !['TimeoutError', 'TypeError'].includes(error.name) || attempt + 1 >= attempts) throw error;
      await sleep(2000);
    }
  }
}
const real = file => { try { return fs.realpathSync(file).toLowerCase(); } catch { return path.resolve(file).toLowerCase(); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--session');
    if (args[0] !== 'archive' || index < 0) throw new Error('Usage: pi-task-results.mjs archive --session ID [--defer]');
    console.log(JSON.stringify(await archiveAutomationResult({ id: args[index + 1], defer: args.includes('--defer') })));
  } catch (error) { console.error('[pi-task-results] ' + error.message); process.exitCode = 1; }
}
