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
  if (!['create', 'move', 'merge', 'list'].includes(action)) throw new Error('用法：pi-project.mjs create --project 名称 | move --session ID --project 名称 [--defer] [--preserve-cwd] | merge --project 合并后的名称 | list');
  const agentDir = arg('agent-dir') ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.userInfo().homedir, '.pi', 'agent');
  let id = arg('session') ?? process.env.PI_SESSION_ID;
  if (id?.endsWith('.jsonl')) id = path.basename(id).replace(/^.*_([^_]+)\.jsonl$/, '$1');
  const body = { action, project: arg('project'), id, title: arg('title'), preserveCwd: argv.includes('--preserve-cwd') };
  if (action !== 'list' && !body.project) throw new Error('缺少 --project');
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
        if (queueFile) fs.rmSync(queueFile, { force: true });
        return data;
      }
    } catch (error) { if (error.permanent || !deferred || Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < until);
  throw new Error('归属仍在队列中：' + queueFile);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await run())); }
  catch (error) { console.error('[pi-project] ' + error.message); process.exitCode = 1; }
}
