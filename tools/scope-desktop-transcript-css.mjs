import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../assets/piweb-overlay/desktop-transcript/',import.meta.url));
const require=createRequire(path.resolve(process.argv[2],'package.json'));
const postcss=require('postcss');
const tokens=postcss.parse(fs.readFileSync(root+'/vendor/tokens.css','utf8'));
tokens.walkAtRules('theme',rule=>rule.replaceWith(postcss.rule({selector:'.pd-transcript',nodes:rule.nodes})));
tokens.walkRules(rule=>{if(rule.selector==='.pd-transcript')return;rule.selector=rule.selectors.map(s=>s.trim()===':root'?'.pd-transcript':s.replace(':root[data-theme="dark"]',':root:not([data-theme="light"]) .pd-transcript').replace(':root[data-theme="light"]',':root[data-theme="light"] .pd-transcript')).join(',\n');});
function scoped(name){const sheet=postcss.parse(fs.readFileSync(root+'/vendor/'+name,'utf8'));sheet.walkRules(rule=>{if(rule.parent.type==='atrule'&&/keyframes/.test(rule.parent.name))return;rule.selector=rule.selectors.map(s=>s.includes(':root')?s.replace(/(:root\[[^\]]+\])/,'$1 .pd-transcript'):'.pd-transcript '+s).join(',\n');});return sheet.toString();}
let css=tokens.toString()+'\n.pd-transcript button {font:inherit;color:inherit;background:none;border:0;padding:0;}\n'+scoped('messages.css')+'\n'+scoped('prose.css');
css+='\n.pd-transcript { min-width:0; width:100%; font-family:var(--font-sans); font-size:var(--text-base); line-height:var(--leading-body);color:var(--ds-text-primary); }\n.pd-transcript button { font-family:inherit; cursor:pointer; }\n.pd-transcript [hidden] { display:none!important; }\n.pd-transcript .turn-process-body { min-width:0; }\n.pd-transcript .pd-file-menu { background:var(--ds-bg-elevated-opaque);padding:6px;box-shadow:var(--ds-shadow-dialog);border-radius:var(--radius-xs); }\n.pd-transcript .pd-file-menu button { display:block;padding:5px 10px; }\n';
fs.writeFileSync(root+'/desktop-transcript.css',css);
console.log('Scoped original Desktop sheets: '+Buffer.byteLength(css)+' bytes');
