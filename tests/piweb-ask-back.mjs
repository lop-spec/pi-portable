import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { integrateAskBack } from '../tools/patch-piweb-ask-back.mjs';
const root = process.env.PIWEB_SOURCE || path.resolve('upstream');
let source = fs.readFileSync(path.join(root, 'components/ChatWindow.tsx'), 'utf8').replaceAll('\r\n', '\n');
integrateAskBack({ change(name, old, next) {
  assert.equal(name, 'components/ChatWindow.tsx');
  assert.equal(source.split(old).length - 1, 1, 'unique anchor: ' + old.slice(0, 70));
  source = source.replace(old, next);
} });
const dialog = source.slice(source.indexOf('function ExtensionDialog('), source.indexOf('type ExtensionCustomRequest'));
test('Other and Back change local view, never completing the pending select', () => {
  assert.match(dialog, /option === "其他（自己输入）"\) setCustomInput\(true\)/);
  assert.match(dialog, /data-extension-back[\s\S]*?onClick=\{\(\) => setCustomInput\(false\)\}/);
  assert.match(dialog, /marginRight: "auto"/);
  assert.match(dialog, /request.method === "select" && !customInput/);
  assert.match(dialog, /request.method === "input" \|\| customInput/);
  assert.match(dialog, /placeholder=\{request.method === "input" \? request.placeholder : "输入你的答案"\}/);
});
test('Back retains the draft; final custom submit trims, ignores empty and preserves cancellation', () => {
  assert.doesNotMatch(dialog, /setValue\(""\)/);
  assert.match(dialog, /if \(value.trim\(\)\) onRespond\(request, \{ value: value.trim\(\) \}\)/);
  assert.match(dialog, /onClick=\{\(\) => onRespond\(request, \{ cancelled: true \}\)\}/);
  assert.match(dialog, /event.nativeEvent.isComposing/);
  assert.match(dialog, /chooseOption\(option\)/);
});
