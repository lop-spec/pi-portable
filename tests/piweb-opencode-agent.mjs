import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClineTurn } from '../assets/piweb-overlay/cline-agent/cline-bridge.ts';
import { launchOpenCode, openCodeTools, OPENCODE_PREAMBLE, OPENCODE_TOOLS } from '../assets/piweb-overlay/cline-agent/opencode-launch.ts';

const bin = process.env.PI_WEB_OPENCODE_BIN;

test('lean tool specs preserve validation and parameter names', () => {
  const specs = openCodeTools([
    { name: 'bash', description: 'BUILTIN', parameters: { type: 'object', properties: { description: { type: 'string', description: 'BUILTIN' } }, required: ['description'] } },
    { name: 'task', description: 'BUILTIN', parameters: {} },
  ]);
  assert.deepEqual(specs, [{ name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] } }]);
});

test('pinned OpenCode CLI sends only the lean system prompt and executes native tools', { skip: !bin, timeout: 35_000 }, async (t) => {
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
  await turn.whenOpen(30_000);
  assert.equal(turn.system, OPENCODE_PREAMBLE);
  assert.deepEqual(openCodeTools(turn.tools).sort((a, b) => a.name.localeCompare(b.name)), OPENCODE_TOOLS);
  const result = await turn.callTool('call_read', 'read', { filePath });
  assert.match(result, /OPEN_CODE_NATIVE_READ/);
  turn.text('Done');
  turn.finish();
});
