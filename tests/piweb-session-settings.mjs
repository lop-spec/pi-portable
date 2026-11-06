import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';
import {savedSessionSettings} from '../assets/piweb-overlay/portable-session-settings.mjs';
import {integrate} from '../tools/patch-piweb-source.mjs';
const source = process.env.PIWEB_SOURCE || fileURLToPath(new URL('../upstream/', import.meta.url));
const files = integrate(n => fs.readFileSync(path.join(source, n), 'utf8'));
const rpc = files.get('lib/rpc-manager.ts'), hook = files.get('hooks/useAgentSession.ts');
const snapshot = (id, level) => [{type:'model_change',provider:'fake',modelId:id},{type:'thinking_level_change',thinkingLevel:level}];
test('two saved conversations including an empty draft retain independent settings after defaults change', () => {
  const a = snapshot('astra','medium'), b = snapshot('sol','max');
  const before = JSON.stringify([a,b]);
  let defaults = {model:'luna',thinking:'high'};
  for (const next of ['terra','sol','astra']) {
    defaults = {model:next,thinking:'low'};
    assert.deepEqual(savedSessionSettings(a), {model:{provider:'fake',modelId:'astra'},thinkingLevel:'medium'});
    assert.deepEqual(savedSessionSettings(b), {model:{provider:'fake',modelId:'sol'},thinkingLevel:'max'});
  }
  assert.equal(JSON.stringify([a,b]), before);
  assert.equal(defaults.thinking, 'low');
});
test('branch-local latest setting wins, off is preserved, legacy assistant model is a fallback', () => {
  assert.equal(savedSessionSettings([...snapshot('astra','medium'),...snapshot('sol','off')]).thinkingLevel,'off');
  assert.equal(savedSessionSettings([...snapshot('astra','medium'),{type:'message',message:{role:'assistant',provider:'old',model:'luna'}}]).model.modelId,'astra');
  assert.equal(savedSessionSettings([{type:'message',message:{role:'assistant',provider:'old',model:'luna'}}]).model.modelId,'luna');
  assert.deepEqual(savedSessionSettings([]), {model:null,thinkingLevel:undefined});
});
test('restore passes saved strength and never saves startup defaults from an existing wrapper', () => {
  assert.match(rpc,/const initial = restoringSession \|\| hasExistingMessages \? null/);
  assert.match(rpc,/restoringSession && savedPreferences.thinkingLevel !== undefined[\s\S]*?thinkingLevel: savedPreferences.thinkingLevel as ThinkingLevel/);
  assert.match(rpc,/!sessionFile && effectiveInitialModel/);
  assert.match(rpc,/!sessionFile && thinkingLevel/);
  assert.match(rpc,/Saved session model is unavailable/);
});
test('real RPC branch only persists a new draft explicitly; existing conversation and implicit calls remain local', async () => {
  const from = rpc.indexOf('const persistDefault = command.persistDefault');
  const to = rpc.indexOf('        // SDK setModel', from);
  assert.ok(from > 0 && to > from);
  const code = rpc.slice(from,to);
  for (const [persistDefault,hasMessages,expected] of [[undefined,false,false],[true,false,true],[true,true,false],[false,true,false]]) {
    const calls = [];
    const inner = {sessionManager:{getBranch:()=>hasMessages?[{type:'message',message:{role:'user'}}]:snapshot('a','medium')},setModel:async (_m,opts)=>calls.push(opts)};
    await vm.runInNewContext(`(async function(){${code}}).call({inner})`,{inner,command:{persistDefault},model:{}});
    assert.equal(calls[0].persist,expected);
  }
});
test('defaults are never displayed as an existing session selection and only new drafts write the inherited effort', () => {
  assert.doesNotMatch(hook,/currentModel \?\? \(data\?\.context.messages.length === 0/);
  assert.doesNotMatch(hook,/currentThinkingLevel \?\? \(data\?\.context.messages.length === 0/);
  assert.equal(hook.split('if (isNew) writeThinkingPreference(level);').length-1,2);
  assert.equal(hook.split('persistDefault: true').length-1,1);
  const oldHandler = hook.slice(hook.indexOf('    const previousOverride = currentModelOverride;'),hook.indexOf('  const handleCompact'));
  assert.doesNotMatch(oldHandler,/persistDefault: true/);
});
