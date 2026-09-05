import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  CLIENT_MARK,
  GLOBAL_DEFAULT_MARK,
  ROUTE_MARK,
  applyGlobalModelDefault,
  applyLiveModelsClient,
  applyLiveModelsRoute,
} from "../tools/patch-piweb-live-models.mjs";

const patchSource = fs.readFileSync(new URL("../tools/patch-piweb-live-models.mjs", import.meta.url), "utf8");
const launcher = fs.readFileSync(new URL("../src/launcher.mjs", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

const CLIENT = [
  't3=(0,i.useCallback)(async e=>{let n=o??t?.cwd??"",r=n?`/api/models?cwd=${encodeURIComponent(n)}`:"/api/models",i=await fetch(r,e?{signal:e}:void 0);if(!i.ok)throw Error(`HTTP ${i.status}`);let s=await i.json();U(s.models)},[x,o,t?.cwd]),',
  '(0,i.useEffect)(()=>{let e=new AbortController;return t3(e.signal).catch(e=>{if(e instanceof DOMException&&"AbortError"===e.name)return}),()=>e.abort()},[t3,u])',
].join("");

const ROUTE = [
  'async function o(a){let b=new Map,k=(0,g.getAgentDir)(),m=(0,l.Fk)(a,k),o=await (0,g.createAgentSessionServices)({cwd:a,agentDir:k,...m?{resourceLoaderReloadOptions:m}:{}}),p=o.modelRuntime.getError(),q=o.settingsManager;return p}',
  'async function p(a){let c=new URL(a.url).searchParams.get("cwd")||process.cwd(),d=(0,f.resolve)(c);try{return Response.json(await (0,i.rC)(d,()=>o(d)))}catch{return Response.json({})}}',
].join("");

const RPC = 'case"set_model":{let{provider:b,modelId:c}=a,d=this.inner.modelRuntime.getModel(b,c);if(!d)throw Error(`Model not found: ${b}/${c}`);return await this.inner.setModel(d),(0,k.kn)(),(0,n.mD)(),{id:d.id,provider:d.provider}}';

test("client refreshes the native catalogue only on initial load or model-button open", () => {
  const result = applyLiveModelsClient(CLIENT);
  assert.equal(result.applied, true);
  assert.match(result.out, new RegExp(CLIENT_MARK));
  assert.match(result.out, /pwForceModelRefresh=!1/u);
  assert.match(result.out, /refresh=1/u);
  assert.match(result.out, /model-selector>button\[aria-haspopup="listbox"\]/u);
  assert.match(result.out, /live model refresh failed/u, "refresh failures must always be observable");
  assert.equal(applyLiveModelsClient(result.out).applied, false);
  assert.throws(() => applyLiveModelsClient("no anchors"), /refusing to write/u);
});

test("models route force-refreshes only openai-codex and bypasses its 60s cache on demand", () => {
  const result = applyLiveModelsRoute(ROUTE);
  assert.equal(result.applied, true);
  assert.match(result.out, new RegExp(ROUTE_MARK));
  assert.match(result.out, /refresh\(\{allowNetwork:!0,force:pwForceModelRefresh,providers:\["openai-codex"\]\}\)/u);
  assert.match(result.out, /model catalog refresh failed/u);
  assert.match(result.out, /\.catch\(a=>\(console\.error\("\[pi-web\] model catalog refresh failed:/u, "thrown refresh failures must fail open with a log");
  assert.match(result.out, /;pwLiveCatalogRefresh\.errors\.size/u, "refresh logging must not remain inside the minified let declaration");
  assert.match(result.out, /;let p=o\.modelRuntime\.getError\(\)/u);
  assert.match(result.out, /searchParams\.get\("refresh"\)\?o\(d,!0\):/u);
  assert.doesNotThrow(() => new Function(result.out), "patched route must remain valid JavaScript");
  assert.equal(applyLiveModelsRoute(result.out).applied, false);
});

test("picker selection is session-visible and atomically becomes the global Pi default", () => {
  const result = applyGlobalModelDefault(RPC);
  assert.equal(result.applied, true);
  assert.match(result.out, new RegExp(GLOBAL_DEFAULT_MARK));
  assert.match(result.out, /setModel\(d,\{persist:!0\}\)/u);
  assert.match(result.out, /settingsManager\.flush\(\)/u);
  assert.match(result.out, /settingsManager\.drainErrors\(\)/u);
  assert.match(result.out, /global model default persist failed/u);
  assert.equal(applyGlobalModelDefault(result.out).applied, false);
});

test("deployment is version-locked, backup-first, cache-safe, and shipped by CI", () => {
  assert.match(patchSource, /packageJson\.version !== "0\.8\.11"/u);
  assert.match(patchSource, /fs\.copyFileSync\(file, destination\)/u);
  assert.match(patchSource, /if \(check\).*return/u);
  assert.doesNotMatch(patchSource, /unlinkSync/u);
  assert.match(patchSource, /entry\.name !== "_历史版本"/u, "reference rewrites must never mutate physical backups");
  assert.match(patchSource, /!entry\.name\.includes\("\.bak-"\)/u);
  assert.match(patchSource, /PATCH_REVISION/u);
  const chain = launcher.match(/for \(const patchName of \[(.*?)\]\)/su)?.[1] ?? "";
  const liveIndex = chain.indexOf('"patch-piweb-live-models.mjs"');
  const nodesIndex = chain.indexOf('"patch-piweb-conversation-nodes.mjs"');
  assert.ok(liveIndex >= 0, "launcher patch chain is missing live models");
  assert.ok(nodesIndex > liveIndex, "conversation nodes must remain the final page patch");
  assert.match(workflow, /node --test tests\/patch-piweb-live-models-contract\.mjs/u);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-live-models\.mjs stage\/tools\/patch-piweb-live-models\.mjs/u);
  assert.match(workflow, /live-models patch missing/u);
});
