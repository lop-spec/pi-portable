// Windows daily 05:00 task + logon catch-up. No browser, credentials or JSONL writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runAutoArchive } from '../assets/piweb-overlay/redesign/files/lib/portable-auto-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = process.argv[2] || process.env.PI_PORTABLE_DATA || path.join(root, 'data');
const agentDir = path.join(data, '.pi', 'agent');
const logFile = path.join(data, 'piweb-auto-archive.log');
const log = (record) => { fs.mkdirSync(data, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), ...record }) + '\n'); };
for (let attempt = 0; ; attempt++) {
  try { const result = await runAutoArchive({ agentDir }); log({ ok: true, ...result }); console.log(JSON.stringify(result)); break; }
  catch (error) {
    log({ ok: false, attempt, error: String(error.message || error) });
    if (attempt >= 11) { process.exitCode = 1; break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
