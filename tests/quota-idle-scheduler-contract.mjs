import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERVAL_MS, RESET_LIMIT_MS, eligibleAccounts, refreshQuota, explicitPending, stateBusy, checkIdle,
  dispatchBatch, taskPrompt, readSession, listSessionFiles, buildTasks, acquireLock, requestJson, reconcileReceipts, stockBacktestsAllowed, SCHEDULED_MODEL } from '../src/quota-idle-scheduler.mjs';
const now = Date.parse('2026-09-07T00:00:00Z');
const account = { id: 'a', remainingPercent: 1, resetAt: new Date(now + 3600_000).toISOString(), fetchedAt: new Date(now).toISOString(), stale: false, allowed: true, cooldownMinLeft: 0, error: null };
const quota = a => ({ ok: true, enabled: true, accounts: [a] });
const noop = () => {};
const source = { id: 'source', file: 'source.jsonl', first: '原始要求', users: ['原始要求', '后续更正'], revision: 'r1', last: '最近进度' };
const tasks = ['eastmoney-backtest', 'douyin-backtest'].map((key, i) => ({ key, title: `回测${i}`, cwd: 'C:/work', source }));
const idle = { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, pendingMessageCount: 0, queuedMessages: { steering: [], followUp: [] }, extensionStatuses: [] };
function fakeApi({ failMode = false, timeoutPrompt = false, failCreate = false, wrongModel = false, wrongThinking = false } = {}) {
  const calls = []; let count = 0;
  const api = async (route, body) => {
    calls.push({ route, body });
    if (route === '/api/agent/new') { if (failCreate) throw Error('timeout'); return { success: true, sessionId: `new-${++count}`, model: { provider: SCHEDULED_MODEL.provider, modelId: wrongModel ? 'default-model' : SCHEDULED_MODEL.modelId }, thinkingLevel: SCHEDULED_MODEL.thinkingLevel }; }
    if (body?.type === 'get_commands') return { data: { commands: [{ name: 'lop-followup', source: 'extension' }] } };
    if (body?.type === 'get_state') return { data: { ...idle, model: { provider: SCHEDULED_MODEL.provider, id: SCHEDULED_MODEL.modelId }, thinkingLevel: wrongThinking ? 'high' : SCHEDULED_MODEL.thinkingLevel, extensionStatuses: failMode ? [] : [{ key: 'lop-followup', text: '自动追问 · 目标 · 达标 · 待发送' }] } };
    if (timeoutPrompt && body?.message?.startsWith('额度调度任务：')) throw Error('timeout');
    return { success: true };
  };
  return { api, calls };
}

test('stock host is exclusively the peer; local/unknown hosts never opt in', () => {
  assert.equal(stockBacktestsAllowed('DESKTOP-3EGB4LB'), true);
  assert.equal(stockBacktestsAllowed('YANGYONG'), false);
  assert.equal(stockBacktestsAllowed('other'), false);
});

test('quota uses strict 0<reset<24h and remaining>0 on the SAME fresh account', () => {
  assert.equal(eligibleAccounts(quota(account), now, now).length, 1);
  for (const change of [ { remainingPercent: 0 }, { remainingPercent: null }, { remainingPercent: '5' }, { resetAt: new Date(now).toISOString() },
    { resetAt: new Date(now - 1).toISOString() }, { resetAt: new Date(now + RESET_LIMIT_MS).toISOString() }, { resetAt: null },
    { stale: true }, { allowed: false }, { cooldownMinLeft: 1 }, { error: 'HTTP 401' }, { fetchedAt: new Date(now - 1).toISOString() } ])
    assert.equal(eligibleAccounts(quota({ ...account, ...change }), now, now).length, 0, JSON.stringify(change));
  assert.equal(eligibleAccounts({ ok: true, enabled: true, accounts: [{ ...account, remainingPercent: 0 }, { ...account, resetAt: new Date(now + 2 * RESET_LIMIT_MS).toISOString() }] }, now, now).length, 0);
});

