import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../portable-project-store.mjs';
import { DEFAULT_STATUS, validStatus } from './model.mjs';

const validId = id => typeof id === 'string' && id.length <= 200 && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
export function readStatusStore(agentDir) {
  const file = path.join(agentDir, 'web-session-status.json');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, sessions: {} }; throw error; }
  if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw new Error('会话状态文件损坏，已停止写入');
  for (const [id, value] of Object.entries(parsed.sessions)) {
    if (!validId(id) || !value || typeof value !== 'object' || !validStatus(value.status) || typeof value.flagged !== 'boolean') throw new Error('会话状态文件损坏，已停止写入');
  }
  return parsed;
}
export function updateStatusStore(agentDir, id, patch) {
  if (!validId(id) || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效会话或状态');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => key !== 'status' && key !== 'flagged') || ('status' in patch && !validStatus(patch.status)) || ('flagged' in patch && typeof patch.flagged !== 'boolean')) throw new Error('无效会话状态');
  const data = readStatusStore(agentDir), previous = data.sessions[id] ?? { status: DEFAULT_STATUS, flagged: false };
  const next = { ...previous, ...patch };
  if (next.status === DEFAULT_STATUS && !next.flagged) delete data.sessions[id];
  else data.sessions[id] = next;
  const text = JSON.stringify(data, null, 2) + '\n';
  atomicWrite(path.join(agentDir, 'web-session-status.json'), text);
  return { sessions: data.sessions, updated: next };
}
