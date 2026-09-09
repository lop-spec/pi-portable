// USB Android entry point. Credentials stay in this Windows user's DPAPI store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { attachWorkspaceUi, workspaceCommand } from './phone-workspaces.mjs';

const tools = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(tools);
const stateRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'pi-phone');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = message => console.error(`[phone] ${message}`);
const ps = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

export function parseDevices(text) {
  return text.split(/\r?\n/).map(line => line.match(/^(\S+)\s+(device|unauthorized|offline)\b(.*)$/))
    .filter(Boolean).map(m => ({ serial: m[1], state: m[2], details: m[3].trim() }));
}
export function chooseDevice(devices, serial) {
  const candidates = serial ? devices.filter(d => d.serial === serial) : devices.filter(d => !d.serial.startsWith('emulator-') && !d.serial.includes(':'));
  if (candidates.length !== 1) throw Error(candidates.length ? 'Multiple USB phones; specify --serial. No device selected.' : 'No matching USB device in adb devices; check cable/driver/debugging authorization.');
  if (candidates[0].state !== 'device') throw Error(candidates[0].state === 'unauthorized' ? 'USB connected but debugging unauthorized; accept this computer on the phone.' : 'USB transport exists but is offline.');
  return candidates[0];
}
export function parsePolicy(text) {
  const delegate = text.match(/KeyguardServiceDelegate[\s\S]*?(?=\n\S|$)/)?.[0] || '';
  const showing = delegate.match(/\bshowing=(true|false)/) || text.match(/\b(?:mKeyguardShowing|mShowingLockscreen)=(true|false)/);
  const awake = text.match(/\bmAwake=(true|false)/);
  return { locked: showing ? showing[1] === 'true' : null, awake: awake ? awake[1] === 'true' : null };
}
export function credentialField(xml, kind) {
  const nodes = xml.match(/<node\b[^>]*>/g) || [];
  return nodes.map(node => {
    const attr = key => node.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] || '';
    const id = attr('resource-id'), pkg = attr('package');
    if (pkg !== 'com.android.systemui') return null;
    const suitable = kind === 'pin' ? /(?:pinEntry|pin_entry|pinentry|numeric_input)/i.test(id) : /(?:passwordEntry|password_entry|passwordentry)/i.test(id);
    if (!suitable || attr('enabled') === 'false') return null;
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    return b ? { x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) } : null;
  }).find(Boolean) || null;
}
export function dumpUi(adb) {
  // Android 16 can report a successful /dev/tty dump without returning XML.
  // Use our own unique shell-owned file, read it explicitly, then remove it.
  const remote = `/data/local/tmp/pi-phone-ui-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.xml`;
  try {
    adb(['shell', 'uiautomator', 'dump', remote], { timeout: 18000 });
    const xml = adb(['exec-out', 'cat', remote]);
    if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) throw Error('UI dump returned no complete hierarchy; no credential sent.');
    return xml;
  } finally {
    try { adb(['shell', 'rm', '-f', remote]); }
    catch { log('Could not remove this operation\'s UI temporary file: ' + remote); }
  }
}
export function secretCommand(secret) {
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{4,64}$/.test(secret) || secret.includes('%s')) throw Error('Unsupported credential format; no input sent.');
  return `input text '${secret.replaceAll("'", "'\\''")}'\n`;
}
function run(file, args, options = {}) {
  const r = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 12000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw Error(options.sensitive ? 'Credential input/DPAPI operation failed (details redacted).' : `Process failed: ${r.error?.code || r.status}: ${String(r.stderr || '').slice(0, 400)}`);
  return r.stdout;
}
function findAdb() {
  const choices = [process.env.PI_PHONE_ADB, path.join(root, 'runtime/android/platform-tools/adb.exe'), process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools/adb.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe')].filter(Boolean);
  for (const p of choices) if (fs.existsSync(p)) return p;
  const r = spawnSync('where.exe', ['adb.exe'], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
  if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0];
  throw Error('ADB missing. Install official Platform Tools in runtime/android, or set PI_PHONE_ADB.');
}
export function connect(serial) {
  const adbPath = findAdb();
  const device = chooseDevice(parseDevices(run(adbPath, ['devices', '-l'])), serial);
  const key = crypto.createHash('sha256').update(device.serial).digest('hex').slice(0, 24);
  const dir = path.join(stateRoot, key);
  fs.mkdirSync(dir, { recursive: true });
  const adb = (args, options) => run(adbPath, ['-s', device.serial, ...args], options);
  return { device, dir, adb, policy: () => parsePolicy(adb(['shell', 'dumpsys', 'window', 'policy'])) };
}
export function exclusive(ctx, work) {
  const lock = path.join(ctx.dir, 'operation.lock');
  let fd;
  for (let i = 0; i < 2; i++) {
    try { fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!pid) throw Error('Incomplete operation lock; do not retry credentials automatically.');
      try { process.kill(pid, 0); throw Error('Another phone operation is running; retry after it finishes.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      log('Removing stale operation lock from a terminated process; failed-attempt latch is retained.');
      fs.unlinkSync(lock);
    }
  }
  if (fd === undefined) throw Error('Cannot acquire phone operation lock.');
  const release = () => { fs.closeSync(fd); fs.unlinkSync(lock); };
  let result;
  try { result = work(); } catch (error) { release(); throw error; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
  release(); return result;
}
export function ensureReady(ctx) {
  const { adb, policy, dir, device } = ctx;
  const blocked = path.join(dir, 'unlock-blocked');
  const verified = () => {
    const state = policy();
    if (state.locked === null) throw Error('Unknown keyguard state; refusing credential input and phone operation.');
    if (!state.locked) {
      if (fs.existsSync(blocked)) { fs.unlinkSync(blocked); log('Observed unlocked phone; clearing failed-attempt latch.'); }
      return true;
    }
    return false;
  };
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  sleep(350);
  if (verified()) return { serial: device.serial, locked: false, ready: true };
  if (fs.existsSync(blocked)) throw Error('Previous unlock did not verify. Automatic input blocked; manually unlock or re-enroll the correct credential.');
  const credentialPath = path.join(dir, 'credential.json');
  if (!fs.existsSync(credentialPath)) throw Error('Phone connected but locked; credential not enrolled. Use phone enroll pin (or password) in your own terminal.');
  const dismiss = adb(['shell', 'wm', 'dismiss-keyguard']);
  if (/error|exception/i.test(dismiss)) log('Keyguard dismissal was declined; checking the credential screen instead.');
  const size = adb(['shell', 'wm', 'size']).match(/(?:Override|Physical) size: (\d+)x(\d+)/g)?.at(-1)?.match(/(\d+)x(\d+)/);
  if (!size) throw Error('Cannot determine screen dimensions; no credential sent.');
  const [, w, h] = size.map(Number);
  adb(['shell', 'input', 'swipe', String(Math.round(w / 2)), String(Math.round(h * .8)), String(Math.round(w / 2)), String(Math.round(h * .25)), '300']);
  sleep(500);
  if (verified()) return { serial: device.serial, locked: false, ready: true };
  // Only metadata is read here. Decrypt only after confirming a known SystemUI entry field.
  const meta = JSON.parse(fs.readFileSync(credentialPath, 'utf8').replace(/^\uFEFF/, ''));
  const xml = ctx.dumpUi ? ctx.dumpUi() : dumpUi(adb);
  const field = credentialField(xml, meta.kind);
  if (!field || /(?:try again in|too many attempts|重试|秒后|分钟后)/i.test(xml)) throw Error('No supported SystemUI credential field, or lockout shown; no credential sent.');
  if (verified()) return { serial: device.serial, locked: false, ready: true };
  adb(['shell', 'input', 'tap', String(field.x), String(field.y)]);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'phone-credential.ps1'), '-Action', 'read', '-Path', credentialPath, '-Serial', device.serial];
  let credential;
  try { credential = JSON.parse(run(ps, args, { sensitive: true }).replace(/^\uFEFF/, '')); }
  catch { throw Error('Cannot decrypt/parse local credential (details redacted); no credential sent.'); }
  if (credential.kind === 'pin' && !/^\d{4,16}$/.test(credential.secret)) throw Error('Invalid stored PIN; no credential sent.');
  const input = secretCommand(credential.secret);
  // Persist BEFORE sending; a crash or subsequent invocation must not repeat a failed PIN.
  fs.writeFileSync(blocked, `Attempt started ${new Date().toISOString()}\n`, { flag: 'wx' });
  if (policy().locked !== true) throw Error('Keyguard changed before clearing entry; no credential sent.');
  adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(64).fill('KEYCODE_DEL')]);
  if (policy().locked !== true) throw Error('Keyguard changed before input; no credential sent.');
  adb(['shell'], { input, sensitive: true });
  credential.secret = '';
  sleep(700);
  if (!verified()) adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
  for (let i = 0; i < 6; i++) {
    if (verified()) { log('Credential unlock verified.'); return { serial: device.serial, locked: false, ready: true }; }
    sleep(400);
  }
  throw Error('Unlock failed verification. No retry; manually unlock and check the saved credential.');
}
function enroll(ctx, kind, stdin) {
  if (!['pin', 'password'].includes(kind)) throw Error('Supported lock types: pin, password. Pattern not supported.');
  const target = path.join(ctx.dir, 'credential.json');
  if (fs.existsSync(target)) log(run(process.execPath, [path.join(tools, 'backup.mjs'), target]).trim());
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'phone-credential.ps1'), '-Action', 'save', '-Path', target, '-Serial', ctx.device.serial, '-Kind', kind];
  if (stdin) {
    run(ps, ['-NonInteractive', ...args], { input: fs.readFileSync(0, 'utf8'), sensitive: true });
    console.log('Credential encrypted, readback and ACL verified.');
  } else {
    if (!process.stdin.isTTY) throw Error('Enrollment requires your own interactive terminal; do not put the password in command arguments.');
    const r = spawnSync(ps, [...args, '-Interactive'], { windowsHide: true, stdio: 'inherit' });
    if (r.status !== 0) throw Error('Credential enrollment failed.');
  }
  const blocked = path.join(ctx.dir, 'unlock-blocked');
  if (fs.existsSync(blocked)) { fs.unlinkSync(blocked); log('Credential explicitly re-enrolled; failed-attempt latch cleared.'); }
}
export async function main(args = process.argv.slice(2)) {
  let serial;
  if (args[0] === '--serial') { [, serial] = args; args = args.slice(2); }
  const [command = 'help', ...rest] = args;
  if (command === 'help') {
    console.log('phone [--serial SERIAL] status | ready | ui | screenshot FILE | shell ... | exec-out ... | pull ... | push ... | workspace help | enroll pin|password\nEvery phone content/action command first wakes and verifies unlock. status never enters credentials. Enrollment is local DPAPI, never synced.');
    return;
  }
  if (!['status', 'ready', 'ui', 'screenshot', 'shell', 'exec-out', 'pull', 'push', 'workspace', 'enroll'].includes(command)) throw Error('Unknown command; use phone help.');
  const ctx = connect(serial);
  if (command === 'status') {
    console.log(JSON.stringify({ ...ctx.device, ...ctx.policy(), credentialEnrolled: fs.existsSync(path.join(ctx.dir, 'credential.json')), automaticInputBlocked: fs.existsSync(path.join(ctx.dir, 'unlock-blocked')) }));
    return;
  }
  if (command !== 'enroll') attachWorkspaceUi(ctx);
  if (command === 'workspace') return workspaceCommand(ctx, rest, work => exclusive(ctx, () => { ensureReady(ctx); return work ? work() : undefined; }));
  return exclusive(ctx, () => {
    if (command === 'enroll') return enroll(ctx, rest[0] || 'pin', rest.includes('--stdin'));
    const ready = ensureReady(ctx);
    if (command === 'ready') return console.log(JSON.stringify(ready));
    if (command === 'screenshot') {
      if (!rest[0]) throw Error('screenshot requires an output filename.');
      const bytes = ctx.adb(['exec-out', 'screencap', '-p'], { encoding: null });
      if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Invalid PNG returned.');
      const dest = path.resolve(rest[0]); fs.writeFileSync(dest, bytes); console.log(dest); return;
    }
    const out = command === 'ui' ? (ctx.dumpUi ? ctx.dumpUi() : dumpUi(ctx.adb)) : ctx.adb([command, ...rest], { timeout: 20000 });
    process.stdout.write(out);
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { log(error.message); process.exitCode = 1; });
}
