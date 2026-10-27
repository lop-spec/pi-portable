// Mechanical execution only. The current model supplies every classification and project name.
import fs from 'node:fs';
import path from 'node:path';
import { ProjectStore, atomicWrite, projectKey } from '../assets/piweb-overlay/portable-project-store.mjs';
import { validProjectName } from '../assets/piweb-overlay/project-routing.mjs';
export const MAX_PROJECTS = 8;
export const MIN_CONVERSATIONS = 5;
export const MAX_CONVERSATIONS = 10;
const task = s => /(?:^|[\\/])\.pi[\\/]agent[\\/]automations(?:[\\/]|$)/i.test(s.cwd ?? '');
// The old generic registration may be a source, never a new destination.
const validSourceName = name => name === '综合工作台' ? name : validProjectName(name);
export function projectCounts(registry, sessions, archived = {}) {
  const roots = sessions.filter(s => s.relation?.kind !== 'subagent' && !archived[s.id] && !task(s));
  return registry.projects.map(p => ({ ...p, name: p.name ?? path.basename(p.root), count: roots.filter(s => projectKey(s.projectRoot ?? s.cwd) === p.key).length }));
}
export function verifyProjectBalance(registry, sessions, archived = {}) {
  const projects = projectCounts(registry, sessions, archived), total = projects.reduce((sum, p) => sum + p.count, 0), errors = [];
  for (const p of projects) {
    if (p.count < MIN_CONVERSATIONS) errors.push(`项目不足${MIN_CONVERSATIONS}个对话：${p.name}（${p.count}）`);
    if (p.count > MAX_CONVERSATIONS) errors.push(`项目超过${MAX_CONVERSATIONS}个对话：${p.name}（${p.count}）`);
  }
  if (projects.length > MAX_PROJECTS) errors.push(`项目超过${MAX_PROJECTS}个：${projects.length}`);
  if (registry.hidden?.length) errors.push('不允许隐藏项目');
  return { ok: !errors.length, errors, maxProjects: MAX_PROJECTS, minConversations: MIN_CONVERSATIONS, maxConversations: MAX_CONVERSATIONS, conversationCount: total, projects: projects.map(({ name, root, count }) => ({ name, root, count })) };
}
export function validateProjectPlan(plan = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('项目整理参数必须是对象');
  for (const key of Object.keys(plan)) if (!['renames', 'merges', 'moves', 'splits'].includes(key)) throw new Error('未知整理参数：' + key);
  for (const key of ['renames', 'merges', 'moves', 'splits']) if (plan[key] !== undefined && !Array.isArray(plan[key])) throw new Error(key + ' 必须是数组');
  for (const item of plan.renames ?? []) { validSourceName(item.from); validProjectName(item.to); }
  for (const item of plan.merges ?? []) { validProjectName(item.project); if (!Array.isArray(item.from) || !item.from.length) throw new Error('合并必须由模型指定来源'); item.from.forEach(validSourceName); }
  for (const item of [...(plan.moves ?? []), ...(plan.splits ?? [])]) { validProjectName(item.project); if (!Array.isArray(item.ids) || !item.ids.length || item.ids.some(id => typeof id !== 'string')) throw new Error('分类必须由模型指定会话ID'); if (item.archived !== undefined && typeof item.archived !== 'boolean') throw new Error('archived 必须是布尔值'); }
  for (const item of plan.splits ?? []) validSourceName(item.from);
  return plan;
}
// Simulate the model-supplied plan plus the incoming session before touching the registry.
// Archived sessions and children follow their projects, but do not count towards visible main conversations.
export function previewProjectPlan({ registry, sessions, archived = {}, plan = {}, incoming }) {
  validateProjectPlan(plan);
  let projects = registry.projects.map(p => ({ ...p, name: p.name ?? path.basename(p.root) }));
  const names = new Map(projects.map(p => [p.key, p.name]));
  const rows = sessions.map(s => ({ ...s, projectName: names.get(projectKey(s.projectRoot ?? s.cwd)) ?? null }));
  const active = s => !archived[s.id] && s.relation?.kind !== 'subagent' && !task(s);
  const find = name => projects.find(p => p.name === name);
  const ensure = name => {
    if (!find(name)) {
      if (projects.length >= MAX_PROJECTS) throw new Error(`项目已满${MAX_PROJECTS}个，须先按指定方案合并`);
      projects.push({ name, root: name, key: name });
    }
  };
  const ids = (values, alreadyAt, allowArchived = false) => {
    if (new Set(values).size !== values.length) throw new Error('会话ID重复');
    return values.map(id => { const row = rows.find(s => s.id === id); if (!row || row.relation?.kind === 'subagent' || task(row) || archived[id] && row.projectName !== alreadyAt && !allowArchived) throw new Error('不是可分类的主对话或未明确指定归档迁移：' + id); return row; });
  };
  // As in the executor, genuinely empty registrations can be forgotten mechanically.
  projects = projects.filter(p => rows.some(s => s.projectName === p.name));
  for (const item of plan.renames ?? []) {
    const source = find(item.from);
    if (!source) { if (find(item.to)) continue; throw new Error('找不到模型指定的改名项目：' + item.from); }
    if (find(item.to) && item.from !== item.to) throw new Error('改名目标已存在：' + item.to);
    source.name = item.to;
    for (const row of rows) if (row.projectName === item.from) row.projectName = item.to;
  }
  for (const item of plan.merges ?? []) {
    ensure(item.project);
    for (const name of item.from) {
      if (name === item.project || !find(name)) continue;
      for (const row of rows) if (row.projectName === name) row.projectName = item.project;
      projects = projects.filter(p => p.name !== name);
    }
  }
  for (const item of plan.moves ?? []) { const selected = ids(item.ids, item.project, item.archived === true); ensure(item.project); for (const row of selected) row.projectName = item.project; }
  for (const item of plan.splits ?? []) {
    const selected = ids(item.ids, item.project), source = find(item.from), target = find(item.project);
    if (target && selected.every(s => s.projectName === item.project)) continue;
    if (!source || item.from === item.project || selected.some(s => s.projectName !== item.from && s.projectName !== item.project)) throw new Error('拆分会话须属于指定来源或已移动到目标');
    if (rows.filter(s => active(s) && s.projectName === item.from && !selected.includes(s)).length === 0) throw new Error('拆分须保留来源主对话');
    ensure(item.project); for (const row of selected) row.projectName = item.project;
  }
  if (incoming) {
    const [row] = ids([incoming.id]); ensure(incoming.project); row.projectName = incoming.project;
  }
  projects = projects.filter(p => rows.some(s => s.projectName === p.name));
  const errors = [];
  const counts = projects.map(p => ({ name: p.name, count: rows.filter(s => active(s) && s.projectName === p.name).length }));
  const target = incoming && counts.find(p => p.name === incoming.project);
  const needsArchive = Boolean(target && target.count === MAX_CONVERSATIONS + 1);
  if (needsArchive) target.count--; // The oldest prior reply is archived before moving the incoming session.
  for (const p of counts) if (p.count < MIN_CONVERSATIONS || p.count > MAX_CONVERSATIONS) errors.push(`${p.name}（${p.count}个对话，不在${MIN_CONVERSATIONS}–${MAX_CONVERSATIONS}范围）`);
  if (projects.length > MAX_PROJECTS) errors.push(`项目超过${MAX_PROJECTS}个`);
  if (registry.hidden?.length) errors.push('不允许隐藏项目');
  return { ok: !errors.length, errors, projects: counts, needsArchive };
}
export function acquireProjectBalanceLock(agentDir) {
  const lock = path.join(agentDir, 'project-balance.lock'); fs.mkdirSync(agentDir, { recursive: true });
  let fd;
  try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { const previous = JSON.parse(fs.readFileSync(lock, 'utf8')); process.kill(previous.pid, 0); }
    catch (probe) { if (probe.code !== 'ESRCH') throw new Error('项目正在整理，回复结束后再整理'); fs.unlinkSync(lock); return acquireProjectBalanceLock(agentDir); }
    throw new Error('项目正在整理，回复结束后再整理');
  }
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
export async function balanceProjects({ agentDir, request, plan = {}, verify = true, loadArchive = () => {
  const file = path.join(agentDir, 'session-archive.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).sessions ?? {} : {};
}, forgetEmpty, lockHeld = false }) {
  validateProjectPlan(plan);
  const release = lockHeld ? null : acquireProjectBalanceLock(agentDir);
  const operations = [], snapshot = async () => {
    const registry = await request('/api/project-routing'), catalogue = await request('/api/sessions?force=1');
    return { registry, sessions: catalogue.sessions, archived: loadArchive() };
  };
  const forget = async p => {
    if (forgetEmpty) return forgetEmpty(p);
    for (const month of fs.readdirSync(p.root).filter(n => /^\d{4}-\d{2}$/.test(n))) if (fs.readdirSync(path.join(p.root, month)).some(n => n.endsWith('.jsonl'))) throw new Error('空项目有未识别的会话，拒绝遗漏：' + p.name);
    // Assets and execution cwd stay untouched; only the genuinely empty registration is removed.
    new ProjectStore(path.join(agentDir, 'web-projects.json')).forget(p.root);
  };
  const move = async (ids, project) => {
    const { registry, sessions } = await snapshot();
    if (!registry.projects.some(p => (p.name ?? path.basename(p.root)) === project) && registry.projects.length >= MAX_PROJECTS) throw new Error('先按模型参数合并或改名，不能创建第9个项目：' + project);
    const roots = ids.map(id => { const s = sessions.find(s => s.id === id); if (!s || s.relation?.kind === 'subagent' || task(s)) throw new Error('不是可分类的主对话：' + id); return s; });
    const target = registry.projects.find(p => (p.name ?? path.basename(p.root)) === project);
    for (const s of roots) if (!target || projectKey(s.projectRoot ?? s.cwd) !== target.key) await request('/api/project-routing', { action: 'move', id: s.id, project, preserveCwd: true });
  };
  try {
    const initial = await snapshot();
    if (verify && initial.registry.managed) {
      const preview = previewProjectPlan({ ...initial, plan });
      if (!preview.ok) throw Object.assign(new Error('整理方案未满足数量要求，未执行：' + preview.errors.join('；') + '；脚本不推测分类'), { permanent: true, report: preview });
    }
    if (initial.registry.managed) for (const p of projectCounts(initial.registry, initial.sessions, initial.archived).filter(p => !p.count)) {
      if (!initial.sessions.some(s => projectKey(s.projectRoot ?? s.cwd) === p.key)) { await forget(p); operations.push({ action: 'remove-empty', project: p.name }); }
    }
    for (const item of plan.renames ?? []) {
      const { registry } = await snapshot(), source = registry.projects.find(p => (p.name ?? path.basename(p.root)) === item.from);
      if (!source) { if (registry.projects.some(p => (p.name ?? path.basename(p.root)) === item.to)) continue; throw new Error('找不到模型指定的改名项目：' + item.from); }
      await request('/api/projects', { action: 'rename', cwd: source.root, name: item.to }); operations.push({ action: 'rename', ...item });
    }
    for (const item of plan.merges ?? []) {
      let { registry, sessions } = await snapshot();
      if (!registry.projects.some(p => (p.name ?? path.basename(p.root)) === item.project)) {
        if (registry.projects.length >= MAX_PROJECTS) throw new Error('先按模型参数合并，不能创建第9个项目：' + item.project);
        await request('/api/project-routing', { action: 'create', project: item.project });
        ({ registry, sessions } = await snapshot());
      }
      for (const name of item.from) {
        if (name === item.project) continue;
        const source = registry.projects.find(p => (p.name ?? path.basename(p.root)) === name); if (!source) continue;
        const ids = sessions.filter(s => projectKey(s.projectRoot ?? s.cwd) === source.key && s.relation?.kind !== 'subagent').map(s => s.id);
        if (ids.length) await move(ids, item.project);
        const after = await snapshot(); if (after.sessions.some(s => projectKey(s.projectRoot ?? s.cwd) === source.key)) throw new Error('合并来源仍有对话，拒绝遗漏：' + name);
        await forget(source); operations.push({ action: 'merge', from: name, project: item.project, conversations: ids.length });
      }
    }
    for (const item of plan.moves ?? []) { await move(item.ids, item.project); operations.push({ action: 'move', ...item }); }
    for (const item of plan.splits ?? []) {
      const { registry, sessions, archived } = await snapshot(), counts = projectCounts(registry, sessions, archived), source = counts.find(p => p.name === item.from), target = counts.find(p => p.name === item.project);
      if (target && item.ids.every(id => sessions.some(s => s.id === id && projectKey(s.projectRoot ?? s.cwd) === target.key))) continue;
      const remaining = item.ids.filter(id => !target || !sessions.some(s => s.id === id && projectKey(s.projectRoot ?? s.cwd) === target.key));
      if (!source || item.from === item.project || new Set(item.ids).size !== item.ids.length || remaining.length >= source.count || remaining.some(id => !sessions.some(s => s.id === id && !archived[id] && s.relation?.kind !== 'subagent' && !task(s) && projectKey(s.projectRoot ?? s.cwd) === source.key))) throw new Error('拆分须保留来源主对话，且不能混入其他项目或归档对话');
      await move(remaining, item.project); operations.push({ action: 'split', before: source.count, ...item });
    }
    let { registry, sessions, archived } = await snapshot();
    if (!registry.managed) return { skipped: 'unmanaged', operations };
    for (const p of projectCounts(registry, sessions, archived).filter(p => !p.count)) {
      if (sessions.some(s => projectKey(s.projectRoot ?? s.cwd) === p.key)) continue; // Archived history needs an explicit model-supplied merge target.
      await forget(p); operations.push({ action: 'remove-empty', project: p.name });
    }
    ({ registry, sessions, archived } = await snapshot());
    const result = { ...verifyProjectBalance(registry, sessions, archived), operations, completedAt: new Date().toISOString() };
    atomicWrite(path.join(agentDir, 'project-balance-result.json'), JSON.stringify(result, null, 2));
    if (verify && !result.ok) throw Object.assign(new Error(result.errors.join('；') + '；请在原正常回复中一次指定整理参数，脚本不推测分类'), { permanent: true, report: result });
    return result;
  } finally { release?.(); }
}
