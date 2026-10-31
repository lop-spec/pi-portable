// A model's context capacity is unknown, not a local limit. Patch both the SDK used
// by pi-web and the separate bundled Pi CLI. Validate every anchor before any write.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSdk } from './patch-pi-native-policy.mjs';

const VERSION = 'single-watermark-v1';
function replaceOnce(source, oldText, newText, label) {
  const oldCount = source.split(oldText).length - 1;
  const newCount = source.split(newText).length - 1;
  if (oldCount === 0 && newCount === 1) return source;
  if (oldCount !== 1 || newCount !== 0) throw Error(`${label}: anchor mismatch (old=${oldCount}, new=${newCount})`);
  return source.replace(oldText, () => newText);
}
export function transformations(sdk) {
  const core = path.join(sdk, 'node_modules/@earendil-works/pi-agent-core');
  const chunks = path.join(sdk, 'dist/bundle/chunks');
  const candidates = fs.readdirSync(chunks).filter(name => name.endsWith('.js')).filter(name => {
    const text = fs.readFileSync(path.join(chunks, name), 'utf8');
    return text.includes('function shouldCompact2(contextTokens,contextWindow,settings2)') && text.includes('function applyModelOverride(model,override)');
  });
  if (candidates.length !== 1) throw Error(`CLI runtime chunk mismatch: ${candidates.length}`);
  return [
    ['dist/cli/list-models.js', [
      ['context: formatTokenCount(m.contextWindow),', 'context: m.contextWindow > 0 ? formatTokenCount(m.contextWindow) : "?",'],
    ]],
    ['dist/modes/interactive/components/footer.js', [
      ['const contextPercentDisplay = contextPercent === "?"\n            ? `?/${formatTokens(contextWindow)}${autoIndicator}`\n            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;', 'const contextPercentDisplay = contextWindow > 0 ? (contextPercent === "?"\n            ? `?/${formatTokens(contextWindow)}${autoIndicator}`\n            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`)\n            : `${contextUsage?.tokens != null ? formatTokens(contextUsage.tokens) : "?"} tokens${autoIndicator}`;'],
    ]],
    ['dist/core/provider-composer.js', [
      ['return override ? applyModelOverride(model, override) : model;', 'return { ...(override ? applyModelOverride(model, override) : model), contextWindow: 0 };'],
    ]],
    ['dist/core/model-runtime.js', [
      ['            this.models.setProvider(base);\n            this.compositionErrors.delete(providerId);', '            this.models.setProvider({ ...base, getModels: () => base.getModels().map((model) => ({ ...model, contextWindow: 0 })) });\n            this.compositionErrors.delete(providerId);'],
      ['            if (base)\n                this.models.setProvider(base);', '            if (base)\n                this.models.setProvider({ ...base, getModels: () => base.getModels().map((model) => ({ ...model, contextWindow: 0 })) });'],
    ]],
    ['dist/core/agent-session.js', [
      ['                if (result?.cancel) {\n                    cancelledByExtension = true;\n                    throw new Error("Compaction cancelled");\n                }', '                if (result?.cancel) {\n                    if (typeof result.errorMessage === "string" && result.errorMessage) { fromExtension = true; throw new Error(result.errorMessage); }\n                    cancelledByExtension = true;\n                    throw new Error("Compaction cancelled");\n                }'],
      ['                if (extensionResult?.cancel) {\n                    cancelledByExtension = true;\n                    throw new Error("Compaction cancelled");\n                }', '                if (extensionResult?.cancel) {\n                    if (typeof extensionResult.errorMessage === "string" && extensionResult.errorMessage) { fromExtension = true; throw new Error(extensionResult.errorMessage); }\n                    cancelledByExtension = true;\n                    throw new Error("Compaction cancelled");\n                }'],
      ['const recoverableLength = sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);', 'const recoverableLength = (this.model?.contextWindow ?? 0) > 0 && sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);'],
      ['        const contextWindow = model.contextWindow ?? 0;\n        if (contextWindow <= 0)\n            return undefined;\n        // After compaction,', '        const contextWindow = model.contextWindow ?? 0;\n        // After compaction,'],
      ['        const percent = (estimate.tokens / contextWindow) * 100;', '        const percent = contextWindow > 0 ? (estimate.tokens / contextWindow) * 100 : null;'],
    ]],
    ['dist/core/compaction/compaction.js', [
      ['    if (!settings.enabled)\n        return false;\n    return contextTokens > contextWindow - settings.reserveTokens;', '    if (!settings.enabled || contextWindow <= 0)\n        return false;\n    return contextTokens > contextWindow - settings.reserveTokens;'],
    ]],
    ['dist/core/compaction/branch-summarization.js', [
      ['const contextWindow = model.contextWindow || 128000;', 'const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;'],
    ]],
    [path.join(core, 'dist/harness/compaction/compaction.js'), [
      ['    if (!settings.enabled)\n        return false;\n    return contextTokens > contextWindow - settings.reserveTokens;', '    if (!settings.enabled || contextWindow <= 0)\n        return false;\n    return contextTokens > contextWindow - settings.reserveTokens;'],
    ]],
    [path.join(core, 'dist/harness/compaction/branch-summarization.js'), [
      ['const contextWindow = model.contextWindow || 128000;', 'const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;'],
    ]],
    [path.join(core, 'dist/harness/runtime/drive/response.js'), [
      ['(isContextOverflow(response, intent.contextWindow) || isRecoverableLength(response, intent.intendedOutputLimit));', '(isContextOverflow(response, intent.contextWindow) || (intent.contextWindow > 0 && isRecoverableLength(response, intent.intendedOutputLimit)));'],
    ]],
    [path.join(core, 'dist/harness/pico3/kinds/generation.js'), [
      ['if (estimate(derived.messages) > model.contextWindow - model.maxTokens)', 'if (model.contextWindow > 0 && estimate(derived.messages) > model.contextWindow - model.maxTokens)'],
    ]],
    [path.join(chunks, candidates[0]), [
      ['context:formatTokenCount(m2.contextWindow),maxOut:', 'context:m2.contextWindow>0?formatTokenCount(m2.contextWindow):"?",maxOut:'],
      ['if(result?.cancel)throw cancelledByExtension=!0,new Error("Compaction cancelled");', 'if(result?.cancel){if(typeof result.errorMessage==="string"&&result.errorMessage)throw fromExtension=!0,new Error(result.errorMessage);throw cancelledByExtension=!0,new Error("Compaction cancelled")}'],
      ['if(extensionResult?.cancel)throw cancelledByExtension=!0,new Error("Compaction cancelled");', 'if(extensionResult?.cancel){if(typeof extensionResult.errorMessage==="string"&&extensionResult.errorMessage)throw fromExtension=!0,new Error(extensionResult.errorMessage);throw cancelledByExtension=!0,new Error("Compaction cancelled")}'],
      ['return override?applyModelOverride(model,override):model', 'return{...override?applyModelOverride(model,override):model,contextWindow:0}'],
      ['this.models.setProvider(base),this.compositionErrors.delete(providerId);return', 'this.models.setProvider({...base,getModels:()=>base.getModels().map(model=>({...model,contextWindow:0}))}),this.compositionErrors.delete(providerId);return'],
      ['base?this.models.setProvider(base):this.models.deleteProvider(providerId)', 'base?this.models.setProvider({...base,getModels:()=>base.getModels().map(model=>({...model,contextWindow:0}))}):this.models.deleteProvider(providerId)'],
      ['function shouldCompact(contextTokens,contextWindow,settings2){return settings2.enabled?contextTokens>contextWindow-settings2.reserveTokens:!1}', 'function shouldCompact(contextTokens,contextWindow,settings2){return settings2.enabled&&contextWindow>0?contextTokens>contextWindow-settings2.reserveTokens:!1}'],
      ['function shouldCompact2(contextTokens,contextWindow,settings2){return settings2.enabled?contextTokens>contextWindow-settings2.reserveTokens:!1}', 'function shouldCompact2(contextTokens,contextWindow,settings2){return settings2.enabled&&contextWindow>0?contextTokens>contextWindow-settings2.reserveTokens:!1}'],
      ['contextWindow=model.contextWindow||128e3,preparation=prepareBranchEntries(', 'contextWindow=model.contextWindow>0?model.contextWindow:Infinity,preparation=prepareBranchEntries('],
      ['tokenBudget=(model.contextWindow||128e3)-reserveTokens', 'tokenBudget=(model.contextWindow>0?model.contextWindow:Infinity)-reserveTokens'],
      ['isContextOverflow(response,intent.contextWindow)||isRecoverableLength(response,intent.intendedOutputLimit)', 'isContextOverflow(response,intent.contextWindow)||intent.contextWindow>0&&isRecoverableLength(response,intent.intendedOutputLimit)'],
      ['recoverableLength=sameModel&&assistantIsProjected&&isRecoverableLength(assistantMessage,this.model?.maxTokens??0)', 'recoverableLength=(this.model?.contextWindow??0)>0&&sameModel&&assistantIsProjected&&isRecoverableLength(assistantMessage,this.model?.maxTokens??0)'],
      ['let contextWindow=model.contextWindow??0;if(contextWindow<=0)return;let projection=', 'let contextWindow=model.contextWindow??0;let projection='],
      ['percent=estimate.tokens/contextWindow*100;', 'percent=contextWindow>0?estimate.tokens/contextWindow*100:null;'],
      ['contextPercentDisplay=contextPercent==="?"?`?/${formatTokens(contextWindow)}${autoIndicator}`:`${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`', 'contextPercentDisplay=contextWindow>0?contextPercent==="?"?`?/${formatTokens(contextWindow)}${autoIndicator}`:`${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`:`${contextUsage?.tokens!=null?formatTokens(contextUsage.tokens):"?"} tokens${autoIndicator}`'],
    ]],
  ].map(([file, edits]) => ({ file: path.isAbsolute(file) ? file : path.join(sdk, file), edits }));
}
export function patchInstalledSingleWatermark(sdk, { check = false } = {}) {
  const targets = transformations(sdk);
  const changes = targets.map(({ file, edits }) => {
    const before = fs.readFileSync(file, 'utf8');
    const after = edits.reduce((text, [oldText, newText], i) => replaceOnce(text, oldText, newText, `${file}:${i}`), before);
    return { file, before, after };
  }).filter(x => x.before !== x.after);
  for (const e of changes) {
    const tmp = `${e.file}.watermark-check-${process.pid}.mjs`;
    try { fs.writeFileSync(tmp, e.after, { flag: 'wx' }); execFileSync(process.execPath, ['--check', tmp], { windowsHide: true, stdio: 'pipe' }); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  if (!check && changes.length) {
    // The same validated physical-backup implementation as the `bak` command.
    const backup = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup.mjs');
    execFileSync(process.execPath, [backup, ...changes.map(x => x.file), '--label', VERSION], { windowsHide: true, stdio: 'pipe' });
    for (const e of changes) if (fs.readFileSync(e.file, 'utf8') !== e.before) throw Error(`Concurrent SDK change: ${e.file}`);
    for (const e of changes) {
      const stage = `${e.file}.watermark-stage-${process.pid}`;
      try {
        fs.writeFileSync(stage, e.after, { flag: 'wx' });
        if (fs.readFileSync(e.file, 'utf8') !== e.before) throw Error(`Concurrent SDK change before rename: ${e.file}`);
        fs.renameSync(stage, e.file);
        if (fs.readFileSync(e.file, 'utf8') !== e.after) throw Error(`Readback mismatch: ${e.file}`);
      } finally { if (fs.existsSync(stage)) fs.unlinkSync(stage); }
    }
  }
  return { version: VERSION, status: changes.length ? (check ? 'pending' : 'patched') : 'already-patched', sdk, checked: targets.length, changed: changes.length, runtime: 'not-verified' };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const s = process.argv.indexOf('--sdk'), p = process.argv.indexOf('--pkg');
    const sdk = s >= 0 ? process.argv[s + 1] : resolveSdk(p >= 0 ? process.argv[p + 1] : path.join(process.env.PI_PORTABLE_HOME || '.', 'app/node_modules/@agegr/pi-web'));
    console.log(JSON.stringify(patchInstalledSingleWatermark(sdk, { check: process.argv.includes('--check') })));
  } catch (error) { console.error('[single-watermark]', error.message); process.exitCode = 1; }
}
