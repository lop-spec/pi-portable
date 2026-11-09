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

// One age policy for both the scheduled job and the proxy's manual bulk endpoint.
// Storage month is independent of the latest activity of the complete session family.
export function planArchive(catalogue, activeSessions, { days, now, running = new Set(), keep = new Set() }) {
  const cutoff = Number(now) - days * 86_400_000;
  const known = new Set(catalogue.map(session => String(session?.id || '')));
  const families = [], skipped = { running: 0, kept: 0, unknownAge: 0 };
  for (const root of activeSessions) {
    const rootId = String(root?.id || ''), parentId = String(root?.relation?.parentSessionId || '');
    if (!rootId || (root?.relation?.kind === 'subagent' && parentId && known.has(parentId))) continue;
    const ids = new Set([rootId]);
    let size;
    do {
      size = ids.size;
      for (const session of catalogue) if (session?.relation?.kind === 'subagent' && ids.has(String(session.relation.parentSessionId || ''))) ids.add(String(session.id));
    } while (size !== ids.size);
    const members = catalogue.filter(session => ids.has(String(session?.id || '')));
    const newest = Math.max(...members.map(member => Date.parse(member?.modified)));
    if (!Number.isFinite(newest)) { skipped.unknownAge++; continue; }
    if (newest >= cutoff) continue;
    if (members.some(member => running.has(String(member.id)))) { skipped.running++; continue; }
    if (members.some(member => keep.has(String(member.id)))) { skipped.kept++; continue; }
    families.push({ rootId, members });
  }
  return { families, skipped };
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
  const get = async route => {
    const response = await fetchImpl(url + route, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`${route} HTTP ${response.status}`);
    return response.json();
  };
  // The running proxy may still use the former month-based bulk endpoint until an idle restart.
  // Plan from the complete catalogue and call the existing per-family API instead.
  const [active, archived, live] = await Promise.all([
    get('/api/sessions?force=1'), get('/api/sessions?force=1&archiveView=archived'), get('/api/agent/running'),
  ]);
  if (!Array.isArray(active.sessions) || !Array.isArray(archived.sessions) || !Array.isArray(live.runningSessionIds)
    || (active.archive && active.archive.view !== 'active') || (archived.archive && archived.archive.view !== 'archived')) {
    throw new Error('会话目录或运行状态无效，未执行归档');
  }
  const catalogue = [...active.sessions, ...archived.sessions];
  const plan = planArchive(catalogue, active.sessions, { days: setting.days, now: now.getTime(), running: new Set(live.runningSessionIds.map(String)) });
  const result = { ok: true, days: setting.days, groupCount: 0, sessionCount: 0, skippedRunning: plan.skipped.running, skippedKept: plan.skipped.kept, skippedUnknownAge: plan.skipped.unknownAge, failed: 0, failures: [] };
  for (const family of plan.families) {
    try {
      const response = await fetchImpl(`${url}/api/sessions/${encodeURIComponent(family.rootId)}/archive`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
      });
      const body = await response.json();
      if (response.status === 409 && /running/i.test(String(body.error || ''))) { result.skippedRunning++; continue; }
      if (!response.ok || !body.ok || !body.archived || !Array.isArray(body.sessionIds)) throw new Error(body.error || `HTTP ${response.status}`);
      if (body.created) { result.groupCount++; result.sessionCount += body.sessionIds.length; }
    } catch (error) {
      result.failed++;
      if (result.failures.length < 5) result.failures.push({ sessionId: family.rootId, error: String(error.message || error) });
    }
  }
  if (result.failed) throw new Error(`归档失败：${result.failed}；${result.failures.map(f => f.error).join('；')}`);
  const record = { day, completedAt: now.toISOString(), ...result };
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(record, null, 2) + '\n');
  return record;
}
