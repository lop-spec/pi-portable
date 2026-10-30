import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStopOnGlobalEscape, createStopGate } from '../assets/piweb-overlay/immediate-stop/stop-guard.ts';

const event = (extra = {}) => ({ key: 'Escape', defaultPrevented: false, isComposing: false, repeat: false, target: { tagName: 'DIV', closest: () => null }, ...extra });
test('Esc handled by a menu, IME, repeated key or editable controls cannot stop the agent', () => {
  assert.equal(shouldStopOnGlobalEscape(event()), true);
  for (const extra of [
    { defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true },
    { target: { tagName: 'INPUT' } }, { target: { tagName: 'TEXTAREA' } },
    { target: { tagName: 'SELECT' } }, { target: { tagName: 'DIV', isContentEditable: true } },
    { target: { tagName: 'BUTTON', closest: () => ({}) } },
  ]) assert.equal(shouldStopOnGlobalEscape(event(extra)), false, JSON.stringify(extra));
});

test('stop arriving first and the next prompt share the pending abort exactly once', async () => {
  const gate = createStopGate(); let calls = 0, release;
  const slow = () => { calls++; return new Promise(r => { release = r; }); };
  const first = gate.run('old-stop', slow);
  await Promise.resolve();
  let promptReady = false;
  const prompt = gate.run('old-stop', async () => { calls++; }).then(() => { promptReady = true; });
  await Promise.resolve(); assert.equal(promptReady, false); assert.equal(calls, 1);
  release(); await Promise.all([first, prompt]); assert.equal(promptReady, true);
  await gate.run('old-stop', async () => { throw new Error('late duplicate must not stop newer run'); });
  assert.equal(calls, 1);
});

test('prompt arriving first suppresses a late stop; independent stops remain effective', async () => {
  const gate = createStopGate(); let calls = 0;
  await gate.run('ticket-a', async () => { calls++; });
  await gate.run('ticket-a', async () => { calls++; });
  await gate.run('ticket-b', async () => { calls++; });
  await gate.run(undefined, async () => { calls++; });
  assert.equal(calls, 3);
});

test('pending stops are not evicted and failures fail closed', async () => {
  const gate = createStopGate(1); let release, calls = 0;
  const pending = gate.run('pending', () => new Promise(r => { calls++; release = r; }));
  await Promise.resolve();
  await gate.run('second', async () => { calls++; });
  const duplicate = gate.run('pending', async () => { calls++; });
  await Promise.resolve(); assert.equal(calls, 2);
  release(); await Promise.all([pending, duplicate]);
  const failure = createStopGate();
  await assert.rejects(failure.run('failure', async () => { throw Error('stop failed'); }), /stop failed/);
  await assert.rejects(failure.run('failure', async () => { throw Error('unexpected repeat'); }), /stop failed/);
});
