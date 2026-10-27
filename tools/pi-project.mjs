#!/usr/bin/env node
// Single durable entry for project creation and session routing; no model calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWrite, projectKey } from '../assets/piweb-overlay/portable-project-store.mjs';
import { acquireProjectBalanceLock, balanceProjects, previewProjectPlan, validateProjectPlan } from './project-balance.mjs';
import { oldestReplySession } from '../assets/piweb-overlay/session-reply-time.mjs';
async function projectRequest(route, body) {
  const response = await fetch('http://127.0.0.1:30140' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  const raw = await response.text(); let data;
  try { data = JSON.parse(raw); } catch { throw new Error('项目路由尚未上线，HTTP ' + response.status); }
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'HTTP ' + response.status), { permanent: ![404, 409, 503].includes(response.status) || response.status === 409 && data.retryable === false });
  return data;
}
async function archiveSession(id) {
  const response = await fetch(`http://127.0.0.1:30141/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok || !data.ok || !data.archived) throw Object.assign(new Error(data.error ?? '归档失败'), { permanent: ![404, 409, 503].includes(response.status) });
  return data;
}
export async function run(argv = process.argv.slice(2)) {
  const [action] = argv;
  const arg = name => { const i = argv.indexOf('--' + name); return i < 0 ? undefined : argv[i + 1]; };
  if (!['create', 'move', 'merge', 'balance', 'verify', 'list'].includes(action)) throw new Error('用法：pi-project.mjs create --project 名称 | move --session ID --project 名称 [--defer] [--preserve-cwd] | merge --project 合并后的名称 | balance | list');
  const agentDir = arg('agent-dir') ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.userInfo().homedir, '.pi', 'agent');
  let id = arg('session') ?? process.env.PI_SESSION_ID;
  if (id?.endsWith('.jsonl')) id = path.basename(id).replace(/^.*_([^_]+)\.jsonl$/, '$1');
  const body = { action, project: arg('project'), id, title: arg('title'), preserveCwd: argv.includes('--preserve-cwd') };
  const plan = validateProjectPlan(arg('plan-file') ? JSON.parse(fs.readFileSync(arg('plan-file'), 'utf8')) : arg('plan-json') ? JSON.parse(arg('plan-json')) : {});
  if (!['list', 'verify', 'balance'].includes(action) && !body.project) throw new Error('缺少 --project');
  if (action === 'move' && !/^[a-z0-9][a-z0-9._-]*$/i.test(id ?? '')) throw new Error('缺少有效 --session');
  const taskReceipt = action === 'move' ? path.join(agentDir, 'automation-results', id + '.json') : null;
  if (taskReceipt && fs.existsSync(taskReceipt) && JSON.parse(fs.readFileSync(taskReceipt, 'utf8')).archived === true) throw new Error('计划任务结果单独归档，不参与项目归属');
  const deferred = argv.includes('--defer');
  const queueFile = deferred ? path.join(agentDir, 'project-routing-queue', (action === 'balance' ? 'balance' : id) + '.json') : null;
  if (queueFile) atomicWrite(queueFile, JSON.stringify({ ...body, queuedAt: new Date().toISOString() }));
  const until = Date.now() + (deferred ? 86400000 : 1);
  do {
    let release;
    try {
      if (!['list', 'verify'].includes(action)) release = acquireProjectBalanceLock(agentDir);
      let preview;
      if (action === 'move') {
        const registry = await projectRequest('/api/project-routing'), catalogue = await projectRequest('/api/sessions?force=1');
        const archiveFile = path.join(agentDir, 'session-archive.json'), archived = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')).sessions ?? {} : {};
        if (registry.managed) {
          if (!catalogue.sessions.some(s => s.id === id)) throw Object.assign(new Error('当前对话尚未进入目录，等待重试'), { permanent: false });
          preview = previewProjectPlan({ registry, sessions: catalogue.sessions, archived, plan, incoming: { id, project: body.project } });
          if (!preview.ok) throw Object.assign(new Error('整理方案未满足数量要求，未修改归属：' + preview.errors.join('；') + '；请在同次回复中指定合并或拆分参数'), { permanent: true, report: preview });
        }
      }
      if (!['list', 'verify', 'balance'].includes(action) && Object.keys(plan).length) await balanceProjects({ agentDir, request: projectRequest, plan, verify: false, lockHeld: true });
      let archivedOldest;
      if (action === 'move' && preview?.needsArchive) {
        const registry = await projectRequest('/api/project-routing'), catalogue = await projectRequest('/api/sessions?force=1');
        const archiveFile = path.join(agentDir, 'session-archive.json'), archived = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')).sessions ?? {} : {};
        const target = registry.projects.find(p => (p.name ?? path.basename(p.root)) === body.project);
        if (!target) throw new Error('目标项目不存在：' + body.project);
        const candidates = catalogue.sessions.filter(s => s.id !== id && !archived[s.id] && s.relation?.kind !== 'subagent' && !/(?:^|[\\/])\.pi[\\/]agent[\\/]automations(?:[\\/]|$)/i.test(s.cwd ?? '') && projectKey(s.projectRoot ?? s.cwd) === target.key);
        if (candidates.length !== 10) throw Object.assign(new Error('目标项目数量已变化，等待重新预演'), { permanent: false });
        const oldest = await oldestReplySession(candidates);
        const result = await archiveSession(oldest.session.id);
        archivedOldest = { id: oldest.session.id, replyTime: new Date(oldest.replyTime).toISOString(), archivedAt: result.archivedAt };
      }
      let data = await projectRequest('/api/project-routing', ['list', 'balance'].includes(action) ? undefined : body);
      if (archivedOldest) data.archivedOldest = archivedOldest;
      if (!['list', 'verify'].includes(action)) {
        const balance = await balanceProjects({ agentDir, request: projectRequest, lockHeld: true, ...(action === 'balance' ? { plan } : {}) });
        const report = await projectRequest('/api/project-routing', { action: 'verify', ...(action === 'move' ? { id } : {}) });
        data = { ...data, ...report, balance };
        if (data.info && report.sessionFile) { const root = path.dirname(path.dirname(report.sessionFile)); data.info = { ...data.info, path: report.sessionFile, projectRoot: root, projectKey: projectKey(root) }; }
      }
      if (action === 'verify') {
        const catalogue = await projectRequest('/api/sessions?force=1');
        const archiveFile = path.join(agentDir, 'session-archive.json');
        const archived = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')).sessions : {};
        const { verifyProjectBalance } = await import('./project-balance.mjs');
        data.balance = verifyProjectBalance(data, catalogue.sessions, archived);
        data.verification = { ...data.verification, ok: data.verification.ok && data.balance.ok, errors: [...data.verification.errors, ...data.balance.errors] };
      }
      {
        if (data.info) data.info = Object.fromEntries(['id', 'name', 'path', 'cwd', 'projectRoot', 'projectKey', 'created', 'modified', 'messageCount'].filter(key => data.info[key] !== undefined).map(key => [key, data.info[key]]));
        if (Array.isArray(data.projects)) data.projects = data.projects.map(project => Object.fromEntries(['name', 'root', 'sessionDirectory'].filter(key => project[key] !== undefined).map(key => [key, project[key]])));
        delete data.sessionIds; delete data.hidden; delete data.categories;
        if (action !== 'list' && data.verification?.ok === false) throw Object.assign(new Error('验证失败：' + data.verification.errors.join('；')), { permanent: true });
        if (action === 'move' && id) atomicWrite(path.join(agentDir, 'project-routing-results', id + '.json'), JSON.stringify(data, null, 2));
        if (queueFile) fs.rmSync(queueFile, { force: true });
        return data;
      }
    } catch (error) {
      const retryable = error.permanent === false || ['TimeoutError', 'TypeError'].includes(error.name) || /正在运行|正在整理|正在移动|正在物理删除/.test(error.message);
      if (error.permanent || !retryable || !deferred || Date.now() >= until) throw error;
    } finally { release?.(); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < until);
  throw new Error('归属仍在队列中：' + queueFile);
}
const executablePath = value => { let real; try { real = fs.realpathSync(value); } catch { real = path.resolve(value); } return process.platform === 'win32' ? real.toLowerCase() : real; };
if (process.argv[1] && executablePath(process.argv[1]) === executablePath(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await run())); }
  catch (error) {
    const index = process.argv.indexOf('--session'), id = index >= 0 ? process.argv[index + 1] : process.env.PI_SESSION_ID;
    if (process.argv[2] === 'move' && /^[a-z0-9][a-z0-9._-]*$/i.test(id ?? '') && process.env.PI_CODING_AGENT_DIR) atomicWrite(path.join(process.env.PI_CODING_AGENT_DIR, 'project-routing-results', id + '.json'), JSON.stringify({ ok: false, error: error.message }));
    console.error('[pi-project] ' + error.message); process.exitCode = 1;
  }
}
