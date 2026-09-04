import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DISPLAY_MARK,
  LEGACY_PIN_MARK,
  MARK,
  applyDropAutoThinking,
  applyLegacyThinkingDefaultPins,
  applyModelsDefaultThinkingLevels,
  applyThinkingDefaultDisplay,
} from "../tools/patch-piweb-drop-auto-thinking.mjs";

const patchSource = fs.readFileSync(new URL("../tools/patch-piweb-drop-auto-thinking.mjs", import.meta.url), "utf8");

// Focused pi-web 0.8.11 minified fixtures. Symbols intentionally differ between the
// client and server render so the patch must discover anchors rather than hard-code names.
const CLIENT_PAGE = [
  'let[es,el]=(0,i.useState)("auto"),th=(0,i.useRef)(null);',
  'let t6=(0,i.useCallback)(async(e,t)=>{if(x){let n={provider:e,modelId:t};tu.current=n,et(n),ey(n);let r=e0.current??await td.current;if(!r)return;await nB(r,{type:"set_model",provider:e,modelId:t});return}},[x]);',
  'async function t3(){let s=await fetch("/api/models").then(e=>e.json()),l=s.modelList??[];if(q(l),x&&!e0.current){let e=(s.defaultModel?l.find(e=>e.id===s.defaultModel?.modelId&&e.provider===s.defaultModel?.provider):void 0)??l[0];er(e?{provider:e.provider,modelId:e.id}:null);let t=e&&s.thinkingLevelPins?.[`${e.provider}/${e.id}`];null===th.current&&el(t??"auto")}}',
  '["auto","off","minimal","low","medium","high","xhigh","max"]',
].join("");

const SERVER_PAGE = [
  'let[af,ag]=(0,ak.useState)("auto"),bm=(0,ak.useRef)(null);',
  'let bX=(0,ak.useCallback)(async(a,b)=>{if(q){let c={provider:a,modelId:b};bl.current=c,aa(c),at(c);let d=a0.current??await bj.current;if(!d)return;await rK(d,{type:"set_model",provider:a,modelId:b});return}},[q]);',
  'async function bZ(){let g=await fetch("/api/models").then(a=>a.json()),h=g.modelList??[];if(S(h),q&&!a0.current){let a=(g.defaultModel?h.find(a=>a.id===g.defaultModel?.modelId&&a.provider===g.defaultModel?.provider):void 0)??h[0];ac(a?{provider:a.provider,modelId:a.id}:null);let b=a&&g.thinkingLevelPins?.[`${a.provider}/${a.id}`];null===bm.current&&ag(b??"auto")}}',
  '["auto","off","minimal","low","medium","high","xhigh","max"]',
].join("");

const MODELS_ROUTE = 'async function o(a){let b=new Map,c=[],d=null,e={},f={},k=(0,g.getAgentDir)(),m=(0,l.Fk)(a,k),o=await (0,g.createAgentSessionServices)({cwd:a,agentDir:k}),p=o.modelRuntime.getError(),q=o.settingsManager,r=await (0,j.p)(o.modelRuntime,q.getEnabledModels()),{visible:s,thinkingLevelPins:t,warnings:u}=r;for(let a of(c=s.map(a=>({id:a.id,name:a.name,provider:a.provider})).sort(n),s)){let c=`${a.provider}:${a.id}`;b.set(c,a.name),e[c]=(0,h.getSupportedThinkingLevels)(a),a.thinkingLevelMap&&(f[c]=a.thinkingLevelMap)}let v=q.getDefaultProvider(),w=q.getDefaultModel(),x=(0,j.I)(r,{});return(0,i.Mx)({models:Object.fromEntries(b),modelList:c,defaultModel:d,thinkingLevels:e,thinkingLevelMaps:f,thinkingLevelPins:t},p)}let s={models:{},modelList:[],defaultModel:null,thinkingLevels:{},thinkingLevelMaps:{},thinkingLevelPins:{}};';

for (const [label, fixture] of [["client", CLIENT_PAGE], ["server", SERVER_PAGE]]) {
  test(`${label}: initial and model-selected reasoning labels use the resolved effective default`, () => {
    const dropped = applyDropAutoThinking(fixture, label, { browserMark: label === "client" }).out;
    const result = applyThinkingDefaultDisplay(dropped, label, { browserMark: label === "client" });

    assert.equal(result.applied, true);
    assert.match(result.out, new RegExp(DISPLAY_MARK));
    assert.match(result.out, /useState\)\("medium"\)/, "first render must never expose auto");
    assert.match(result.out, /\.defaultThinkingLevels\?\?\{\}/, "models response defaults must be retained per hook");
    assert.match(result.out, /pwDefaults\?\.\[`\$\{[^}]+\}:\$\{[^}]+\}`\]\?\?"medium"/, "model changes must update the displayed default");
    assert.doesNotMatch(result.out, /thinkingLevelPins\?\./, "display must use clamped effective defaults, not only enabledModels pins");
    assert.doesNotMatch(result.out, /\?\?"auto"/, "no visible fallback may resolve to auto");
  });
}

