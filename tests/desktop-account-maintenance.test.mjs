import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fakeJwt = () => `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"exp":1}').toString('base64url')}.fixture`;

test('portless desktop starts account keep-fresh without a request or TCP listener', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-account-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homes = path.join(root, 'homes');
  const slot = path.join(homes, 'acboter');
  const source = path.join(root, 'account.json');
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, '.pi-external-codex.json'), JSON.stringify({ version: 1, sourcePath: source, refresh: 'writeback' }));
  fs.writeFileSync(source, JSON.stringify({ tokens: { access_token: fakeJwt() } }));
  Object.assign(process.env, {
    PI_PORTABLE_DATA: root, PI_DESKTOP_INTERNAL_BRIDGE: '1', CODEX_ACCOUNT_HOMES: homes,
    CODEX_FOLLOW_SYSTEM_PROXY: '0', CODEX_UPSTREAM_PROXY_HOST: '127.0.0.1', CODEX_UPSTREAM_PROXY_PORT: '1',
    CODEX_EGRESS_FALLBACK_PORTS: '',
  });

  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  let bootJob, recurringJob;
  const dummyTimer = { unref() { return this; } };
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 30_000 && !bootJob) { bootJob = fn; return dummyTimer; }
    return realTimeout(fn, ms, ...args);
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    if (ms === 4 * 60 * 60_000) { recurringJob = fn; return dummyTimer; }
    return realInterval(fn, ms, ...args);
  };
  let bridge;
  try { ({ codexHttpServer: bridge } = await import('../src/bridge/codex-responses-proxy.mjs')); }
  finally { globalThis.setTimeout = realTimeout; globalThis.setInterval = realInterval; }
  t.after(() => bridge?.emit('close'));
  assert.equal(bridge.listening, false);
  assert.equal(typeof recurringJob, 'function');
  assert.equal(bootJob, recurringJob);
  await bootJob();
  assert.match(fs.readFileSync(path.join(root, 'codex-responses-proxy.log'), 'utf8'), /acboter[^\n]*missing-refresh-token/u);
});