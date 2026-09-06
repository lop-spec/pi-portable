// Explicit opt-in Windows timer. No LLM, history index, account switching or daemon.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { appendLineRotating } from './log-rotate.mjs';

export const INTERVAL_MS = 30 * 60_000;
export const RESET_LIMIT_MS = 24 * 60 * 60_000;
export const FIXED_TASKS = [
  { key: 'eastmoney-backtest', title: '东方财富智能回测', directory: '东方财富智能回测分析', match: /东方财富.*(?:回测|选股)/u },
  { key: 'douyin-backtest', title: '抖音选股智能回测', directory: '抖音短线体系回测', match: /抖音.*(?:回测|选股)/u },
];
// Stocks belong to the project host only. Local/unknown hosts run recent P0/P1 work only.
export const stockBacktestsAllowed = (hostname = os.hostname()) => hostname.toLowerCase() === 'desktop-3egb4lb';
const stockText = text => /(?:股票|选股|东方财富|抖音).*回测|回测.*(?:股票|选股|东方财富|抖音)/u.test(text);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
const textOf = (m) => typeof m?.content === 'string' ? m.content : (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const norm = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const control = s => /^\/(?:lop-followup|name)\b|^继续执行本会话原始任务|^未达标[；;]|^不符合用户习惯、目标或方向|^符合用户习惯、目标和方向/u.test(s.trim());

// Loopback only, native HTTP deliberately ignores system proxy settings.
export function requestJson(base, route, body, timeout = 15_000) {
  const url = new URL(route, base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('scheduler API must be loopback HTTP');
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: bytes ? 'POST' : 'GET', headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {} }, res => {
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 16 * 1024 * 1024) req.destroy(Error('API response too large')); else chunks.push(b); });
      res.on('error', reject);
      res.on('end', () => { try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode >= 400 || value.error || value.success === false || value.ok === false) throw Error(`HTTP ${res.statusCode}: ${String(value.error || 'rejected').slice(0, 150)}`);
        resolve(value);
      } catch (error) { reject(error); } });
    });
    req.setTimeout(timeout, () => req.destroy(Error('API timeout; outcome must be reconciled, not retried')));
    req.on('error', reject); if (bytes) req.write(bytes); req.end();
  });
}

export function eligibleAccounts(snapshot, now, attemptAt) {
  if (!snapshot?.enabled || snapshot.ok !== true || !Array.isArray(snapshot.accounts)) return [];
  return snapshot.accounts.filter(a => {
    const delta = Date.parse(a.resetAt) - now, fetched = Date.parse(a.fetchedAt);
    return !a.error && a.stale === false && a.allowed === true && a.cooldownMinLeft === 0
      && typeof a.remainingPercent === 'number' && a.remainingPercent > 0
      && delta > 0 && delta < RESET_LIMIT_MS && Number.isFinite(fetched)
      && fetched >= attemptAt && fetched <= now + 1000 && now - fetched <= 300_000;
  }).sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt));
}

export async function refreshQuota(api, { now = Date.now, wait = sleep, log = () => {} } = {}) {
  let snapshot = await api('/account-usage?refresh=1');
  const attemptAt = Date.parse(snapshot.lastAttemptAt), deadline = now() + 60_000;
  if (!Number.isFinite(attemptAt)) throw Error('quota refresh has no attempt timestamp');
  // refresh=1 starts asynchronous work; its immediate response is NOT fresh evidence.
  while (snapshot.refreshing || Date.parse(snapshot.lastCompletedAt) < attemptAt) {
    if (now() >= deadline) throw Error('quota refresh did not complete within 60s');
    log('quota-refresh-pending'); await wait(1000); snapshot = await api('/account-usage');
  }
  if (!(Date.parse(snapshot.lastCompletedAt) >= attemptAt)) throw Error('invalid quota completion timestamp');
  for (const a of snapshot.accounts || []) if (a.error || a.stale) log('account-unavailable', { account: a.id, reason: a.error || 'stale' });
  return { snapshot, attemptAt };
}

function readSlice(file, length, tail = false) {
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size, start = tail ? Math.max(0, size - length) : 0;
    const b = Buffer.alloc(Math.min(length, size)); fs.readSync(fd, b, 0, b.length, start);
    const text = b.toString('utf8'); return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

export function listSessionFiles(agentDir, log) {
  const root = path.join(agentDir, 'sessions'), result = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(root, dir.name))) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(root, dir.name, file);
      try {
        const head = readSlice(full, 128 * 1024), lines = head.split('\n');
        const header = JSON.parse(lines[0]);
        if (header.type !== 'session' || !header.id || !header.cwd) throw Error('invalid session header');
        let first = '';
        for (const line of lines.slice(1, -1)) { const e = JSON.parse(line); if (e.type === 'message' && e.message?.role === 'user' && !control(textOf(e.message))) { first = textOf(e.message); break; } }
        result.push({ id: header.id, cwd: header.cwd, file: full, first, mtime: fs.statSync(full).mtimeMs });
      } catch (error) { log('session-scan-failed', { file: full, reason: error.message }); throw error; }
    }
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}

