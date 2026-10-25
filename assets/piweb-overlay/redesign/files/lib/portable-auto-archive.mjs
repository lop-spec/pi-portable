import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readAutoArchive(agentDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(agentDir, 'web-auto-archive.json'), 'utf8'));
    if (typeof value.enabled !== 'boolean') throw new Error('自动归档设置无效');
    return { enabled: value.enabled, days: 7, hour: 5 };
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: true, days: 7, hour: 5 };
    throw error;
  }
}

export function saveAutoArchive(agentDir, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'web-auto-archive.json');
  const temp = file + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify({ enabled }) + '\n', { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return readAutoArchive(agentDir);
}

// Local civil time, not a 24-hour interval: DST/reboots never shift the 05:00 boundary.
export function archiveDay(now = new Date()) {
  const due = new Date(now);
  due.setHours(5, 0, 0, 0);
  if (now < due) due.setDate(due.getDate() - 1);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
}

export async function runAutoArchive({ agentDir, url = 'http://127.0.0.1:30141', now = new Date(), fetchImpl = fetch }) {
  const setting = readAutoArchive(agentDir);
  if (!setting.enabled) return { skipped: 'disabled' };
  const stateFile = path.join(agentDir, 'web-auto-archive-last-run.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const day = archiveDay(now);
  if (previous?.day === day) return { skipped: 'already-ran', day };
  const response = await fetchImpl(url + '/__pi_archive_older', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days: setting.days, keep: [] }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok || result.failed) throw new Error(result.error || `归档失败：${result.failed ?? response.status}`);
  const record = { day, completedAt: now.toISOString(), ...result };
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(record, null, 2) + '\n');
  return record;
}
