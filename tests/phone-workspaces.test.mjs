import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { exclusive } from '../tools/phone.mjs';
import { MAX_WORKSPACES, requireWorkspaceCapacity, parseWorkspaceCommand, validateReply, workspaceLease, rpc, reconcileWorkspaceState, readWorkspaceState } from '../tools/phone-workspaces.mjs';

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
  const ten = Array.from({ length: 10 }, (_, i) => `w${i}`);
  assert.deepEqual(parseWorkspaceCommand(['observe', ...ten]), { op: 'observe', workspaces: ten });
  assert.throws(() => parseWorkspaceCommand(['observe', ...ten, 'eleventh']));
  assert.throws(() => parseWorkspaceCommand(['observe']));
});
test('ten-slot client cannot report success while reusing a legacy two-slot broker', () => {
  assert.equal(MAX_WORKSPACES, 10);
  assert.throws(() => requireWorkspaceCapacity({ maxWorkspaces: 2 }), /BROKER_CAPACITY_MISMATCH/);
  assert.throws(() => requireWorkspaceCapacity({}), /legacy\/unknown/);
  const ping = { maxWorkspaces: 10, version: 'matching' };
  assert.equal(requireWorkspaceCapacity(ping), ping);
});
test('ten independent host workspaces can overlap without losing per-workspace serialization', async () => {
  let active = 0, peak = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const jobs = Array.from({ length: MAX_WORKSPACES }, (_, i) => workspaceLease(`ten-${i}`, async () => {
    active++; peak = Math.max(peak, active);
    if (active === MAX_WORKSPACES) release();
    await barrier; active--;
  }));
  await Promise.all(jobs); assert.equal(peak, 10); assert.equal(active, 0);
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
function staleContext({ socket = false, processAlive = false, invalidProbe = false } = {}) {
  const ctx = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reconnect-test-')), device: { serial: 'test-device' }, calls: [] };
  fs.writeFileSync(path.join(ctx.dir, 'workspaces.json'), JSON.stringify({ serial: ctx.device.serial, port: 53001, instance: 'test-instance', version: 'test-version' }));
  ctx.adb = args => {
    ctx.calls.push(args);
    if (args[1] === 'cat') return invalidProbe ? '' : 'Num       RefCount Protocol Flags Type St Inode Path\n' + (socket ? '000 1 0 10000 1 1 1 @pi_phone_workspaces_v1\n' : '');
    if (args[1] === 'ps') return invalidProbe ? '' : 'PID NAME ARGS\n' + (processAlive ? '123 app_process com.lop.phone.WorkspaceServer\n' : '');
    if (args[1] === 'tcp:0') return '53002';
    if (args[1] === '--remove') return '';
    throw Error('Unexpected command: ' + args.join(' '));
  };
  return ctx;
}
test('expired broker state is archived only after proving both socket and process absent', () => {
  const ctx = staleContext();
  assert.equal(reconcileWorkspaceState(ctx, { probe: () => { throw Error('ECONNREFUSED'); } }), null);
  assert.equal(readWorkspaceState(ctx), null);
  assert.ok(ctx.calls.every(a => a[0] === 'shell'));
});
test('rapid recoveries sharing one history directory preserve every physical backup', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-shared-history-'));
  const history = path.join(parent, '_历史版本'); fs.mkdirSync(history);
  for (let i = 0; i < 3; i++) {
    const ctx = staleContext();
    const content = fs.readFileSync(path.join(ctx.dir, 'workspaces.json'));
    ctx.dir = path.join(parent, String(i)); fs.mkdirSync(ctx.dir);
    fs.writeFileSync(path.join(ctx.dir, 'workspaces.json'), content);
    assert.equal(reconcileWorkspaceState(ctx, { probe: () => { throw Error('ECONNREFUSED'); } }), null);
  }
  const backups = fs.readdirSync(history);
  assert.equal(backups.length, 3);
  for (const name of backups) {
    assert.match(name, /-workspace-[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(history, name))).instance, 'test-instance');
  }
});
test('lost forward reconnects existing verified broker without restarting or replaying actions', () => {
  const ctx = staleContext({ socket: true, processAlive: true });
  const requests = [];
  const recovered = reconcileWorkspaceState(ctx, { probe: (port, request) => {
    requests.push(request.op);
    if (port === 53001) throw Error('ECONNREFUSED');
    return { instance: 'test-instance', version: 'test-version' };
  }});
  assert.equal(recovered.port, 53002);
  assert.equal(readWorkspaceState(ctx).port, 53002);
  assert.deepEqual(requests, ['ping', 'ping']);
  assert.ok(!ctx.calls.some(a => a.join(' ').includes('app_process')));
});
for (const fault of [{ socket: true }, { processAlive: true }, { invalidProbe: true }]) {
  test('ambiguous broker liveness fails closed: ' + JSON.stringify(fault), () => {
    const ctx = staleContext(fault);
    assert.throws(() => reconcileWorkspaceState(ctx, { probe: () => { throw Error('probe failed'); } }));
    assert.equal(readWorkspaceState(ctx).port, 53001);
    assert.ok(ctx.calls.every(a => a[0] === 'shell'));
  });
}
test('a changed broker identity cannot be taken over and new forward is cleaned', () => {
  const ctx = staleContext({ socket: true, processAlive: true });
  assert.throws(() => reconcileWorkspaceState(ctx, { probe: port => {
    if (port === 53001) throw Error('ECONNREFUSED');
    return { instance: 'other-instance', version: 'test-version' };
  }}), /identity changed/);
  assert.equal(readWorkspaceState(ctx).port, 53001);
  assert.deepEqual(ctx.calls.at(-1), ['forward', '--remove', 'tcp:53002']);
});
test('Android hard gates are present: shell-only transport, ten slots, app lease, stale guard, no clipboard', () => {
  const java = fs.readFileSync(new URL('../src/phone/WorkspaceServer.java', import.meta.url), 'utf8');
  assert.equal(Number(java.match(/MAX_WORKSPACES = (\d+)/)[1]), MAX_WORKSPACES);
  assert.ok(java.includes('new ArrayBlockingQueue<>(MAX_WORKSPACES * 2)'));
  assert.ok(java.includes('clientThreads = MAX_WORKSPACES + 2'));
  assert.ok(java.includes('deadline - System.nanoTime()'));
  assert.ok(java.indexOf('targets.add(get(name))') < java.indexOf('observations.submit'));
  for (const signature of ['getPeerCredentials', 'MAX_WORKSPACES = 10', 'APP_ALREADY_LEASED', 'STALE_SNAPSHOT', 'MAIN_DISPLAY_APP_BUSY', 'FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES', 'VIRTUAL_DISPLAY_FLAG_OWN_FOCUS', 'VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED']) assert.ok(java.includes(signature), signature);
  assert.ok(!java.includes('setPrimaryClip'));
  assert.ok(!java.includes('KEYCODE_HOME'));
});
