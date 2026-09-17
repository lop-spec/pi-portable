import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const script=fs.readFileSync(new URL('../tools/install-goal-review-tasks.ps1',import.meta.url),'utf8');
test('normal mode alternates Astra and Fable at quarter-hour boundaries',()=>{
  assert.match(script,/\$astraMinutes=if\(\$PiOnly\)\{15\}else\{30\}/);
  assert.match(script,/Profile='astra';Minutes=\$astraMinutes;Offset=0/);
  assert.match(script,/Profile='fable';Minutes=30;Offset=15/);
});
test('Pi-only fallback enables Astra every 15 minutes without Fable',()=>{
  assert.match(script,/\[switch\]\$PiOnly/);
  assert.ok(script.includes("$Enable -and (-not $PiOnly -or $p.Profile -eq 'astra')"));
});
test('installation backs up all known task generations and disables retired tasks without stopping live workers',()=>{
  assert.match(script,/foreach\(\$name in \$allNames\)/);
  assert.ok(script.includes(String.raw`tools\backup.mjs`));
  assert.match(script,/foreach\(\$name in \$retiredNames\)/);
  assert.ok(!script.includes('Stop-ScheduledTask'));
  assert.ok(script.includes(String.raw`src\goal-review-session.mjs`));
});
test('native readback checks phase, interval, enabled mode, and retired tasks',()=>{
  assert.ok(script.includes('$start.Minute % $p.Minutes'));
  assert.ok(script.includes('Task enabled-mode mismatch'));
  assert.ok(script.includes('Retired scheduler is still enabled'));
  assert.ok(script.includes('MODE='));
  assert.ok(script.includes('New-Object -ComObject Schedule.Service'));
  assert.ok(script.includes('Native next-run phase mismatch'));
});
