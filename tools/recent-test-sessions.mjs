// Explicit test-session registry for the recent-tasks view. No content-based classification.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const action = args.shift();
const agentAt = args.indexOf('--agent-dir');
const agentDir = agentAt >= 0 ? args.splice(agentAt, 2)[1] : process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
if (!agentDir || !['add', 'remove', 'list'].includes(action) || (action !== 'list' && !args.length) || (action === 'list' && args.length) || args.some(id => !/^[a-z0-9][a-z0-9._-]*$/i.test(id))) {
  console.error('Usage: recent-test-sessions.mjs add|remove ID... [--agent-dir DIR] | list [--agent-dir DIR]');
  process.exit(2);
}
const file = path.join(agentDir, 'recent-test-sessions.json'), lock = `${file}.lock`;
let held = false, tmp;
try {
  if (action !== 'list') { fs.closeSync(fs.openSync(lock, 'wx')); held = true; }
  let registry = { version: 1, ids: [] };
  try { registry = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (registry.version !== 1 || !Array.isArray(registry.ids) || registry.ids.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(id))) throw new Error('Invalid test session registry');
  const ids = new Set(registry.ids);
  if (action === 'add') for (const id of args) ids.add(id);
  if (action === 'remove') for (const id of args) ids.delete(id);
  const result = { version: 1, ids: [...ids].sort() };
  if (action !== 'list' && JSON.stringify(result.ids) !== JSON.stringify([...new Set(registry.ids)].sort())) {
    if (fs.existsSync(file)) {
      const backup = spawnSync(process.execPath, [fileURLToPath(new URL('./backup.mjs', import.meta.url)), file, '--label', `test-tags-${process.pid}`], { encoding: 'utf8', windowsHide: true });
      if (backup.error || backup.status !== 0) throw new Error(`Backup failed: ${backup.error?.message || backup.stdout || backup.stderr}`);
    }
    tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, file); tmp = undefined;
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`[recent-test-sessions] ${error.message}`); process.exitCode = 1;
} finally {
  if (tmp) try { fs.unlinkSync(tmp); } catch {}
  if (held) try { fs.unlinkSync(lock); } catch {}
}
