// 推理强度下限=low 补丁契约:源码副本与打包压缩副本两种形态都要改对,行为经真实 import 验证,幂等,锚点失配零写入。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION, patchMinThinking, targets, transform } from "../tools/patch-pi-min-thinking.mjs";

const SOURCE_FORM = `const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function getSupportedThinkingLevels(model) {
    if (!model.reasoning)
        return ["off"];
    return EXTENDED_THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === "xhigh" || level === "max")
            return mapped !== undefined;
        return true;
    });
}
export function clampThinkingLevel(model, level) {
    const availableLevels = getSupportedThinkingLevels(model);
    if (availableLevels.includes(level))
        return level;
    const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
    if (requestedIndex === -1)
        return availableLevels[0] ?? "off";
    for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
        const candidate = EXTENDED_THINKING_LEVELS[i];
        if (availableLevels.includes(candidate))
            return candidate;
    }
    for (let i = requestedIndex - 1; i >= 0; i--) {
        const candidate = EXTENDED_THINKING_LEVELS[i];
        if (availableLevels.includes(candidate))
            return candidate;
    }
    return availableLevels[0] ?? "off";
}
//# sourceMappingURL=models.js.map
`;
// 打包副本:压缩单行,函数声明不带 export,靠文件尾的 export{} 列表导出。
const BUNDLE_FORM = `var EXTENDED_THINKING_LEVELS=["off","minimal","low","medium","high","xhigh","max"];function getSupportedThinkingLevels(model){return model.reasoning?EXTENDED_THINKING_LEVELS.filter(level=>{let mapped=model.thinkingLevelMap?.[level];return mapped===null?!1:level==="xhigh"||level==="max"?mapped!==void 0:!0}):["off"]}function clampThinkingLevel(model,level){let availableLevels=getSupportedThinkingLevels(model);if(availableLevels.includes(level))return level;let requestedIndex=EXTENDED_THINKING_LEVELS.indexOf(level);if(requestedIndex===-1)return availableLevels[0]??"off";for(let i=requestedIndex;i<EXTENDED_THINKING_LEVELS.length;i++){let candidate=EXTENDED_THINKING_LEVELS[i];if(availableLevels.includes(candidate))return candidate}for(let i=requestedIndex-1;i>=0;i--){let candidate=EXTENDED_THINKING_LEVELS[i];if(availableLevels.includes(candidate))return candidate}return availableLevels[0]??"off"}export{getSupportedThinkingLevels as a,clampThinkingLevel as b};`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "min-thinking-"));
const load = async (name, code) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, code);
  return import(pathToFileURL(file).href);
};

try {
  const patchedSource = transform(SOURCE_FORM, "source");
  const patchedBundle = transform(BUNDLE_FORM, "bundle");
  for (const text of [patchedSource, patchedBundle]) assert.ok(text.includes(`/* ${VERSION} */`), "marker present");
  assert.equal(transform(patchedSource), patchedSource, "source form is idempotent");
  assert.equal(transform(patchedBundle), patchedBundle, "bundle form is idempotent");

  const a = await load("models.mjs", patchedSource);
  const b = await load("bundle.mjs", patchedBundle);
  const levelsOf = (impl, model) => (impl === a ? impl.getSupportedThinkingLevels : impl.a)(model);
  const clampOf = (impl, model, level) => (impl === a ? impl.clampThinkingLevel : impl.b)(model, level);
  const full = { reasoning: true, thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
  const noMap = { reasoning: true };
  const gpt6 = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
  const upToHigh = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null } };
  const onlyOff = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } };
  const plain = { reasoning: false };
  for (const impl of [a, b]) {
    assert.deepEqual(levelsOf(impl, full), ["low", "medium", "high", "xhigh", "max"], "full map starts at low");
    assert.deepEqual(levelsOf(impl, noMap), ["low", "medium", "high"], "unmapped reasoning model starts at low (xhigh/max need an explicit mapping)");
    assert.deepEqual(levelsOf(impl, gpt6), ["low", "medium", "high", "xhigh", "max"], "models that already hide off/minimal are unchanged");
    assert.deepEqual(levelsOf(impl, upToHigh), ["low", "medium", "high"], "cap at high keeps low..high");
    assert.deepEqual(levelsOf(impl, onlyOff), ["off"], "never produce an empty list: keep the original when nothing is left");
    assert.deepEqual(levelsOf(impl, plain), ["off"], "non-reasoning models keep the single off entry");
    assert.equal(clampOf(impl, full, "off"), "low", "off is raised to low");
    assert.equal(clampOf(impl, full, "minimal"), "low", "minimal is raised to low");
    assert.equal(clampOf(impl, full, "medium"), "medium", "medium stays");
    assert.equal(clampOf(impl, full, "max"), "max", "max stays");
    assert.equal(clampOf(impl, upToHigh, "xhigh"), "high", "levels above the cap still clamp downward");
    assert.equal(clampOf(impl, plain, "high"), "off", "non-reasoning models clamp to off");
  }

  // 锚点失配零写入:定义缺失/重复都抛错
  assert.throws(() => transform("export function other() {}"), /getSupportedThinkingLevels 定义命中 0 次/);
  assert.throws(() => transform(SOURCE_FORM + SOURCE_FORM), /命中 2 次/);
  assert.throws(() => transform(SOURCE_FORM.replace("clampThinkingLevel", "clampOther")), /clampThinkingLevel 定义命中 0 次/);

  // 文件级:模拟 SDK 目录(源码副本 + 同级 pi-ai + 打包副本),先 check 不写,再打补丁,再幂等
  const sdk = path.join(tmp, "node_modules/@earendil-works/pi-coding-agent");
  const ownAi = path.join(sdk, "node_modules/@earendil-works/pi-ai/dist/models.js");
  const siblingAi = path.join(tmp, "node_modules/@earendil-works/pi-ai/dist/models.js");
  const bundle = path.join(sdk, "dist/bundle/chunks/chunk-TEST.js");
  for (const [file, text] of [[ownAi, SOURCE_FORM], [siblingAi, SOURCE_FORM], [bundle, BUNDLE_FORM]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.writeFileSync(path.join(sdk, "dist/bundle/chunks/other.js"), "export const unrelated = 1;\n");
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
  assert.equal(targets(fs.realpathSync(sdk)).length, 3, "finds both source copies and the bundle chunk, ignores unrelated files");
  const checkResult = patchMinThinking(fs.realpathSync(sdk), { check: true });
  assert.equal(checkResult.status, "pending");
  assert.equal(fs.readFileSync(ownAi, "utf8"), SOURCE_FORM, "--check writes nothing");
  const done = patchMinThinking(fs.realpathSync(sdk));
  assert.equal(done.status, "patched");
  assert.equal(done.changed, 3);
  assert.equal(fs.readFileSync(ownAi, "utf8"), patchedSource);
  assert.equal(fs.readFileSync(siblingAi, "utf8"), patchedSource);
  assert.equal(fs.readFileSync(bundle, "utf8"), patchedBundle);
  assert.equal(patchMinThinking(fs.realpathSync(sdk)).status, "already-patched");

  console.log("patch-pi-min-thinking contract ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
