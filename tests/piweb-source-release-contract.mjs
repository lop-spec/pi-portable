import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const launcher=fs.readFileSync(new URL('../src/launcher.mjs',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
const expected=JSON.parse(fs.readFileSync(new URL('../assets/piweb-upstream.json',import.meta.url),'utf8'));
const source=launcher.slice(launcher.indexOf('function resolvePiWebEntry()'),launcher.indexOf('\nfunction portableizeModelAuth()'));
function resolve(pkg){return vm.runInNewContext(source+';resolvePiWebEntry()',{
 HOME:'C:/fixture',path,log(){},fs:{existsSync:()=>true,readFileSync:file=>JSON.stringify(file.endsWith('piweb-upstream.json')?expected:pkg)}
});}
test('launcher accepts pinned integrated package and preserves legacy runtime support',()=>{
 assert.equal(resolve({version:'0.8.11',bin:'bin/pi-web.js'}).sourceIntegrated,false);
 assert.equal(resolve({version:expected.version,bin:'bin/pi-web.js',piPortable:{sourceOverlay:1,upstreamRef:expected.ref}}).sourceIntegrated,true);
});
test('launcher rejects ordinary newer npm packages and incorrect upstream identities',()=>{
 for(const pkg of [{version:expected.version},{version:expected.version,piPortable:{sourceOverlay:1,upstreamRef:'wrong'}},{version:'999',piPortable:{sourceOverlay:1,upstreamRef:expected.ref}}])assert.throws(()=>resolve(pkg),/拒绝/);
 assert.match(launcher,/sourceIntegrated \? \[\] : \[/);
 assert.match(launcher,/patch-pi-native-policy.mjs/);
});
test('CI builds pinned source, fails native commands and permits app-only without rebuilding native shell',()=>{
 assert.match(workflow,/repository: agegr\/pi-web/);
 assert.match(workflow,/\$PSNativeCommandUseErrorActionPreference = \$true/);
 assert.match(workflow,/node tools\/patch-piweb-source.mjs --source upstream/);
 assert.match(workflow,/npm run build/);
 assert.match(workflow,/Move-Item \$packed\[0\].filename pi-web-upstream.tgz/);
 assert.match(workflow,/Build native no-console launcher\s+if: \$\{\{ !inputs.app_only \}\}/);
 assert.doesNotMatch(workflow,/@agegr\/pi-web@latest/);
});