test("models API publishes the same precedence and clamp used by AgentSession", () => {
  const result = applyModelsDefaultThinkingLevels(MODELS_ROUTE, "models-route");
  assert.equal(result.applied, true);
  assert.match(result.out, new RegExp(DISPLAY_MARK));
  assert.match(
    result.out,
    /clampThinkingLevel\)\([^,]+,[^?]+\?\?[^?]+getModelThinkingLevel\([^)]*\)\?\?[^?]+getDefaultThinkingLevel\(\)\?\?"medium"\)/,
    "precedence must be enabledModels pin > per-model setting > global setting > SDK medium",
  );
  assert.match(result.out, /defaultThinkingLevels:/);
  assert.match(result.out, /defaultThinkingLevels:\{\}/, "error responses keep a stable response shape");
});

test("models API backfills effective slash-key defaults for already-loaded V1 clients", () => {
  const defaults = applyModelsDefaultThinkingLevels(MODELS_ROUTE, "models-route").out;
  const result = applyLegacyThinkingDefaultPins(defaults, "models-route");
  assert.equal(result.applied, true);
  assert.match(result.out, new RegExp(LEGACY_PIN_MARK));
  assert.match(result.out, /pwEffectiveThinkingPins=\{\.\.\.[A-Za-z_$][\w$]*\}/);
  assert.match(result.out, /pwEffectiveThinkingPins\[`\$\{[^}]+\.provider\}\/\$\{[^}]+\.id\}`\]=pwActualThinkingDefaults\[[A-Za-z_$][\w$]*\]/);
  assert.match(result.out, /thinkingLevelPins:pwEffectiveThinkingPins/);
  assert.match(result.out, /defaultThinkingLevels:pwActualThinkingDefaults/);
  assert.equal(applyLegacyThinkingDefaultPins(result.out, "models-route").applied, false);
  assert.throws(() => applyLegacyThinkingDefaultPins("no anchors", "missing-route"), /拒绝写入/);
});

test("both patch stages are idempotent and fail closed on changed anchors", () => {
  const dropped = applyDropAutoThinking(CLIENT_PAGE, "client", { browserMark: true });
  assert.equal(dropped.applied, true);
  assert.equal(applyDropAutoThinking(dropped.out, "client", { browserMark: true }).applied, false);

  const displayed = applyThinkingDefaultDisplay(dropped.out, "client", { browserMark: true });
  assert.equal(displayed.applied, true);
  assert.equal(applyThinkingDefaultDisplay(displayed.out, "client", { browserMark: true }).applied, false);
  assert.throws(() => applyThinkingDefaultDisplay("no anchors", "missing"), /锚点/);

  const route = applyModelsDefaultThinkingLevels(MODELS_ROUTE, "models-route");
  assert.equal(applyModelsDefaultThinkingLevels(route.out, "models-route").applied, false);
  assert.throws(() => applyModelsDefaultThinkingLevels("no anchors", "missing-route"), /锚点/);
});

test("deployment remains version-locked, backup-first, cache-safe, and non-destructive", () => {
  assert.match(patchSource, /if \(pkgJson\.version !== VERSION\) die/);
  assert.match(patchSource, /if \(fs\.existsSync\(dst\)\) continue;/, "first backup must never be overwritten");
  assert.doesNotMatch(patchSource, /fs\.unlinkSync|fs\.rmSync/, "running and cached chunks must not be deleted");
  assert.match(patchSource, /PATCH_REVISION/);
  assert.match(patchSource, /applyThinkingDefaultDisplay\.toString\(\)/, "display patch changes must rotate the chunk URL");
  assert.match(patchSource, /applyModelsDefaultThinkingLevels/, "server API patch must be part of the atomic deployment");
  assert.match(patchSource, /applyLegacyThinkingDefaultPins/, "already-loaded V1 clients must receive effective defaults without a hard reload");
  assert.match(patchSource, /args\.includes\("--revert"\)/);
  assert.match(patchSource, new RegExp(MARK));
});