test('force refresh waits for asynchronous completion and rejects cached initial response', async () => {
  const calls = [], logs = []; let tick = now;
  const initial = { ...quota({ ...account, fetchedAt: new Date(now - 60_000).toISOString() }), refreshing: true, lastAttemptAt: new Date(now).toISOString(), lastCompletedAt: new Date(now - 60_000).toISOString() };
  const result = await refreshQuota(async route => { calls.push(route); return calls.length === 1 ? initial : { ...initial, accounts: [account], refreshing: false, lastCompletedAt: new Date(now).toISOString() }; }, { now: () => tick, wait: async ms => { tick += ms; }, log: e => logs.push(e) });
  assert.deepEqual(calls, ['/account-usage?refresh=1', '/account-usage']);
  assert.equal(eligibleAccounts(result.snapshot, tick, result.attemptAt).length, 1);
  assert.equal(logs[0], 'quota-refresh-pending');
  await assert.rejects(refreshQuota(async () => initial, { now: () => tick, wait: async () => { tick += 60_001; } }), /60s/);
});

test('P0/P1 selection accepts explicit task records, never generic prose or examples', () => {
  assert.deepEqual(explicitPending('- [ ] P0 修复执行错误\n- [ ] **P1** 补回归\n| P1 | 补数据 | 未完成 |').map(x => x.priority), ['P0', 'P1', 'P1']);
  for (const s of ['还有P0和P1未完成的任务请继续', '- [x] P0 已完成', '- [ ] P2 非重要', '```md\n- [ ] P0 示例\n```', '> - [ ] P0 引用', '- [ ] P0 等待用户授权', 'P0: 已完成']) assert.deepEqual(explicitPending(s), [], s);
  assert.equal(explicitPending('P0：数据校验未完成').length, 1);
});

test('global idle covers streams/tools/bash/compaction/queues/followup gaps and unknown fails closed', async () => {
  assert.equal(stateBusy(idle), false);
  for (const key of ['isStreaming', 'isPromptRunning', 'isBashRunning', 'isCompacting']) assert.equal(stateBusy({ ...idle, [key]: true }), true);
  assert.equal(stateBusy({ ...idle, pendingMessageCount: 1 }), true);
  assert.equal(stateBusy({ ...idle, queuedMessages: { followUp: ['queued'] } }), true);
  assert.equal(stateBusy({ ...idle, extensionStatuses: [{ key: 'lop-followup', text: '目标 · 达标 · 2/8' }] }), true);
  assert.throws(() => stateBusy({}), /unrecognized/);
  const busy = await checkIdle(async route => route.endsWith('/running') ? { runningSessionIds: [] } : { running: true, state: { ...idle, pendingMessageCount: 1 } }, [{ id: 'other' }]);
  assert.deepEqual(busy, ['other']);
});

test('two independent new sessions: ensure, name, discover command, arm, readback, task; first does not block second', async () => {
  const { api, calls } = fakeApi(), state = { records: [] }, guards = []; let saves = 0;
  const sent = await dispatchBatch({ tasks, api, state, save: () => saves++, log: noop, now: () => now,
    guard: async owned => { guards.push([...owned]); return []; } });
  assert.deepEqual(sent, ['new-1', 'new-2']); assert.ok(saves >= 10);
  assert.equal(calls.filter(c => c.route === '/api/agent/new').length, 2);
  for (const c of calls.filter(c => c.route === '/api/agent/new')) assert.deepEqual(c.body, { cwd: 'C:/work', type: 'ensure_session', provider: 'openai-codex', modelId: 'gpt-6-astra', thinkingLevel: 'medium' });
  assert.equal(calls.some(c => c.body?.type === 'set_model'), false, 'selection must be explicit in new-session request, without a separate set_model command');
  for (const id of sent) {
    const commands = calls.filter(c => c.route === `/api/agent/${id}`).map(c => c.body);
    assert.deepEqual(commands.map(c => c.type), ['set_session_name', 'get_commands', 'prompt', 'get_state', 'prompt']);
    assert.equal(commands[2].message, '/lop-followup target'); assert.match(commands[4].message, /^额度调度任务：/);
  }
  assert.ok(guards.some(ids => ids.includes('new-1')));
  assert.equal(state.records.every(r => r.status === 'accepted'), true);
  const count = calls.length;
  assert.deepEqual(await dispatchBatch({ tasks, api, state, save: noop, log: noop, now: () => now }), []);
  assert.equal(calls.length, count, 'duplicate tick must perform no mutation');
});

test('wrong model or reasoning readback blocks dispatch instead of silently using defaults', async () => {
  for (const options of [{ wrongModel: true }, { wrongThinking: true }]) {
    const { api, calls } = fakeApi(options), state = { records: [] };
    await dispatchBatch({ tasks, api, state, save: noop, log: noop, now: () => now });
    assert.equal(calls.filter(c => c.body?.message?.startsWith('额度调度任务：')).length, 0);
    assert.ok(state.records.every(r => r.status === 'failed' && /Astra\/medium/u.test(r.reason)));
  }
});

