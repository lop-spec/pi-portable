import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClineTurn } from '../assets/piweb-overlay/cline-agent/cline-bridge.ts';
import { launchOpenCode, openCodeTools, OPENCODE_PREAMBLE, OPENCODE_TOOLS, OPENCODE_VERSION } from '../assets/piweb-overlay/cline-agent/opencode-launch.ts';

const bin = process.env.PI_WEB_OPENCODE_BIN;

test('lean tool specs preserve validation and parameter names', () => {
  const specs = openCodeTools([
    { name: 'shell', description: 'BUILTIN', parameters: { type: 'object', properties: { description: { type: 'string', description: 'BUILTIN' } }, required: ['description'] } },
    { name: 'task', description: 'BUILTIN', parameters: {} },
  ]);
  assert.deepEqual(specs, [{ name: 'shell', description: 'Run a shell command.', parameters: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] } }]);
});

test('relay drops native prompt context and runs a pinned OpenCode tool', { skip: !bin, timeout: 60_000 }, async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-oc-'));
  const cwd = path.join(homeDir, 'workspace');
  fs.mkdirSync(cwd);
  const filePath = path.join(cwd, 'fixture.txt');
  fs.writeFileSync(filePath, 'OPEN_CODE_NATIVE_READ');
  // This local path is never evaluated by the real OpenCode worker.
  fs.writeFileSync(path.join(cwd, 'opencode.json'), JSON.stringify({ enabled_providers: ['should-not-load'], agent: { 'pi-web': { prompt: 'SHOULD_NOT_LOAD' } } }));
  const turn = ClineTurn.create({ bin, cwd, homeDir, label: 'OpenCode', systemMarker: OPENCODE_PREAMBLE,
    worker: (port, token) => launchOpenCode(homeDir, port, token), startTimeoutMs: 30_000 });
  t.after(async () => { turn.dispose(); await fs.promises.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  assert.equal(execFileSync(bin, ['--version'], {encoding:'utf8', windowsHide:true}).trim(), `opencode v${OPENCODE_VERSION}`);
  await turn.whenOpen(30_000);
  assert.equal(turn.system, OPENCODE_PREAMBLE);
  const specs = openCodeTools(turn.tools).sort((a, b) => a.name.localeCompare(b.name));
  const shellArgs = specs.find((tool) => tool.name === 'shell')?.parameters.properties;
  assert.ok(shellArgs?.background, 'native OpenCode still supports background jobs, which need its own session');
  delete shellArgs.background;
  assert.deepEqual(specs, OPENCODE_TOOLS);
  const result = await turn.callTool('call_read', 'read', { path: filePath });
  assert.match(result, /OPEN_CODE_NATIVE_READ/);
  const shell = await turn.callTool('call_shell', 'shell', { command: 'echo OPEN_CODE_NATIVE_SHELL' });
  assert.match(shell, /OPEN_CODE_NATIVE_SHELL/);
  const written = path.join(cwd, 'written.txt');
  await turn.callTool('call_write', 'write', { path: written, content: 'original' });
  await turn.callTool('call_edit', 'edit', { path: written, oldString: 'original', newString: 'updated' });
  assert.match(fs.readFileSync(written, 'utf8'), /updated/);
  turn.text('Done');
  turn.finish();
});
