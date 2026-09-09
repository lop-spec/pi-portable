import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { exclusive } from '../tools/phone.mjs';
import { parseWorkspaceCommand, validateReply, workspaceLease, rpc } from '../tools/phone-workspaces.mjs';

test('workspace names and packages cannot become shell syntax', () => {
  assert.deepEqual(parseWorkspaceCommand(['open', 'a', 'com.miui.calculator']), { op: 'open', workspace: 'a', package: 'com.miui.calculator' });
  for (const name of ['../a', 'a;reboot', '', 'a b']) assert.throws(() => parseWorkspaceCommand(['open', name, 'com.example.app']));
  assert.throws(() => parseWorkspaceCommand(['open', 'a', 'com.a;reboot']));
});
test('actions require an observed snapshot; main-display and global keys are not exposed', () => {
  assert.throws(() => parseWorkspaceCommand(['tap', 'a', '20', '30']), /snapshot/);
  assert.throws(() => parseWorkspaceCommand(['key', 'a', 'HOME', 'snap']), /Unsupported/);
  assert.throws(() => parseWorkspaceCommand(['tap', 'a', '-1', '30', 'snap']));
  assert.deepEqual(parseWorkspaceCommand(['text', 'a', 'w2:0.1', '中文输入', 'snap']), { op: 'text', workspace: 'a', ref: 'w2:0.1', text: '中文输入', snapshot: 'snap' });
});
test('batch only groups explicit reads; no duplicate workspaces or unbounded fanout', () => {
  assert.deepEqual(parseWorkspaceCommand(['observe', 'a', 'b']), { op: 'observe', workspaces: ['a', 'b'] });
  assert.throws(() => parseWorkspaceCommand(['observe', 'a', 'a']));
  assert.throws(() => parseWorkspaceCommand(['observe', 'a', 'b', 'c']));
});
test('responses must match request identity; errors never become default-display fallback', () => {
  assert.throws(() => validateReply({ id: 'wrong', ok: true }, 'req'), /identity/);
  assert.throws(() => validateReply({ id: 'req', ok: false, error: 'STALE_SNAPSHOT' }, 'req'), /STALE_SNAPSHOT/);
  assert.deepEqual(validateReply({ id: 'req', ok: true, result: { displayId: 5 } }, 'req'), { displayId: 5 });
});
test('same workspace serializes, independent workspaces overlap, queue survives failure', async () => {
  const events = [];
  let active = 0, maxActive = 0;
  const work = (key, fail = false) => workspaceLease(key, async () => {
    events.push(key); active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 40)); active--;
    if (fail) throw Error('probe');
  });
  await Promise.all([work('a'), work('a'), work('b')]);
  assert.equal(maxActive, 2);
  await assert.rejects(work('a', true), /probe/);
  await work('a');
});
test('startup retains the existing cross-process phone gate until the async handshake settles', async () => {
  const ctx = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'phone-start-gate-')) };
  let finish;
  const running = exclusive(ctx, () => new Promise(resolve => { finish = resolve; }));
  assert.ok(fs.existsSync(path.join(ctx.dir, 'operation.lock')));
  assert.throws(() => exclusive(ctx, () => {}), /Another phone operation/);
  finish('ready'); assert.equal(await running, 'ready');
  assert.equal(fs.existsSync(path.join(ctx.dir, 'operation.lock')), false);
  await assert.rejects(exclusive(ctx, async () => { throw Error('startup failed'); }), /startup failed/);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'operation.lock')), false);
});
test('RPC accepts fragmented UTF-8 and never retries a timed-out action', async () => {
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    socket.once('data', data => {
      const request = JSON.parse(data.toString());
      if (request.op === 'timeout') return;
      const response = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { text: '中文' } }) + '\n');
      socket.write(response.subarray(0, response.length - 6));
      setTimeout(() => socket.end(response.subarray(response.length - 6)), 10);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    assert.deepEqual(await rpc(server.address().port, { op: 'probe' }), { text: '中文' });
    await assert.rejects(rpc(server.address().port, { op: 'timeout' }, { timeout: 50 }), /do not replay/);
    assert.equal(connections, 2);
  } finally { server.close(); }
});
test('Android hard gates are present: shell-only transport, two slots, app lease, stale guard, no clipboard', () => {
  const java = fs.readFileSync(new URL('../src/phone/WorkspaceServer.java', import.meta.url), 'utf8');
  for (const signature of ['getPeerCredentials', 'MAX_WORKSPACES = 2', 'APP_ALREADY_LEASED', 'STALE_SNAPSHOT', 'MAIN_DISPLAY_APP_BUSY', 'FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES', 'VIRTUAL_DISPLAY_FLAG_OWN_FOCUS', 'VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED']) assert.ok(java.includes(signature), signature);
  assert.ok(!java.includes('setPrimaryClip'));
  assert.ok(!java.includes('KEYCODE_HOME'));
});
