import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { forwardGoalRequest, GOAL_KEY_HEADER, goalKeyMatches, publishGoalEndpoint, requestDesktopGoal } from '../src/desktop/goal-execution.mjs';

test('authorized scheduled caller reaches the same desktop agent operations and only those operations', { skip: process.platform !== 'win32' }, async () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-goal-ipc-'));
  const pipe = `\\\\.\\pipe\\piweb-desktop-${randomBytes(24).toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const server = http.createServer((req, res) => {
    if (!goalKeyMatches(req.headers[GOAL_KEY_HEADER], token)) { res.writeHead(403); res.end(); return; }
    void forwardGoalRequest(req, res, async (target, init) => {
      calls.push({ route: new URL(target).pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (target.endsWith('/running')) return Response.json({ runningSessionIds: ['s1'] });
      if (target.endsWith('/new')) return Response.json({ sessionId: 's2' });
      return Response.json({ success: true });
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    const off = publishGoalEndpoint(p, pipe, token);
    assert.deepEqual(await requestDesktopGoal(p, '/api/agent/running'), { runningSessionIds: ['s1'] });
    assert.deepEqual(await requestDesktopGoal(p, '/api/agent/new', { type: 'ensure_session', cwd: 'D:/工作', provider: 'pi-chatgpt-web', modelId: 'chatgpt-web-astra', thinkingLevel: 'max' }), { sessionId: 's2' });
    const bodies = [{ type: 'get_state' }, { type: 'prompt', message: '测试原任务单', streamingBehavior: 'steer' }, { type: 'steer', message: '原指令' }];
    for (const body of bodies) await requestDesktopGoal(p, '/api/agent/s1', body);
    assert.deepEqual(calls.slice(-3).map(c => c.body), bodies);
    const raw = (route, headers, value) => new Promise((resolve, reject) => {
      const data = value && Buffer.from(JSON.stringify(value));
      const req = http.request({ socketPath: pipe, path: route, method: data ? 'POST' : 'GET', headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.once('error', reject); req.end(data);
    });
    assert.equal(await raw('/api/agent/running', {}), 403);
    assert.equal(await raw('/api/settings', { [GOAL_KEY_HEADER]: token }), 403);
    assert.equal(await raw('/api/agent/s1', { [GOAL_KEY_HEADER]: token }, { type: 'abort' }), 400);
    assert.equal(await raw('/api/agent/running', { [GOAL_KEY_HEADER]: token, origin: 'https://goal.piweb.invalid' }), 403);
    assert.equal(calls.length, 5);
    off();
    await assert.rejects(requestDesktopGoal(p, '/api/agent/running'), /未启动/);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(p, { recursive: true, force: true }); }
});
