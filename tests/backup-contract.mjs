import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backup = fileURLToPath(new URL('../tools/backup.mjs', import.meta.url));

test('unlabeled backups retain every file, and labeled backups are verified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-backup-contract-'));
  try {
    const first = path.join(dir, 'first.txt'), second = path.join(dir, 'second.txt');
    fs.writeFileSync(first, 'first');
    fs.writeFileSync(second, 'second');
    const history = path.join(dir, '_历史版本');
    fs.mkdirSync(history);
    const output = execFileSync(process.execPath, [backup, first, second], { encoding: 'utf8', windowsHide: true });
    assert.equal(output.match(/^OK /gm)?.length, 2);
    assert.equal(fs.readFileSync(path.join(history, fs.readdirSync(history).find(name => name.startsWith('first.txt.bak-'))), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(history, fs.readdirSync(history).find(name => name.startsWith('second.txt.bak-'))), 'utf8'), 'second');
    const labeled = execFileSync(process.execPath, [backup, first, '--label', 'test'], { encoding: 'utf8', windowsHide: true });
    assert.match(labeled, /first\.txt\.bak-\S+-test/);
    assert.equal(fs.readdirSync(history).length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
