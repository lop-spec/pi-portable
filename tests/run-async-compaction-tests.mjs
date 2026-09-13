import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const agent = process.argv[2] || process.env.PI_CODING_AGENT_DIR;
if (!agent) throw Error('Pass the managed agent directory');
const candidate = process.argv[3] || path.join(agent, 'extensions/lop-async-compaction');
const webCandidates = [
  process.env.PI_WEB_PKG,
  path.join(repo, 'app/node_modules/@agegr/pi-web/package.json'),
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'pi-web/portable/app/node_modules/@agegr/pi-web/package.json'),
].filter(Boolean);
const web = webCandidates.find(p => fs.existsSync(p));
if (!web) throw Error('Active managed pi-web package not found');
const require = createRequire(fs.realpathSync(web));
const name = '@earendil-works/pi-coding-agent';
const host = require.resolve.paths(name).map(p => path.join(p, name)).find(p => fs.existsSync(path.join(p, 'package.json')));
if (!host) throw Error('Actual pi-web SDK not found');
const settingsPath = path.join(agent, 'settings.json');
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(settingsPath)).digest('hex');
const before = hash();
console.log(JSON.stringify({ host: fs.realpathSync(host), sdkVersion: JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version, candidate, nativeSettingsSha256: before }));
for (const test of ['async-compaction-contract.mjs', 'async-compaction-sdk.mjs']) {
  const output = execFileSync(process.execPath, [path.join(repo, 'tests', test)], {
    env: { ...process.env, PI_TEST_HOST: fs.realpathSync(host), PI_ASYNC_TEST_DIR: candidate },
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  process.stdout.write(output);
}
if (before !== hash()) throw Error('Native settings changed during extension tests');
console.log('PASS managed-runtime acceptance; native settings byte-for-byte unchanged');