test('mode activation failure never sends a model task', async () => {
  const { api, calls } = fakeApi({ failMode: true }), state = { records: [] };
  await dispatchBatch({ tasks, api, state, save: noop, log: noop, now: () => now });
  assert.equal(calls.filter(c => c.body?.message?.startsWith('额度调度任务：')).length, 0);
  assert.ok(state.records.every(r => r.status === 'failed'));
});

test('external activity during preparation disarms and prevents model request', async () => {
  const { api, calls } = fakeApi(), state = { records: [] }; let n = 0;
  await dispatchBatch({ tasks, api, state, save: noop, log: noop, now: () => now, guard: async () => ++n === 2 ? ['manual'] : [] });
  assert.equal(calls.filter(c => c.body?.message?.startsWith('额度调度任务：')).length, 0);
  assert.ok(calls.some(c => c.body?.message === '/lop-followup off'));
  assert.equal(state.records[0].status, 'not-sent-busy');
});

test('ambiguous HTTP submission is recorded, never retried in same tick', async () => {
  const { api, calls } = fakeApi({ timeoutPrompt: true }), state = { records: [] };
  await dispatchBatch({ tasks, api, state, save: noop, log: noop, now: () => now });
  assert.ok(state.records.every(r => r.status === 'uncertain'));
  assert.equal(calls.filter(c => c.body?.message?.startsWith('额度调度任务：')).length, 2);
  const count = calls.length;
  await dispatchBatch({ tasks, api, state, save: noop, log: noop, now: () => now });
  assert.equal(calls.length, count);
});

test('receipt persisted before create; failed persistence means no mutation', async () => {
  const { api, calls } = fakeApi();
  await assert.rejects(dispatchBatch({ tasks, api, state: { records: [] }, save: () => { throw Error('disk full'); }, log: noop, now: () => now }), /disk full/);
  assert.equal(calls.length, 0);
});

test('native session branch and execution timestamp ignore rename and abandoned branch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-session-')), file = path.join(root, 's.jsonl');
  const entries = [{ type: 'session', id: 's', cwd: root },
    { type: 'message', id: 'u', parentId: null, timestamp: new Date(now - 10000).toISOString(), message: { role: 'user', content: '原始要求' } },
    { type: 'message', id: 'a', parentId: 'u', timestamp: new Date(now - 5000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '- [ ] P0 修复' }] } },
    { type: 'message', id: 'old-branch', parentId: 'a', timestamp: new Date(now - 2000).toISOString(), message: { role: 'assistant', content: '已确认达标' } },
    { type: 'session_info', id: 'rename', parentId: 'a', timestamp: new Date(now).toISOString(), name: 'rename' }];
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const s = readSession({ id: 's', file, cwd: root }); assert.equal(s.revision, 'a'); assert.equal(s.activityAt, now - 5000); assert.equal(s.last, '- [ ] P0 修复');
});

