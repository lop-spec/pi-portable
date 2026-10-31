// Isolated acceptance for the SDK and extension that will actually ship.
// The caller must patch a disposable SDK first; this runner never patches a runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchInstalledSingleWatermark } from '../tools/patch-pi-single-watermark.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkArg = process.argv[2] || process.env.PI_TEST_HOST;
const sourceArg = process.argv[3] || process.env.PIWEB_TEST_SOURCE || path.join(repo, 'upstream');
const extensionArg = process.argv[4] || process.env.PI_ASYNC_TEST_DIR || path.join(repo, 'assets/pi-async-compaction');
assert.ok(sdkArg, 'Pass the disposable patched SDK directory');
const sdk = fs.realpathSync(sdkArg);
const source = fs.realpathSync(sourceArg);
const extension = fs.realpathSync(extensionArg);
assert.ok(fs.existsSync(path.join(sdk, 'package.json')), 'SDK package missing');
assert.ok(fs.existsSync(path.join(source, 'package.json')), 'upstream source missing');
assert.ok(fs.existsSync(path.join(extension, 'index.ts')), 'extension missing');
const patch = patchInstalledSingleWatermark(sdk, { check: true });
assert.equal(patch.status, 'already-patched', 'Test the patched SDK, not an unmodified dependency');

const tests = [
  'async-compaction-contract.mjs', 'async-compaction-sdk.mjs', 'async-compaction-cached.mjs',
  'async-compaction-reload.mjs', 'async-compaction-request-policy.mjs', 'single-watermark-contract.mjs',
  'single-watermark-chat-sdk.mjs', 'single-watermark-http-provider.mjs',
  'single-watermark-overflow-sdk.mjs', 'piweb-single-watermark-contract.mjs',
];
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-watermark-ci-'));
try {
  const home = path.join(sandbox, 'home'), tmp = path.join(sandbox, 'tmp');
  const roaming = path.join(home, 'AppData/Roaming'), local = path.join(home, 'AppData/Local');
  for (const dir of [home, tmp, roaming, local, path.join(home, '.pi/agent')]) fs.mkdirSync(dir, { recursive: true });
  // Do not inherit user API keys, credentials, agent paths, proxy settings or sessions.
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'ComSpec', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    PI_TEST_HOST: sdk, PI_ASYNC_TEST_DIR: extension, PIWEB_TEST_SOURCE: source,
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: '0', CODEX_FOLLOW_SYSTEM_PROXY: '0',
  });
  console.log(JSON.stringify({ phase: 'single-watermark', sdk, source, extension, patch: patch.status, tests: tests.length }));
  for (const test of tests) {
    console.log(`\n### ${test}`);
    const result = spawnSync(process.execPath, [path.join(repo, 'tests', test)], {
      cwd: repo, env, stdio: 'inherit', windowsHide: true, timeout: 120000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`${test} failed (status=${result.status}, signal=${result.signal})`);
  }
  console.log(`PASS isolated single-watermark suite: ${tests.length}/${tests.length}`);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
