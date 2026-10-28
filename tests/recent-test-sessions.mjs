import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/recent-test-sessions.mjs', import.meta.url));
test('explicitly add/remove IDs, retain others, back up the existing registry and reject invalid input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recent-tests-'));
  fs.mkdirSync(path.join(dir, '_历史版本'));
  const run = (...args) => spawnSync(process.execPath, [script, ...args, '--agent-dir', dir], { encoding: 'utf8', windowsHide: true });
  const registry = () => JSON.parse(fs.readFileSync(path.join(dir, 'recent-test-sessions.json'), 'utf8'));
  try {
    assert.equal(run('add', 'test-b', 'test-a').status, 0);
    assert.deepEqual(registry().ids, ['test-a', 'test-b']);
    assert.equal(run('add', 'test-b', 'test-c').status, 0);
    assert.deepEqual(registry().ids, ['test-a', 'test-b', 'test-c']);
    assert.equal(run('remove', 'test-b').status, 0);
    assert.deepEqual(registry().ids, ['test-a', 'test-c']);
    assert.ok(fs.readdirSync(path.join(dir, '_历史版本')).length >= 2);
    assert.equal(run('add', '../invalid').status, 2);
    assert.deepEqual(registry().ids, ['test-a', 'test-c']);
    fs.writeFileSync(path.join(dir, 'recent-test-sessions.json.lock'), 'held');
    assert.equal(run('add', 'test-d').status, 1);
    assert.deepEqual(registry().ids, ['test-a', 'test-c']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
