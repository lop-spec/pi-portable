import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function smokeDesktopAutoReset(contents, profile) {
  const runtime = path.join(profile, 'runtime-data');
  const history = path.join(runtime, '_历史版本');
  // Keep the backup inside this fixture even if a parent has a history folder.
  fs.mkdirSync(history, { recursive: true });
  const result = await contents.executeJavaScript(`(async () => {
    const waitFor = async (read) => {
      for (let n = 0; n < 100; n++) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      throw new Error('Account toggle did not reach the expected UI state');
    };
    const denied = await fetch('/__pi_account_auto_reset', {
      method: 'POST', referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const trigger = await waitFor(() => document.querySelector('#pi-account-usage-button'));
    trigger.click();
    const button = await waitFor(() => document.querySelector('#pi-account-auto-reset:not(:disabled)'));
    const initial = button.getAttribute('aria-checked');
    const states = [];
    for (const value of [initial !== 'true', initial === 'true']) {
      button.click();
      await waitFor(() => !button.disabled && button.getAttribute('aria-checked') === String(value));
      const reply = await fetch('/__pi_account_usage', { cache: 'no-store' });
      states.push((await reply.json()).autoReset?.enabled);
    }
    return { denied: denied.status, initial, states };
  })()`);
  assert.deepEqual(result, { denied: 403, initial: 'true', states: [false, true] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'account-auto-reset.json'), 'utf8')).enabled, true);
  const backup = fs.readdirSync(history).find(name => name.startsWith('account-auto-reset.json.bak-'));
  assert.ok(backup, 'The previous setting was not backed up');
  assert.equal(JSON.parse(fs.readFileSync(path.join(history, backup), 'utf8')).enabled, false);
  return { ...result, persisted: true, backup: true };
}
