#!/usr/bin/env node
// Install the pinned Cline CLI binary where pi-web's Cline agent looks for it:
//   <agentDir>/cline-agent/cli/node_modules/@cline/cli-<platform>-<arch>/bin/cline(.exe)
// Only the platform package is installed; it is a self-contained executable.
// usage: node tools/install-cline-agent.mjs [--agent-dir <dir>]   (default: PI_CODING_AGENT_DIR, else ~/.pi/agent)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const pinned = JSON.parse(fs.readFileSync(path.join(repo, 'assets/cline-agent.json'), 'utf8'));
const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
if (!platform) throw new Error(`Cline publishes no binary for ${process.platform}`);

const at = process.argv.indexOf('--agent-dir');
const agentDir = path.resolve(at >= 0 ? process.argv[at + 1] : process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
if (!fs.existsSync(agentDir)) throw new Error(`Pi agent dir not found: ${agentDir}`);
const cliDir = path.join(agentDir, 'cline-agent', 'cli');
const name = `${pinned.package}-${platform}-${process.arch}`;
const bin = path.join(cliDir, 'node_modules', ...name.split('/'), 'bin', process.platform === 'win32' ? 'cline.exe' : 'cline');
const run = (file, args) => spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 600_000 });
const installedVersion = () => (fs.existsSync(bin) ? run(bin, ['--version']).stdout.trim() : '');

if (installedVersion() !== pinned.version) {
  fs.mkdirSync(cliDir, { recursive: true });
  // npm ships beside node on every machine this runs on, PATH or not.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['install', `${name}@${pinned.version}`, '--prefix', cliDir, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save'];
  const result = fs.existsSync(npmCli) ? run(process.execPath, [npmCli, ...args]) : spawnSync('npm', args, { encoding: 'utf8', windowsHide: true, timeout: 600_000, shell: true });
  if (result.status !== 0) throw new Error(`npm install ${name}@${pinned.version} failed:\n${result.stderr || result.stdout || result.error}`);
}
const version = installedVersion();
if (version !== pinned.version) throw new Error(`expected Cline ${pinned.version} at ${bin}, got "${version}"`);
console.log(JSON.stringify({ bin, version, bytes: fs.statSync(bin).size }));