export function readSession(session) {
  const lines = fs.readFileSync(session.file, 'utf8').split('\n'), entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { entries.push(JSON.parse(lines[i])); }
    catch (error) { throw Error(`session has incomplete/invalid record: ${session.id}:${i + 1}: ${error.message}`); }
  }
  const byId = new Map(entries.filter(e => e.id && e.type !== 'session').map(e => [e.id, e]));
  const branch = []; let at = entries.findLast(e => e.id && e.type !== 'session'); const seen = new Set();
  while (at) { if (seen.has(at.id)) throw Error('cyclic session branch'); seen.add(at.id); branch.push(at); at = byId.get(at.parentId); }
  branch.reverse();
  const messages = branch.filter(e => e.type === 'message' && e.message);
  const activity = messages.filter(e => ['assistant', 'toolResult'].includes(e.message.role)).at(-1);
  const users = messages.filter(e => e.message.role === 'user').map(e => textOf(e.message)).filter(s => s.trim() && !control(s));
  const lastAssistant = messages.findLast(e => e.message.role === 'assistant' && textOf(e.message).trim());
  return { ...session, users, first: users[0] || session.first, activityAt: Date.parse(activity?.timestamp),
    revision: activity?.id, last: textOf(lastAssistant?.message), lastUser: users.at(-1) || '',
    name: entries.findLast(e => e.type === 'session_info')?.name || '',
    lastStopReason: messages.findLast(e => e.message.role === 'assistant')?.message.stopReason };
}

export function explicitPending(text) {
  // Only task-shaped records; prose, code samples and quoted instructions cannot opt in.
  const plain = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '');
  const result = [];
  for (const line of plain.split(/\r?\n/u)) {
    const clean = line.replace(/\*\*/gu, '').trim();
    let m = clean.match(/^[-*+]\s+\[ \]\s*\[?(P[01])\]?\s*[:：\-—]?\s+(.+)$/u)
      || clean.match(/^(?:[-*+]\s+)?\[?(P[01])\]?\s*[:：\-—]\s*(.+?(?:未完成|待执行|待修复|待验证).*)$/u);
    if (!m && /^\|/u.test(clean)) {
      const cells = clean.split('|').map(s => s.trim()).filter(Boolean), priority = cells.find(s => /^P[01]$/u.test(s));
      if (priority && cells.some(s => /^(未完成|待执行|待修复|待验证)$/u.test(s))) m = ['', priority, cells.filter(s => s !== priority && !/^(未完成|待执行|待修复|待验证)$/u.test(s)).join(' · ')];
    }
    if (m && !/等待(?:用户|授权|确认)|需(?:要)?用户|已取消|已完成|暂停|阻塞/u.test(m[2])) result.push({ priority: m[1], text: m[2].trim() });
  }
  return result;
}

function isStopped(s) {
  return s.lastStopReason === 'aborted' || /^(?:停止|取消|暂停)(?:任务|执行|自动|续做)?[。！!\s]*$/u.test(s.lastUser.trim())
    || /(?:^|\n)\s*(?:\*\*)?(?:任务已完成|全部完成|已确认达标|任务已取消|任务已暂停|等待用户(?:确认|授权)|当前阻塞)[^\n]*$/u.test(s.last.trim());
}

