// Refresh only from the pinned, official LGPL-3.0 PI-Desktop checkout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv[2];
const commit = 'c099b6a';
if (!source || !execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding:'utf8', windowsHide:true}).trim().startsWith(commit)) throw new Error('Pinned PI-Desktop checkout required');
const base = path.join(source, 'apps/desktop/src');
const dest = path.join(root, 'assets/piweb-overlay/desktop-transcript/vendor');
fs.mkdirSync(dest, {recursive:true});
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const records = [];
const read = name => fs.readFileSync(path.join(base, name), 'utf8').replaceAll('\r\n','\n');
function save(name, origin, transform = s => s) {
  const original = read(origin), next = transform(original);
  fs.writeFileSync(path.join(dest,name), next);
  records.push({name, source:origin, sourceSha256:sha(original), sha256:sha(next)});
}
const types = s => s.replaceAll('"@pi-desktop/shared"', '"./model"').replaceAll('"../../../lib/assistant-turns"','"./model"');
const translation = s => s.replaceAll('"react-i18next"', '"./host"');
const imports = (s, replacements) => { for(const [a,b] of Object.entries(replacements)) s=s.replaceAll('"'+a+'"','"'+b+'"'); return s; };
save('tool-display.ts','lib/tool-display.ts');
save('render-content-limits.ts','lib/render-content-limits.ts');
save('render-diagnostics.ts','lib/render-diagnostics.ts');
save('shiki.ts','lib/shiki.ts',s=>s.replaceAll('./render-content-limits.ts','./render-content-limits').replaceAll('./render-diagnostics.ts','./render-diagnostics'));
save('syntax.tsx','components/Markdown.tsx',s=>'import { memo, Fragment, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";\nimport type { ThemedToken } from "shiki";\nimport { ensureLang, getHighlightVersion, resolveLang, subscribeHighlighter, themeForMode, tokenizeIncremental, type LineCache, type ThemeMode } from "./shiki";\n'+s.slice(s.indexOf('const themeListeners'),s.indexOf('function CodeBlock')).replace('document.documentElement.dataset.theme === "light"','!document.documentElement.classList.contains("dark")').replace('["data-theme"]','["data-theme", "class"]').replace('function getThemeSnapshot(): ThemeMode {','function getThemeSnapshot(): ThemeMode {\n  if (typeof document === "undefined") return "dark";'));
save('activity-group-folding.ts','lib/activity-group-folding.ts',s=>s.replace('"./assistant-turns"','"./model"'));
save('turn-process.ts','lib/turn-process.ts',s=>types(s).replaceAll('"./assistant-turns"','"./model"').replace('"./transcript-display-mode"','"./model"'));
save('disclosure-scope.ts','features/chat/transcript/disclosure-scope.ts');
save('disclosure-anchor-context.ts','lib/disclosure-anchor-context.ts');
save('TextShimmer.tsx','features/chat/transcript/TextShimmer.tsx');
save('useSmoothText.ts','hooks/useSmoothText.ts',s=>s.replace('"../lib/render-content-limits"','"./render-content-limits"'));
save('icons.tsx','components/icons.tsx');
// Browser pointer focus can arrive in a separate task before click. Reading
// protection may retain an open level, but must not open a collapsed title first.
save('disclosure.tsx','features/chat/transcript/disclosure.tsx',s=>imports(s, {'../../../lib/disclosure-anchor-context':'./disclosure-anchor-context','../../../lib/transcript-reading-position':'./reading-state'}).replace('setReading(ownsReadingPosition(titleRef.current, bodyRef.current))','setReading(currentOpen.current && ownsReadingPosition(titleRef.current, bodyRef.current))'));
save('TurnProcess.tsx','features/chat/transcript/TurnProcess.tsx',s=>imports(translation(types(s)), {'../../../lib/subagent-topology':'./model','../../../lib/tool-display':'./tool-display','../../../lib/transcript-activity-summary':'./summary','../../../lib/transcript-search-context':'./host','../../../lib/turn-process':'./turn-process','../../../components/icons':'./icons'}));
save('ProcessActivityGroup.tsx','features/chat/transcript/ProcessActivityGroup.tsx',s=>imports(translation(types(s)), {'../../../lib/transcript-activity-summary':'./summary','../../../components/icons':'./icons'}));
save('tool-presentation.ts','lib/tool-presentation.ts',s=>types(s).replace('"./workspace-review"','"./model"'));
save('LargeTextPreview.tsx','components/LargeTextPreview.tsx',s=>imports(translation(s),{'../lib/render-content-limits':'./render-content-limits','./ui':'./host'}));
save('ToolDetails.tsx','components/ToolDetails.tsx',s=>imports(translation(s),{'./Markdown':'./host','./ui':'./host','../lib/chat-links':'./host','../hooks/use-preview-target':'./host','../hooks/use-chat-file-menu':'./host','./ContextMenu':'./host','../stores/app-store':'./host','../lib/tool-presentation':'./tool-presentation','./AskToolRichText':'./host'}));
save('shared.tsx','features/chat/transcript/shared.tsx',s=>{
  const pick=(start,end)=>s.slice(s.indexOf(start),end?s.indexOf(end,s.indexOf(start)):undefined);
  return `import { memo, useCallback, useContext, useId } from "react";\nimport type { UiMessage } from "./model";\nimport { useTranslation, useAppStore, resolveShowThinking, Markdown, useCopy, TooltipButton, TranscriptSearchContext, thinkingText } from "./host";\nimport { isThinkingActive } from "./turn-process";\nimport { disclosureKey, useAutomaticDisclosure } from "./disclosure";\nimport { TextShimmer } from "./TextShimmer";\nimport { IconCheck, IconCopy, IconChevronRight, IconSparkles, IconFileText, IconFolder, IconSearch, IconPencil, IconListChecks, IconTerminal, IconGlobe, IconBranch, IconBot, IconWrench } from "./icons";\nimport type { ToolAction } from "./tool-display";\nexport { useAutomaticDisclosure } from "./disclosure";\n`+
  pick('export function useMessageRevealRequest','/**\n * Format a message timestamp')+
  pick('export const TOOL_ACTION_KEYS','/** Actions whose path/url')+
  pick('export function ToolCommandCopy');
});
// Exact source sheets; the integration stage scopes selectors to the process surface.
for (const name of ['tokens.css','messages.css','prose.css']) save(name,'styles/'+name);
const locale = fs.readFileSync(path.join(source,'packages/i18n/src/locales/zh-CN/index.ts'),'utf8');
// This module is a plain locale object; retain the original object, no translation service.
const chat = locale.slice(locale.indexOf('  chat: {'), locale.indexOf('\n  composer:', locale.indexOf('  chat: {')));
// Keep only the independently balanced chat and askTool catalogs.
function catalog(key) {
  const start = locale.indexOf('  '+key+': {') + ('  '+key+': ').length;
  let depth=0, quoted=false, escape=false;
  for(let i=start;i<locale.length;i++) { const c=locale[i]; if(quoted){ if(escape)escape=false; else if(c==='\\\\')escape=true; else if(c==='"')quoted=false; continue; } if(c==='"'){quoted=true;continue;} if(c==='{')depth++; if(c==='}'&&--depth===0)return locale.slice(start,i+1); }
  throw new Error('Unbalanced catalog '+key);
}
const selected = 'export const zhCN = {chat: '+catalog('chat')+', askTool: '+catalog('askTool')+'};\n';
fs.writeFileSync(path.join(dest,'zh-CN.ts'),selected);
records.push({name:'zh-CN.ts',source:'packages/i18n/src/locales/zh-CN/index.ts',sourceSha256:sha(locale),sha256:sha(selected)});
fs.copyFileSync(path.join(source,'LICENSE'),path.join(dest,'COPYING.LESSER'));
fs.writeFileSync(path.join(dest,'provenance.json'),JSON.stringify({repository:'https://github.com/vastsa/PI-Desktop',commit:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),version:'0.21.0',license:'LGPL-3.0',files:records},null,2)+'\n');
console.log('Vendored '+records.length+' pinned PI-Desktop source files');
