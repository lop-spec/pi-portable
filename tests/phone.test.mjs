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
  assert.equal(secretCommand("a'b$;"), "input text 'a'\\''b$;'\n");
  for (const text of ['12', '123\n45', 'a bcd', 'abc%s', '密码1234']) assert.throws(() => secretCommand(text));
});
function context(locked) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-unit-'));
  const calls = [];
  return { dir, device: { serial: 'test' }, calls, adb: args => { calls.push(args); return ''; }, policy: () => ({ locked }) };
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
