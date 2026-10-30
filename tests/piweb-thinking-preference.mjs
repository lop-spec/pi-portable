import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { readThinkingPreference, writeThinkingPreference, THINKING_PREFERENCE_KEY } from '../assets/piweb-overlay/redesign/files/lib/thinking-preference.mjs';
function storage() { const map = new Map(); return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)}; }
test('last explicit choice survives new sessions and refresh, including off', () => {
  const s=storage();
  for(const level of ['max','medium','high','off','xhigh']) {
    assert.equal(writeThinkingPreference(level,s),true);
    assert.equal(readThinkingPreference(s),level);
    assert.equal(readThinkingPreference(s),level);
  }
});
test('invalid old preference never becomes an explicit request',()=>{
  const s=storage();
  for(const bad of ['auto','undefined','ultra','',null]) {
    s.setItem(THINKING_PREFERENCE_KEY,bad);
    assert.equal(readThinkingPreference(s),null);
    assert.equal(writeThinkingPreference(bad,s),false);
  }
});
test('disabled storage and server rendering are safe',()=>{
  const s={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};
  assert.equal(readThinkingPreference(s),null);
  assert.equal(writeThinkingPreference('max',s),false);
  assert.equal(readThinkingPreference(),null);
});
test('hook hydrates explicit create override before asynchronous defaults; history never writes preference',()=>{
  const s=fs.readFileSync(new URL('../assets/piweb-overlay/redesign/files/hooks/useAgentSession.ts',import.meta.url),'utf8');
  assert.match(s,/useLayoutEffect\(\(\) => \{\s*if \(!isNew\) return;[\s\S]*?readThinkingPreference\(\)[\s\S]*?thinkingLevelOverrideRef.current = inherited;[\s\S]*?setNewSessionThinkingLevel\(inherited\)/);
  assert.match(s,/const selectedThinkingLevel = thinkingLevelOverrideRef.current \?\? newSessionDefaultThinkingLevel/);
  assert.match(s,/\? \{ thinkingLevel: selectedThinkingLevel \}/);
  assert.equal(s.split('writeThinkingPreference(level)').length-1,1);
  const change=s.slice(s.indexOf('const handleThinkingLevelChange'),s.indexOf('const handleToolPresetChange'));
  assert.ok(change.indexOf('writeThinkingPreference(level)')<change.indexOf('await sendAgentCommand'));
  assert.match(s,/asConcreteThinkingLevel\(data\?\.context.thinkingLevel\)/);
  assert.match(s,/setNewSessionThinkingLevel\(resolved\)/);
});