function referencedPending(s, log) {
  const found = [];
  for (const m of (s.last + '\n' + s.lastUser).matchAll(/`([^`\n]+\.md)`/gu)) {
    const file = path.resolve(s.cwd, m[1]);
    if (!norm(file).startsWith(norm(s.cwd) + '/') || !fs.existsSync(file)) continue;
    try { for (const item of explicitPending(readSlice(file, 128 * 1024, true))) found.push({ ...item, taskFile: file }); }
    catch (error) { log('task-file-skipped', { file, reason: error.message }); }
  }
  return found;
}

export function buildTasks(sessions, now, log, { includeBacktests = stockBacktestsAllowed() } = {}) {
  const tasks = [], fixedSources = new Set();
  for (const fixed of FIXED_TASKS) {
    // No cross-project scheduler discussion: the task must mention only this backtest.
    const candidates = sessions.filter(s => (fixed.match.test(s.first) && !FIXED_TASKS.some(f => f.key !== fixed.key && f.match.test(s.first)))
      || path.basename(s.cwd).startsWith(fixed.directory));
    for (const c of candidates) fixedSources.add(c.id);
    if (!includeBacktests) { log('fixed-task-excluded', { task: fixed.title, reason: 'stock-backtests-project-host-only' }); continue; }
    const source = candidates[0];
    if (!source) throw Error(`fixed task source missing: ${fixed.title}`);
    const s = readSession(source);
    const authority = candidates.find(c => !c.first.startsWith('额度调度任务：'));
    if (authority && authority.id !== source.id) {
      const original = readSession(authority);
      s.first = original.first;
      s.users = [...original.users, ...s.users.filter(u => !u.startsWith('额度调度任务：'))];
    }
    let cwd;
    for (const candidate of candidates) if (path.basename(candidate.cwd).startsWith(fixed.directory) && fs.existsSync(candidate.cwd)) { cwd = candidate.cwd; break; }
    if (!cwd && fs.existsSync(source.cwd)) {
      const dirs = fs.readdirSync(source.cwd, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith(fixed.directory));
      if (dirs.length === 1) cwd = path.join(source.cwd, dirs[0].name);
    }
    if (!cwd) throw Error(`fixed project directory missing or ambiguous: ${fixed.title}`);
    tasks.push({ ...fixed, cwd, source: s });
  }
  const recent = new Map();
  for (const meta of sessions) {
    if (meta.mtime < now - INTERVAL_MS || fixedSources.has(meta.id)) continue;
    const s = readSession(meta), age = now - s.activityAt;
    if (!Number.isFinite(age) || age < 0 || age > INTERVAL_MS) { log('recent-task-skipped', { sessionId: s.id, reason: 'no-execution-in-last-30m' }); continue; }
    if (isStopped(s)) { log('recent-task-skipped', { sessionId: s.id, reason: 'completed-cancelled-or-blocked' }); continue; }
    const pending = [...explicitPending(s.last), ...referencedPending(s, log)];
    if (!pending.length) log('recent-task-skipped', { sessionId: s.id, reason: 'no-explicit-incomplete-P0-P1' });
    for (const item of pending) {
      if (!includeBacktests && (stockText(item.text) || stockText(s.first) || stockText(s.cwd))) {
        log('recent-task-skipped', { sessionId: s.id, reason: 'stock-backtests-project-host-only' }); continue;
      }
      const key = 'recent-' + hash(norm(s.cwd) + '\n' + item.text.replace(/\s+/gu, ' ').trim());
      const task = { key, title: `${item.priority} ${item.text}`, cwd: s.cwd, source: s, ...item };
      if (!recent.has(key) || recent.get(key).source.activityAt < s.activityAt) recent.set(key, task);
    }
  }
  return [...tasks, ...[...recent.values()].sort((a, b) => a.priority.localeCompare(b.priority))];
}

export function taskPrompt(task, receiptKey) {
  const source = task.source;
  const requests = [...new Set([source.first, ...source.users.slice(-5)])].filter(s => s && !s.startsWith('额度调度任务：'));
  return `额度调度任务：${task.key}\n派发编号：${receiptKey}\n执行【${task.title}】，这是独立新对话，达标模式已由脚本开启。\n项目目录：${task.cwd}\n来源会话：${source.id}\n来源文件：${source.file}\n\n原始要求及最近用户要求（后者优先）：\n${requests.join('\n\n')}\n\n最近进度原文：\n${source.last || '请读取来源会话的最新执行记录。'}\n\n${task.text ? `本次明确未完成项：${task.priority} ${task.text}\n` : ''}${task.taskFile ? `任务文件：${task.taskFile}\n` : ''}先核对项目现有文件和最新进度，再继续实际执行与验证，不重复已完成工作。保持原任务目标、验收标准和授权边界；如来源信息不足，读取上述来源会话及项目文件，不另起目标。只做已有授权的研究/开发/回测，不进行实盘交易或转移资金；需要用户决策或授权时停止并说明。不得为了达标虚构结果、使用未来信息或放宽验收条件。`;
}

export function stateBusy(state) {
  if (!state || !['isStreaming', 'isPromptRunning', 'isBashRunning', 'isCompacting'].every(k => typeof state[k] === 'boolean') || typeof state.pendingMessageCount !== 'number') throw Error('unrecognized pi-web runtime state');
  return state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting || state.pendingMessageCount > 0
    || Object.values(state.queuedMessages || {}).some(a => Array.isArray(a) && a.length)
    || (state.extensionStatuses || []).some(s => s.key === 'lop-followup' && /\d+\/\d+/u.test(s.text) && !/暂停/u.test(s.text));
}

export async function checkIdle(api, sessions, ignore = new Set()) {
  const running = await api('/api/agent/running');
  if (!Array.isArray(running.runningSessionIds)) throw Error('invalid running session list');
  const busy = new Set(running.runningSessionIds.filter(id => !ignore.has(id)));
  if (busy.size) return [...busy];
  // running endpoint omits idle sessions with queued follow-ups; check all native IDs without restoring them.
  for (let at = 0; at < sessions.length; at += 16) await Promise.all(sessions.slice(at, at + 16).filter(s => !ignore.has(s.id)).map(async s => {
    const value = await api(`/api/agent/${encodeURIComponent(s.id)}`);
    if (value.running === false && !value.state) return;
    if (stateBusy(value.state)) busy.add(s.id);
  }));
  return [...busy];
}

function saveJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, file);
}

export function acquireLock(root, log) {
  fs.mkdirSync(root, { recursive: true }); const lock = path.join(root, 'lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner; try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); }
    catch { if (Date.now() - fs.statSync(lock).mtimeMs < 600_000) { log('skip', { reason: 'lock-owner-being-written' }); return null; } }
    if (owner?.pid) { try { process.kill(owner.pid, 0); log('skip', { reason: 'overlapping-instance', pid: owner.pid }); return null; } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    const history = path.join(root, '_历史版本'); fs.mkdirSync(history, { recursive: true });
    fs.renameSync(lock, path.join(history, `stale-lock-${Date.now()}`)); log('stale-lock-recovered', { pid: owner?.pid }); fs.mkdirSync(lock);
  }
  saveJson(path.join(lock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
  return () => { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); };
}

export async function dispatchBatch({ tasks, api, state, save, log, now = Date.now, guard = async () => [] }) {
  const slot = Math.floor(now() / INTERVAL_MS), owned = new Set(), sent = [];
  for (const task of tasks) {
    const key = `${slot}/${task.key}`, revisionKey = `${task.key}/${task.source.id}/${task.source.revision || 'none'}`;
    const existing = state.records.find(r => r.key === key || (task.key.startsWith('recent-') && r.revisionKey === revisionKey));
    if (existing) { log('task-skipped', { task: task.title, reason: 'already-attempted', status: existing.status, sessionId: existing.sessionId }); continue; }
    const busy = await guard(owned);
    if (busy.length) { log('batch-stopped', { reason: 'external-task-started', busy }); break; }
    const record = { key, revisionKey, taskKey: task.key, title: task.title, at: now(), status: 'creating' };
    state.records.push(record); save(); // write-ahead receipt BEFORE any mutating HTTP request
    try {
      const created = await api('/api/agent/new', { cwd: task.cwd, type: 'ensure_session' });
      if (!created.sessionId) throw Error('new session response missing id');
      record.sessionId = created.sessionId; record.status = 'created'; owned.add(record.sessionId); save();
      const route = `/api/agent/${encodeURIComponent(record.sessionId)}`;
      await api(route, { type: 'set_session_name', name: `${task.title} · 额度续做 ${new Date(record.at).toISOString().slice(0, 16)}` });
      const commands = await api(route, { type: 'get_commands' });
      if (!commands.data?.commands?.some(c => c.name === 'lop-followup' && c.source === 'extension')) throw Error('lop-followup extension not loaded');
      await api(route, { type: 'prompt', message: '/lop-followup target' });
      const readback = await api(route, { type: 'get_state' });
      if (!(readback.data?.extensionStatuses || []).some(s => s.key === 'lop-followup' && /达标/u.test(s.text) && /待发送/u.test(s.text))) throw Error('target mode not armed');
      record.status = 'armed'; save();
      const external = await guard(owned);
      if (external.length) {
        await api(route, { type: 'prompt', message: '/lop-followup off' });
        record.status = 'not-sent-busy'; save(); log('batch-stopped', { reason: 'external-task-started', busy: external }); break;
      }
      record.status = 'sending'; save();
      await api(route, { type: 'prompt', message: taskPrompt(task, key) });
      record.status = 'accepted'; save(); sent.push(record.sessionId);
      log('task-accepted', { task: task.title, sessionId: record.sessionId, key });
    } catch (error) {
      record.status = record.status === 'sending' ? 'uncertain' : 'failed'; record.reason = error.message; save();
      log('task-failed', { task: task.title, sessionId: record.sessionId, status: record.status, reason: error.message });
      // Never replay an ambiguous prompt; later ticks inspect the known native session.
    }
  }
  return sent;
}

export function reconcileReceipts(state, sessions, log) {
  for (const r of state.records) {
    if (!['uncertain', 'sending', 'creating', 'created', 'armed'].includes(r.status)) continue;
    if (!['uncertain', 'sending'].includes(r.status)) {
      r.status = 'failed'; r.reason = 'interrupted-before-task-send';
      log('receipt-reconciled', { key: r.key, reason: r.reason }); continue;
    }
    const session = sessions.find(s => s.id === r.sessionId);
    if (session && readSession(session).users.some(u => u.startsWith(`额度调度任务：${r.taskKey}\n派发编号：${r.key}\n`))) {
      r.status = 'accepted'; delete r.reason;
      log('receipt-reconciled', { key: r.key, sessionId: r.sessionId, reason: 'task-found-in-native-session' });
    } else {
      r.status = 'uncertain'; log('receipt-unresolved', { key: r.key, sessionId: r.sessionId, reason: r.reason || 'no-native-acceptance-evidence; not-replayed' });
    }
  }
  return state.records.filter(r => r.status === 'uncertain');
}

export async function runScheduler({ dataRoot, apiBase = 'http://127.0.0.1:30140', usageBase = 'http://127.0.0.1:8794', dryRun = false, now = Date.now } = {}) {
  if (!dataRoot) throw Error('dataRoot required');
  const root = path.join(dataRoot, 'quota-idle-scheduler'), agentDir = path.join(dataRoot, '.pi', 'agent');
  const log = (event, details = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
    const result = appendLineRotating(path.join(root, 'scheduler.log'), line, { maxBytes: 5 * 1024 * 1024, keep: 3 });
    if (!result.ok) throw Error(`scheduler log write failed: ${result.error}`); console.log(line);
  };
  const release = acquireLock(root, log); if (!release) return { skipped: 'overlap' };
  try {
    log('tick', { dryRun, pid: process.pid, hostname: os.hostname(), stockBacktests: stockBacktestsAllowed() });
    const { snapshot, attemptAt } = await refreshQuota(route => requestJson(usageBase, route), { log, now });
    const accounts = eligibleAccounts(snapshot, now(), attemptAt);
    if (!accounts.length) { log('skip', { reason: 'no-account-with-remaining-quota-reset-under-24h' }); return { skipped: 'quota' }; }
    log('quota-eligible', { accounts: accounts.map(a => ({ id: a.id, remainingPercent: a.remainingPercent, resetAt: a.resetAt })) });
    const sessions = listSessionFiles(agentDir, log), api = (route, body) => requestJson(apiBase, route, body);
    const busy = await checkIdle(api, sessions);
    if (busy.length) { log('skip', { reason: 'pi-web-busy', busy }); return { skipped: 'busy', busy }; }
    const tasks = buildTasks(sessions, now(), log);
    log('batch-planned', { tasks: tasks.map(t => ({ key: t.key, title: t.title, cwd: t.cwd, source: t.source.id })) });
    if (dryRun) return { dryRun: true, tasks: tasks.map(t => ({ key: t.key, title: t.title, cwd: t.cwd })), modelCalls: 0 };
    const stateFile = path.join(root, 'receipts.json');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, records: [] };
    if (state.version !== 1 || !Array.isArray(state.records)) throw Error('invalid receipts; refusing unsafe replay');
    const unresolved = reconcileReceipts(state, sessions, log);
    // Bounded mechanical receipts, not a task/history index; unresolved outcomes are retained.
    state.records = state.records.filter(r => r.status === 'uncertain' || r.at >= now() - 7 * RESET_LIMIT_MS);
    saveJson(stateFile, state);
    const safeTasks = tasks.filter(t => { if (unresolved.some(r => r.taskKey === t.key)) { log('task-skipped', { task: t.title, reason: 'unresolved-request-outcome' }); return false; } return true; });
    const sent = await dispatchBatch({ tasks: safeTasks, api, state, save: () => saveJson(stateFile, state), log, now,
      guard: owned => checkIdle(api, sessions, owned) });
    log('tick-complete', { accepted: sent.length }); return { accepted: sent };
  } catch (error) { log('tick-failed', { reason: error.message }); throw error; }
  finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
  runScheduler({ dataRoot: arg('--data-root') || process.env.PI_PORTABLE_DATA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data'),
    apiBase: arg('--api'), usageBase: arg('--usage'), dryRun: process.argv.includes('--dry-run') })
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
