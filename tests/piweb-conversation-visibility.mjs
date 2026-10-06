// D16 (2026-10 redesign): compaction summaries are no longer group anchors and are rendered by
// React as one dim line inside the turn's process (「上下文已自动压缩」); the full history keeps
// the original card. The injected script therefore no longer hides them (nor auto-expands the
// removed ProcessDetailsGroup), and none of its observers watches the whole document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const all = fs.readFileSync(new URL('../src/piweb-archive-ui.js', import.meta.url), 'utf8');

test('the DOM compaction hider and process auto-expander are gone', () => {
  assert.doesNotMatch(all, /markdown-compaction-message|data-pi-compaction-hidden|__piConversationVisibility/u);
  assert.doesNotMatch(all, /展开处理详情|Expand process details/u, 'ProcessDetailsGroup no longer exists; nothing to auto-open');
});

test('no injected observer watches documentElement; characterData is limited to the status shelf', () => {
  assert.doesNotMatch(all, /\.observe\(\s*document\.documentElement/u);
  const characterData = [...all.matchAll(/\.observe\(([^,]+),\s*\{[^}]*characterData:\s*true/gu)].map((match) => match[1].trim());
  assert.deepEqual(characterData, ['shelf'], 'goal status text changes in place; only its small shelf is watched for text');
  assert.doesNotMatch(all, /document\.addEventListener\(\s*["']scroll["']/u, 'no capture-phase scroll hook on the whole document');
});
