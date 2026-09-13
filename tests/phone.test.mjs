import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDevices, chooseDevice, parsePolicy, credentialField, dumpUi, secretCommand, ensureReady } from '../tools/phone.mjs';

test('device states and selection never treat unauthorized/offline as usable', () => {
  const devices = parseDevices('List of devices attached\nusb1 unauthorized\nusb2 offline\nemulator-5554 device product:x\n');
  assert.equal(devices.length, 3);
  assert.throws(() => chooseDevice(devices), /Multiple/);
  assert.throws(() => chooseDevice(devices, 'usb1'), /unauthorized/);
  assert.throws(() => chooseDevice(devices, 'usb2'), /offline/);
  assert.throws(() => chooseDevice([]), /No matching/);
  assert.equal(chooseDevice(parseDevices('usb device model:phone')).serial, 'usb');
});
test('policy is tri-state and scoped to KeyguardServiceDelegate', () => {
  assert.equal(parsePolicy('showing=false').locked, null);
  assert.equal(parsePolicy(' KeyguardServiceDelegate\n   showing=true\n   secure=true').locked, true);
  assert.equal(parsePolicy(' mAwake=true\n KeyguardServiceDelegate\n   showing=false\n').locked, false);
  assert.equal(parsePolicy('mShowingLockscreen=true').locked, true);
  const android16 = ' KeyguardServiceDelegate\n  showing=true\n  screenState=SCREEN_STATE_ON\n  interactiveState=INTERACTIVE_STATE_AWAKE';
  assert.deepEqual(parsePolicy(android16), { locked: true, awake: true });
  assert.equal(parsePolicy(android16.replace('SCREEN_STATE_ON', 'SCREEN_STATE_OFF')).awake, false);
  assert.equal(parsePolicy(android16.replace('INTERACTIVE_STATE_AWAKE', 'INTERACTIVE_STATE_SLEEP')).awake, false);
  assert.equal(parsePolicy('KeyguardServiceDelegate\n showing=true').awake, null);
});
test('credential input requires supported SystemUI field, never an app lookalike', () => {
  const node = '<node package="com.android.systemui" resource-id="com.android.systemui:id/pinEntry" enabled="true" bounds="[100,200][300,400]" />';
  assert.deepEqual(credentialField(node, 'pin'), { x: 200, y: 300 });
  assert.equal(credentialField(node, 'password'), null);
  assert.equal(credentialField(node.replace('package="com.android.systemui"', 'package="com.example.app"'), 'pin'), null);
  assert.equal(credentialField(node.replace('enabled="true"', 'enabled="false"'), 'pin'), null);
});
test('Android 16 UI dump reads explicit file and always cleans its own file', () => {
  const calls = [];
  const xml = '<hierarchy><node /></hierarchy>';
  assert.equal(dumpUi(args => { calls.push(args); return args[0] === 'exec-out' ? xml : ''; }), xml);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][3], calls[1][2]);
  assert.equal(calls[0][3], calls[2][3]);
  assert.match(calls[0][3], /^\/data\/local\/tmp\/pi-phone-ui-/);
  const failed = [];
  assert.throws(() => dumpUi(args => { failed.push(args); return 'UI hierchary dumped to: /dev/tty'; }), /no complete hierarchy/);
  assert.equal(failed.at(-1)[1], 'rm');
});
test('secret command quotes shell metacharacters and rejects unsupported input', () => {
  assert.equal(secretCommand("a'b$;"), "input -d 0 text 'a'\\''b$;'\n");
  for (const text of ['12', '123\n45', 'a bcd', 'abc%s', '密码1234']) assert.throws(() => secretCommand(text));
});
function context(locked) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-unit-'));
  const calls = [];
  return { dir, device: { serial: 'test' }, calls, adb: args => { calls.push(args); return ''; }, policy: () => ({ locked, awake: true }), sleep: () => {} };
}
test('already unlocked is idempotent; never reads credentials or enters text', () => {
  const ctx = context(false);
  assert.equal(ensureReady(ctx).ready, true);
  assert.deepEqual(ctx.calls, [['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']]);
});
test('unknown state fails closed before any credential or action', () => {
  const ctx = context(null);
  assert.throws(() => ensureReady(ctx), /Unknown keyguard/);
  assert.equal(ctx.calls.length, 1);
});
test('missing credential is an explicit block, not a successful unlock', () => {
  const ctx = context(true);
  assert.throws(() => ensureReady(ctx), /credential not enrolled/);
  assert.equal(ctx.calls.length, 1);
});
test('failure latch prevents input across repeated invocations', () => {
  const ctx = context(true);
  fs.writeFileSync(path.join(ctx.dir, 'unlock-blocked'), 'previous attempt');
  assert.throws(() => ensureReady(ctx), /Automatic input blocked/);
  assert.throws(() => ensureReady(ctx), /Automatic input blocked/);
  assert.ok(ctx.calls.every(a => a.join(' ') === 'shell input keyevent KEYCODE_WAKEUP'));
});
test('manual unlock clears failure latch only after observing unlocked state', () => {
  const ctx = context(false);
  const latch = path.join(ctx.dir, 'unlock-blocked'); fs.writeFileSync(latch, 'previous attempt');
  assert.equal(ensureReady(ctx).ready, true);
  assert.equal(fs.existsSync(latch), false);
});
function unlockContext(expireAt, { rejected = false, transportError = false, unknownDispatch = false, delayed = false, alwaysSleep = false } = {}) {
  const ctx = context(true);
  fs.writeFileSync(path.join(ctx.dir, 'credential.json'), JSON.stringify({ kind: 'pin' }));
  let awake = false, locked = true, expired = false, polls = 0;
  ctx.submissions = 0; ctx.snapshots = 0;
  const expire = stage => { if (expireAt === stage && (!expired || alwaysSleep)) { awake = false; expired = true; } };
  ctx.policy = () => {
    if (delayed && ctx.submissions && ++polls > 15) locked = false;
    return { locked, awake };
  };
  ctx.dumpUi = () => {
    ctx.snapshots++; expire('snapshot');
    return '<hierarchy><node package="com.android.systemui" resource-id="com.android.systemui:id/pinEntry" enabled="true" bounds="[100,200][300,400]" /></hierarchy>';
  };
  ctx.loadCredential = () => { expire('decrypt'); return { kind: 'pin', secret: '1357' }; };
  ctx.adb = (args, options) => {
    ctx.calls.push(args);
    if (args.includes('KEYCODE_WAKEUP')) awake = true;
    if (args.includes('KEYCODE_DEL')) expire('clear');
    if (args.length === 1 && args[0] === 'shell') {
      assert.equal(awake, true, 'host must not dispatch while asleep');
      assert.match(options.input, /mWakefulness=Awake/);
      assert.equal(ctx.submissions, 0, 'never submit a credential twice');
      if (expireAt === 'dispatch' && !expired) { expired = true; awake = false; return 'phone-dispatch:skipped'; }
      ctx.submissions++;
      if (transportError) throw Error('simulated transport failure');
      if (unknownDispatch) return 'missing acknowledgement';
      if (!rejected && !delayed) locked = false;
      return 'phone-dispatch:sent';
    }
    return '';
  };
  return ctx;
}
for (const phase of ['snapshot', 'decrypt', 'clear', 'dispatch']) {
  test(`screen timeout during ${phase} recovers BEFORE submission, never blocks or retries PIN`, () => {
    const ctx = unlockContext(phase);
    assert.equal(ensureReady(ctx).ready, true);
    assert.equal(ctx.submissions, 1);
    assert.equal(ctx.snapshots, 2);
    assert.equal(fs.existsSync(path.join(ctx.dir, 'unlock-blocked')), false);
  });
}
test('persistent preparation timeout is bounded and leaves no poison latch', () => {
  const ctx = unlockContext('snapshot', { alwaysSleep: true });
  assert.throws(() => ensureReady(ctx), /Preparation repeatedly/);
  assert.equal(ctx.snapshots, 3);
  assert.equal(ctx.submissions, 0);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'unlock-blocked')), false);
});
test('actual credential rejection stays blocked across subsequent calls', () => {
  const ctx = unlockContext(null, { rejected: true });
  assert.throws(() => ensureReady(ctx), /Unlock failed verification/);
  assert.throws(() => ensureReady(ctx), /Automatic input blocked/);
  assert.equal(ctx.submissions, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'unlock-blocked'))).stage, 'submitted');
});
for (const fault of ['transportError', 'unknownDispatch']) {
  test(`${fault} retains guard because submission cannot be ruled out`, () => {
    const ctx = unlockContext(null, { [fault]: true });
    assert.throws(() => ensureReady(ctx));
    assert.throws(() => ensureReady(ctx), /Automatic input blocked/);
    assert.equal(ctx.submissions, 1);
    assert.equal(fs.existsSync(path.join(ctx.dir, 'unlock-blocked')), true);
  });
}
test('slow authentication completion waits without resubmitting credentials', () => {
  const ctx = unlockContext(null, { delayed: true });
  assert.equal(ensureReady(ctx).ready, true);
  assert.equal(ctx.submissions, 1);
});
test('unknown interactive state fails closed, even if keyguard status is known', () => {
  const ctx = context(true); ctx.policy = () => ({ locked: true, awake: null });
  assert.throws(() => ensureReady(ctx), /Unknown screen\/interactive/);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'unlock-blocked')), false);
});
