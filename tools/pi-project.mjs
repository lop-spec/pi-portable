#!/usr/bin/env node
// Single durable entry for project creation and session routing; no model calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../assets/piweb-overlay/portable-project-store.mjs';
export async function run(argv = process.argv.slice(2)) {
  const [action] = argv;
  const arg = name => { const i = argv.indexOf('--' + name); return i < 0 ? undefined : argv[i + 1]; };
  if (!['create', 'move', 'merge', 'verify', 'list'].includes(action)) throw new Error('用法：pi-project.mjs create --project 名称 | move --session ID --project 名称 [--defer] [--preserve-cwd] | merge --project 合并后的名称 | list');
  const agentDir = arg('agent-dir') ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.userInfo().homedir, '.pi', 'agent');
  let id = arg('session') ?? process.env.PI_SESSION_ID;
  if (id?.endsWith('.jsonl')) id = path.basename(id).replace(/^.*_([^_]+)\.jsonl$/, '$1');
  const body = { action, project: arg('project'), id, title: arg('title'), preserveCwd: argv.includes('--preserve-cwd') };
  if (!['list', 'verify'].includes(action) && !body.project) throw new Error('缺少 --project');
  if (action === 'move' && !/^[a-z0-9][a-z0-9._-]*$/i.test(id ?? '')) throw new Error('缺少有效 --session');
  const deferred = argv.includes('--defer');
  const queueFile = deferred ? path.join(agentDir, 'project-routing-queue', id + '.json') : null;
  if (queueFile) atomicWrite(queueFile, JSON.stringify({ ...body, queuedAt: new Date().toISOString() }));
  const until = Date.now() + (deferred ? 86400000 : 1);
  do {
    try {
      const response = await fetch('http://127.0.0.1:30140/api/project-routing', { method: action === 'list' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' }, ...(action === 'list' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
      const raw = await response.text();
      let data; try { data = JSON.parse(raw); } catch { throw new Error('项目路由尚未上线，HTTP ' + response.status); }
      if (!response.ok) {
        if (!deferred || ![404, 409, 503].includes(response.status) || response.status === 409 && data.retryable === false) throw Object.assign(new Error(data.error ?? 'HTTP ' + response.status), { permanent: true });
      } else {
        if (data.info) data.info = Object.fromEntries(['id', 'name', 'path', 'cwd', 'projectRoot', 'projectKey', 'created', 'modified', 'messageCount'].filter(key => data.info[key] !== undefined).map(key => [key, data.info[key]]));
        if (Array.isArray(data.projects)) data.projects = data.projects.map(project => Object.fromEntries(['name', 'root', 'sessionDirectory'].filter(key => project[key] !== undefined).map(key => [key, project[key]])));
        delete data.sessionIds; delete data.hidden; delete data.categories;
        if (action !== 'list' && data.verification?.ok === false) throw Object.assign(new Error('验证失败：' + data.verification.errors.join('；')), { permanent: true });
        if (action === 'move' && id) atomicWrite(path.join(agentDir, 'project-routing-results', id + '.json'), JSON.stringify(data, null, 2));
        if (queueFile) fs.rmSync(queueFile, { force: true });
        return data;
      }
    } catch (error) { if (error.permanent || !deferred || Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < until);
  throw new Error('归属仍在队列中：' + queueFile);
}
const executablePath = value => { let real; try { real = fs.realpathSync(value); } catch { real = path.resolve(value); } return process.platform === 'win32' ? real.toLowerCase() : real; };
if (process.argv[1] && executablePath(process.argv[1]) === executablePath(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await run())); }
  catch (error) {
    const index = process.argv.indexOf('--session'), id = index >= 0 ? process.argv[index + 1] : process.env.PI_SESSION_ID;
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(id ?? '') && process.env.PI_CODING_AGENT_DIR) atomicWrite(path.join(process.env.PI_CODING_AGENT_DIR, 'project-routing-results', id + '.json'), JSON.stringify({ ok: false, error: error.message }));
    console.error('[pi-project] ' + error.message); process.exitCode = 1;
  }
}