test('fixed projects automatic discovery, recent 30-minute boundary, completed/blocked skipped, no history index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-discovery-')), sessionsRoot = path.join(root, 'sessions', 'project'); fs.mkdirSync(sessionsRoot, { recursive: true });
  for (const name of ['东方财富智能回测分析-test', '抖音短线体系回测-test']) fs.mkdirSync(path.join(root, name));
  let n = 0;
  const add = (first, last, activity, stopReason = 'stop') => { const id = `s${++n}`, file = path.join(sessionsRoot, `${id}.jsonl`); const entries = [{ type: 'session', id, cwd: root }, { type: 'message', id: `${id}-u`, parentId: null, message: { role: 'user', content: first } }, { type: 'message', id: `${id}-a`, parentId: `${id}-u`, timestamp: new Date(activity).toISOString(), message: { role: 'assistant', content: last, stopReason } }]; fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); fs.utimesSync(file, now / 1000, now / 1000); };
  add('继续东方财富智能回测', '未达标', now - 2 * INTERVAL_MS);
  add('继续抖音选股回测', '未达标', now - 2 * INTERVAL_MS);
  add('项目A', '- [ ] P0 修复A', now - INTERVAL_MS);
  add('项目B', '- [ ] P1 修复B', now - INTERVAL_MS - 1);
  add('项目C', '- [ ] P0 修复C\n已确认达标', now - 1000);
  add('项目D', '- [ ] P0 修复D', now - 1000, 'aborted');
  const sessions = listSessionFiles(root, noop); const longGoals = [
    { key: 'eastmoney-backtest', title: '东方财富智能回测', cwd: path.join(root, '东方财富智能回测分析-test'), sourceId: 's1', objective: '继续回测', acceptance: '原标准' },
    { key: 'douyin-backtest', title: '抖音选股智能回测', cwd: path.join(root, '抖音短线体系回测-test'), sourceId: 's2', objective: '继续回测', acceptance: '原标准' },
  ];
  const result = buildTasks(sessions, now, noop, { includeBacktests: true, longGoals });
  assert.equal(result.length, 3); assert.equal(result[2].text, '修复A');
  assert.ok(result[0].cwd.includes('东方财富')); assert.ok(result[1].cwd.includes('抖音'));
  add('普通项目', '- [ ] P0 股票智能回测待执行', now - 1000);
  const local = buildTasks(listSessionFiles(root, noop), now, noop, { includeBacktests: false });
  assert.equal(local.length, 1); assert.equal(local[0].text, '修复A');
  assert.deepEqual(buildTasks([], now, noop, { includeBacktests: false }), [], 'local needs no stock project');
  const withoutFixed = buildTasks(sessions, now, noop, { includeBacktests: true, longGoals: [] });
  assert.equal(withoutFixed.length, 1, 'empty md leaves recent P0/P1 unchanged');
  const broken = buildTasks(sessions, now, noop, { longGoals: [{ key: 'bad', title: '普通目标', cwd: path.join(root, 'missing'), objective: '做事', acceptance: '验证' }] });
  assert.equal(broken.length, 1, 'bad long goal does not block dynamic tasks');
});

test('crash reconciliation distinguishes pre-send from ambiguous send; never silently loses a receipt', () => {
  const state = { records: [{ key: 'a', status: 'creating' }, { key: 'b', status: 'armed' }, { key: 'c', status: 'sending' }] };
  const unresolved = reconcileReceipts(state, [], noop);
  assert.deepEqual(state.records.map(r => r.status), ['failed', 'failed', 'uncertain']);
  assert.equal(unresolved.length, 1);
});

test('automatic continuation prompts do not recursively copy previous scheduler envelopes', () => {
  const prompt = taskPrompt({ ...tasks[0], source: { ...source, first: '额度调度任务：old', users: ['额度调度任务：old'] } }, 'new');
  assert.equal(prompt.match(/额度调度任务：/gu).length, 1);
});

test('prompt keeps source requirements, correction, recent progress, paths and no trading authorization', () => {
  const prompt = taskPrompt(tasks[0], 'test');
  for (const text of ['原始要求', '后续更正', '最近进度', 'source.jsonl', '不进行实盘交易', '不得为了达标虚构结果']) assert.ok(prompt.includes(text));
});

test('physical lock rejects overlapping worker and releases cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-lock-')), logs = [];
  const unlock = acquireLock(root, noop); assert.equal(typeof unlock, 'function');
  assert.equal(acquireLock(root, (e, d) => logs.push([e, d])), null);
  assert.equal(logs[0][1].reason, 'overlapping-instance'); unlock(); assert.equal(fs.existsSync(path.join(root, 'lock')), false);
});

test('API is loopback only and never inherits outbound proxy', () => {
  assert.throws(() => requestJson('http://example.com', '/'), /loopback/);
});

test('Windows launcher hides worker, waits, preserves exit code; scheduled task is 30min/non-overlapping', () => {
  const vbs = fs.readFileSync(new URL('../tools/quota-idle-task.vbs', import.meta.url), 'utf8');
  const ps = fs.readFileSync(new URL('../tools/install-quota-idle-task.ps1', import.meta.url), 'utf8');
  assert.match(vbs, /shell.Run\(command, 0, True\)/); assert.match(vbs, /WScript.Quit result/);
  assert.match(ps, /-RepetitionInterval \(New-TimeSpan -Minutes 30\)/); assert.match(ps, /-MultipleInstances IgnoreNew/); assert.match(ps, /-Hidden/);
  assert.match(ps, /backup\.mjs/); assert.match(ps, /Export-ScheduledTask/);
});
