import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/browser-agent/runtime.mjs';

// No real browser is launched or connected by these tests.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-daily-attach-test-'));
const profileDir = path.join(root, 'profile');
const logFile = path.join(root, 'events.jsonl');
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => { throw new Error('fixture: no endpoint'); };
  const unavailable = new BrowserRuntime({ dataRoot: root, profileDir, logFile });
  await assert.rejects(unavailable.start(), /No isolated browser was started/);
  assert.equal(unavailable.child, null);
  await assert.rejects(fs.stat(profileDir), { code: 'ENOENT' });
  assert.match(await fs.readFile(logFile, 'utf8'), /daily-attach-unavailable/);

  await fs.mkdir(profileDir);
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  await fs.writeFile(portFile, '54321\n/devtools/browser/approval-test\n');
  const modulePath = path.join(root, 'mock-playwright.mjs');
  await fs.writeFile(modulePath, `
    import assert from 'node:assert/strict';
    export const calls = [];
    const original = { isClosed: () => false, id: 'user-page' };
    const background = { isClosed: () => false, id: 'background-page', close: async () => {} };
    let created = false;
    const context = {
      setDefaultTimeout() {},
      pages: () => created ? [original, background] : [original],
      newPage: () => { throw new Error('Foreground page creation forbidden'); },
      newCDPSession: async page => ({send: async () => ({targetInfo: {targetId: page.id}}), detach: async () => {}}),
    };
    const browser = {
      contexts: () => [context], version: () => 'Thorium fixture', on() {}, isConnected: () => true,
      close: async () => calls.push('disconnect'),
      newBrowserCDPSession: async () => ({
        send: async (method, args) => {
          assert.equal(method, 'Target.createTarget');
          assert.equal(args.background, true);
          calls.push('background-tab'); created = true;
          return {targetId: background.id};
        }, detach: async () => {},
      }),
    };
    export const chromium = { connectOverCDP: async url => {
      assert.equal(url, 'ws://127.0.0.1:54321/devtools/browser/approval-test');
      calls.push('connect-ws'); return browser;
    }};
  `);
  globalThis.fetch = async () => { throw new Error('Approval mode must not require HTTP discovery'); };
  const runtime = new BrowserRuntime({ dataRoot: root, profileDir, logFile, playwrightPath: modulePath });
  await runtime.start();
  assert.equal(runtime.status().mode, 'daily-attach');
  assert.equal(runtime.child, null);
  assert.equal(runtime.page.id, 'background-page');
  runtime.snapshot = async () => ({});
  await runtime.selectTab(0);
  assert.equal(runtime.page.id, 'user-page'); // No bringToFront or viewport mutations.
  await runtime.detach();
  assert.equal(await fs.readFile(portFile, 'utf8'), '54321\n/devtools/browser/approval-test\n');
  console.log('PASS: attach-only failure/log, no profile creation, approval-mode WS, background tab, no activation, detach, no profile mutation');
} finally {
  globalThis.fetch = originalFetch;
  // Only the exact temporary fixture created above is removed.
  await fs.rm(root, { recursive: true, force: true });
}
