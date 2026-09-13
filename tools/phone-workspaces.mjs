// Optional, deterministic Android workspaces behind the existing phone readiness/DPAPI entry.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(self));
const log = s => console.error(`[phone-workspaces] ${s}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const namePattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const packagePattern = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const stateFile = ctx => path.join(ctx.dir, 'workspaces.json');
const remoteJar = '/data/local/tmp/pi-phone-workspaces.jar';
const remoteLog = '/data/local/tmp/pi-phone-workspaces.log';
const queues = new Map();
export const MAX_WORKSPACES = 10; // Cross-language agreement is enforced by the CI contract test.

export async function workspaceLease(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(work);
  queues.set(key, task);
  try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
}
function require(condition, message) { if (!condition) throw Error(message); }
export function parseWorkspaceCommand(args) {
  const [op = 'help', workspace, ...rest] = args;
  if (['help', 'start', 'stop', 'list'].includes(op)) { require(args.length <= 1, `Unexpected ${op} arguments`); return { op }; }
  if (op === 'observe') {
    const workspaces = args.slice(1);
    require(workspaces.length >= 1 && workspaces.length <= MAX_WORKSPACES && new Set(workspaces).size === workspaces.length && workspaces.every(x => namePattern.test(x)), `observe requires 1–${MAX_WORKSPACES} distinct workspace names`);
    return { op, workspaces };
  }
  require(namePattern.test(workspace || ''), 'Invalid workspace name');
  if (op === 'open') { require(rest.length === 1 && packagePattern.test(rest[0]), 'open requires a package name'); return { op, workspace, package: rest[0] }; }
  if (['close', 'snapshot'].includes(op)) { require(rest.length === 0, `Unexpected ${op} arguments`); return { op, workspace }; }
  if (op === 'screenshot') { require(rest.length === 1 && rest[0], 'screenshot requires a new output PNG path'); return { op, workspace, output: rest[0] }; }
  if (['click', 'text', 'tap', 'swipe', 'back', 'enter'].includes(op)) {
    const counts = { click: 2, text: 3, tap: 3, swipe: 6, back: 1, enter: 1 };
    require(rest.length === counts[op] && rest.at(-1), `${op} requires arguments and the current snapshot token`);
    const r = { op, workspace };
    if (['click', 'text'].includes(op)) { require(/^w\d+:0(?:\.\d+)*$/.test(rest[0]), 'Invalid node ref'); r.ref = rest[0]; }
    if (op === 'text') { require(rest[1].length <= 8192, 'Text exceeds 8192 characters'); r.text = rest[1]; }
    if (op === 'tap' || op === 'swipe') {
      const numeric = rest.slice(0, -1).map(Number);
      require(numeric.every(x => Number.isSafeInteger(x) && x >= 0), 'Invalid gesture coordinates/duration');
      [r.x, r.y] = numeric;
      if (op === 'swipe') [r.endX, r.endY, r.duration] = numeric.slice(2);
    }
    r.snapshot = rest.at(-1); return r;
  }
  throw Error('Unsupported workspace operation; use phone workspace help');
}
export function requireWorkspaceCapacity(ping) {
  require(ping?.maxWorkspaces === MAX_WORKSPACES, `BROKER_CAPACITY_MISMATCH: client requires ${MAX_WORKSPACES}, broker reports ${ping?.maxWorkspaces ?? 'legacy/unknown'}; install the matching CI artifact and explicitly stop/start. No active workspace was replaced.`);
  return ping;
}
export function validateReply(reply, id) {
  require(reply?.id === id, 'Workspace response identity mismatch');
  require(reply.ok === true, reply.error || 'Workspace request failed without an error reason');
  return reply.result;
}
export function rpc(port, request, { timeout = 22000 } = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    const parts = []; let total = 0, done = false;
    const finish = (error, value) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => socket.write(JSON.stringify({ ...request, id }) + '\n'));
    socket.on('data', bytes => {
      total += bytes.length;
      if (total > 16 * 1024 * 1024) return finish(Error('Workspace response exceeds 16 MiB'));
      parts.push(bytes);
      if (bytes.includes(10)) {
        try { finish(null, validateReply(JSON.parse(Buffer.concat(parts).toString('utf8').trim()), id)); }
        catch (e) { finish(e); }
      }
    });
    socket.once('timeout', () => finish(Error('Workspace RPC timeout; action outcome unknown, do not replay; observe before deciding')));
    socket.once('error', e => finish(Error(`Workspace transport ${e.code || e.message}; no main-display fallback`)));
    socket.once('end', () => { if (!done) finish(Error('Workspace response ended without a complete reply; do not replay actions')); });
  });
}
export function readWorkspaceState(ctx) {
  const filename = stateFile(ctx);
  if (!fs.existsSync(filename)) return null;
  const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
  require(state.serial === ctx.device.serial && Number.isInteger(state.port) && state.port > 0 && state.port <= 65535 && typeof state.instance === 'string', 'Invalid machine-local workspace state; refusing routing');
  return state;
}
function rpcSync(port, request, timeout = 25000) {
  const result = spawnSync(process.execPath, [self, '--internal-rpc', String(port)], {
    windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    input: JSON.stringify(request),
  });
  require(!result.error && result.status === 0, `Shared UI broker unavailable: ${result.error?.code || String(result.stderr).trim().slice(0,400)}; no action replay`);
  return JSON.parse(result.stdout);
}
function backupWorkspaceState(ctx) {
  // Different devices/reconnections can share one history directory within a second.
  const r = spawnSync(process.execPath, [path.join(root, 'tools/backup.mjs'), stateFile(ctx), '--label', `workspace-${crypto.randomUUID()}`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  require(!r.error && r.status === 0, `Workspace state backup failed; state retained: ${r.error?.message || (r.stdout + r.stderr).trim() || `exit ${r.status}`}`);
  log(r.stdout.trim());
}
// Called while holding the phone readiness gate. Only probes/reconnects transport;
// never replays actions, starts a broker, closes live displays, or clears credentials.
export function reconcileWorkspaceState(ctx, { probe = rpcSync } = {}) {
  const state = readWorkspaceState(ctx);
  if (!state) return null;
  try {
    const ping = probe(state.port, { op: 'ping' }, 2500);
    require(ping.instance === state.instance, 'Workspace broker identity changed; no automatic takeover');
    return state;
  } catch (error) {
    if (/identity changed/.test(error.message)) throw error;
    log(`Workspace transport probe failed; checking device ownership before recovery (${error.message}).`);
  }
  // Both successful commands are mandatory; inability to inspect is NOT absence.
  const sockets = ctx.adb(['shell', 'cat', '/proc/net/unix']);
  const processes = ctx.adb(['shell', 'ps', '-A', '-o', 'PID,NAME,ARGS']);
  require(/Num\s+RefCount/.test(sockets) && /PID\s+NAME\s+(?:ARGS|CMD)/.test(processes), 'Cannot establish broker process/socket state; no fallback');
  const socket = /@pi_phone_workspaces_v1(?:\r?\n|$)/.test(sockets);
  const processAlive = /com\.lop\.phone\.WorkspaceServer/.test(processes);
  if (!socket && !processAlive) {
    backupWorkspaceState(ctx);
    fs.unlinkSync(stateFile(ctx));
    log('Broker process and owned socket are both absent; archived stale workspace mapping. Main-phone UI can use the ordinary reader; workspace actions remain stopped.');
    return null;
  }
  require(socket && processAlive, 'Broker process/socket disagree; no second UI connection or automatic restart');
  const port = Number(ctx.adb(['forward', 'tcp:0', 'localabstract:pi_phone_workspaces_v1']).trim());
  require(Number.isInteger(port) && port > 0, 'Cannot allocate replacement workspace forward');
  try {
    const ping = probe(port, { op: 'ping' }, 2500);
    require(ping.instance === state.instance && ping.version === state.version, 'Workspace broker identity changed; no automatic takeover');
    backupWorkspaceState(ctx);
    const next = { ...state, port };
    fs.writeFileSync(stateFile(ctx), JSON.stringify(next, null, 2) + '\n');
    require(readWorkspaceState(ctx).port === port, 'Workspace mapping readback failed');
    log('Repaired lost ADB forward to the verified existing broker; no broker restart or action replay.');
    return next;
  } catch (error) {
    try { ctx.adb(['forward', '--remove', `tcp:${port}`]); } catch (cleanup) { log(`Replacement forward cleanup failed: ${cleanup.message}`); }
    throw error;
  }
}
export function attachWorkspaceUi(ctx, ordinaryUi) {
  if (!readWorkspaceState(ctx)) return;
  // Reconciliation is lazy so it runs inside the existing cross-process gate.
  ctx.dumpUi = () => {
    const state = reconcileWorkspaceState(ctx);
    if (!state) {
      require(typeof ordinaryUi === 'function', 'Broker expired; ordinary main-phone UI reader was not supplied');
      delete ctx.dumpUi;
      return ordinaryUi();
    }
    const xml = rpcSync(state.port, { op: 'main-ui', instance: state.instance }).xml;
    require(typeof xml === 'string' && xml.includes('<hierarchy') && xml.includes('</hierarchy>'), 'Shared UI broker returned no complete hierarchy');
    return xml;
  };
}
async function prepare(ready) {
  const deadline = Date.now() + 15000; let announced = false;
  for (;;) {
    try { return await ready(); }
    catch (error) {
      if (!/Another phone operation is running/.test(error.message) || Date.now() >= deadline) throw error;
      if (!announced) { log('Waiting for the short shared readiness gate; workspace execution remains independent.'); announced = true; }
      await sleep(100);
    }
  }
}
async function start(ctx) {
  // Cross-process startup lease; holds the old gate only during installation/connection.
  let state = reconcileWorkspaceState(ctx);
  if (state) {
    const ping = await rpc(state.port, { op: 'ping' });
    require(ping.instance === state.instance, 'Workspace broker identity changed; stop stale mapping explicitly');
    return { ...requireWorkspaceCapacity(ping), port: state.port, alreadyRunning: true };
  }
  const artifactDir = path.join(root, 'runtime/android/phone-workspaces');
  const jar = path.join(artifactDir, 'phone-workspaces.jar');
  const manifest = path.join(artifactDir, 'build.json');
  require(fs.existsSync(jar) && fs.existsSync(manifest), 'CI phone-workspaces artifact missing; no local build or unverified download fallback');
  const meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const bytes = fs.readFileSync(jar);
  require(/^[0-9a-f]{40}$/.test(meta.commit || '') && meta.sha256 === crypto.createHash('sha256').update(bytes).digest('hex') && meta.size === bytes.length, 'CI artifact identity/hash/size mismatch');
  const lock = path.join(ctx.dir, 'workspace-start.lock'); let fd;
  try { fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    require(pid > 0, 'Incomplete workspace startup lease; no automatic takeover');
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      log('Expired workspace startup lease; removing only its lock, not a running phone process.');
      fs.unlinkSync(lock); return start(ctx);
    }
    throw Error('Workspace startup already running; retry list after it finishes');
  }
  let port;
  try {
    state = readWorkspaceState(ctx);
    if (state) return requireWorkspaceCapacity(await rpc(state.port, { op: 'ping' }));
    ctx.adb(['push', jar, remoteJar]);
    const remoteHash = ctx.adb(['shell', 'sha256sum', remoteJar]).trim().split(/\s/)[0];
    require(remoteHash === meta.sha256, 'Phone server upload hash mismatch');
    port = Number(ctx.adb(['forward', 'tcp:0', 'localabstract:pi_phone_workspaces_v1']).trim());
    require(Number.isInteger(port) && port > 0, 'ADB did not allocate a workspace forward');
    let existing;
    try { existing = await rpc(port, { op: 'ping' }, { timeout: 700 }); }
    catch (e) { log(`No active broker on owned socket; starting verified CI server (${e.message}).`); }
    if (existing) {
      require(existing.version === meta.commit, 'Different server version still active; explicitly stop it, never kill or replace it');
    } else {
      // Rotate only this broker's previous diagnostic log; never clear global Android logs.
      ctx.adb(['shell', `if [ -f ${remoteLog} ]; then mv ${remoteLog} ${remoteLog}.previous; fi; CLASSPATH=${remoteJar} nohup app_process /system/bin com.lop.phone.WorkspaceServer ${meta.commit} >${remoteLog} 2>&1 </dev/null &`]);
    }
    let ping = existing, last;
    for (let i = 0; !ping && i < 20; i++) {
      await sleep(350);
      try { ping = await rpc(port, { op: 'ping' }, { timeout: 700 }); }
      catch (e) { last = e; }
    }
    if (!ping) {
      const diagnostic = ctx.adb(['shell', 'tail', '-35', remoteLog]);
      throw Error(`Workspace server did not become ready: ${last?.message}\n${diagnostic}`);
    }
    require(ping.version === meta.commit, 'Server/CI commit mismatch');
    requireWorkspaceCapacity(ping);
    state = { serial: ctx.device.serial, port, instance: ping.instance, version: ping.version };
    fs.writeFileSync(stateFile(ctx), JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
    return { ...ping, port };
  } catch (e) {
    if (port) { try { ctx.adb(['forward', '--remove', `tcp:${port}`]); } catch (cleanup) { log(`Forward cleanup failed: ${cleanup.message}`); } }
    throw e;
  } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
}
export async function workspaceCommand(ctx, args, ready) {
  const request = parseWorkspaceCommand(args);
  if (request.op === 'help') {
    console.log('phone workspace start | list | stop\nphone workspace open NAME PACKAGE | close NAME\nphone workspace observe NAME [NAME ... up to 10] | snapshot NAME | screenshot NAME NEW.png\nphone workspace click NAME REF SNAPSHOT\nphone workspace text NAME REF TEXT SNAPSHOT\nphone workspace tap NAME X Y SNAPSHOT\nphone workspace swipe NAME X Y END_X END_Y DURATION_MS SNAPSHOT\nphone workspace back NAME SNAPSHOT | enter NAME SNAPSHOT\nUp to 10 isolated app leases, created only by open and released by close/stop. Every action consumes a <=10s snapshot. No main-display, clipboard or keyboard fallback.');
    return;
  }
  if (request.op === 'start') { console.log(JSON.stringify(await prepare(() => ready(() => start(ctx))))); return; }
  let state;
  if (request.op === 'stop') state = reconcileWorkspaceState(ctx);
  else await prepare(() => ready(() => { state = reconcileWorkspaceState(ctx); }));
  if (!state && request.op === 'stop') { console.log(JSON.stringify({ stopped: true, alreadyStopped: true })); return; }
  require(state, 'Workspaces not started or expired; run phone workspace start. No workspace action was replayed on the main display.');
  // stop is cleanup-only: it cannot input, read content, unlock, or move tasks to main.
  const output = request.output; delete request.output;
  if (output) require(!fs.existsSync(path.resolve(output)), 'Screenshot output already exists; choose a new filename');
  const result = await workspaceLease(`${ctx.device.serial}:${request.workspace || request.op}`, () => rpc(state.port, { ...request, instance: state.instance }));
  if (request.op === 'stop') {
    ctx.adb(['forward', '--remove', `tcp:${state.port}`]); fs.unlinkSync(stateFile(ctx));
  }
  if (output) {
    const bytes = Buffer.from(result.png, 'base64');
    require(bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'Invalid workspace PNG');
    const dest = path.resolve(output); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes, { flag: 'wx' }); delete result.png; result.path = dest;
  }
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === self && process.argv[2] === '--internal-rpc') {
  try { console.log(JSON.stringify(await rpc(Number(process.argv[3]), JSON.parse(fs.readFileSync(0, 'utf8'))))); }
  catch (e) { log(e.message); process.exitCode = 1; }
}
