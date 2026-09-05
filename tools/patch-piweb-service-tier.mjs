import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TIER_MARK = "__pwNativeServiceTierV2";
export function applyServiceTierRpc(source) {
  if (source.includes(TIER_MARK)) return { out: source, applied: false };
  if (source.includes("__pwNativeServiceTierV1")) {
    const start = source.indexOf('case"set_service_tier":');
    const end = source.indexOf('case"set_thinking_level":', start);
    if (start < 0 || end <= start) throw new Error("service tier migration anchors missing");
    source = source.slice(0, start) + source.slice(end);
  }
  const matches = [...source.matchAll(/case"set_thinking_level":\{let ([\w$]+)=([\w$]+)\.level;/g)];
  if (matches.length !== 1) throw new Error(`service tier RPC anchor count=${matches.length}, expected 1`);
  const match = matches[0];
  const command = match[2];
  // Use the public streamFunction/onPayload hooks. Native streamSimple deliberately
  // filters provider-specific options, so serviceTier alone would never reach the wire.
  // Preserve the original payload callback and change only the explicitly selected wire field.
  const code = `case"set_service_tier":{let pwTier=${command}.serviceTier??null;` +
    `if(![null,"default","priority","flex"].includes(pwTier))throw Error("Unsupported service tier: "+pwTier);` +
    `let pwAgent=this.inner.agent;if(typeof pwAgent.streamFunction!=="function")throw Error("Native streamFunction unavailable");` +
    `let pwState=pwAgent.${TIER_MARK};` +
    `if(!pwState){pwState={base:pwAgent.streamFunction,value:null};pwAgent.${TIER_MARK}=pwState;` +
    `pwAgent.streamFunction=function(model,context,options){` +
    `if(pwState.value===null)return pwState.base.call(this,model,context,options);` +
    `if(model.api!=="openai-codex-responses"){console.warn("[pi-web service tier] not applied: unsupported api="+model.api);return pwState.base.call(this,model,context,options)}` +
    `let pwValue=pwState.value;return pwState.base.call(this,model,context,{...options,onPayload:async(payload,...args)=>{` +
    `let result=await options?.onPayload?.(payload,...args),body=result??payload;` +
    `if(!body||typeof body!=="object"||Array.isArray(body))throw Error("Service tier requires an object payload");` +
    `return{...body,service_tier:pwValue}}})}}` +
    `pwState.value=pwTier;console.info("[pi-web service tier] selected="+(pwTier??"native")+"; applies to next provider request");` +
    `return{serviceTier:pwTier}}`;
  return { out: source.slice(0, match.index) + code + source.slice(match.index), applied: true };
}

export function patchServiceTierPackage(pkg, { check = false } = {}) {
  const root = path.join(pkg, ".next/server/chunks");
  if (!fs.existsSync(root)) throw new Error(`service tier server chunks missing: ${root}`);
  const candidates = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "_历史版本") walk(file); continue; }
      if (!entry.name.endsWith(".js") || entry.name.includes(".bak-")) continue;
      const source = fs.readFileSync(file, "utf8");
      if (source.includes('case"set_thinking_level":') && source.includes('case"set_model":')) candidates.push({ file, source });
    }
  }
  walk(root);
  if (candidates.length !== 1) throw new Error(`service tier RPC candidates=${candidates.length}, expected 1`);
  const { file, source } = candidates[0];
  const result = applyServiceTierRpc(source);
  if (result.applied && !check) {
    const backup = fileURLToPath(new URL("./backup.mjs", import.meta.url));
    execFileSync(process.execPath, [backup, "--label", "native-service-tier", file], { windowsHide: true, stdio: "pipe" });
    fs.writeFileSync(file, result.out);
    if (fs.readFileSync(file, "utf8") !== result.out) throw new Error("service tier RPC readback mismatch");
  }
  return { applied: result.applied, checked: check, file };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--pkg");
  const pkg = at >= 0 ? args[at + 1] : path.join(process.env.APPDATA || "", "npm/node_modules/@agegr/pi-web");
  try { console.log(JSON.stringify(patchServiceTierPackage(pkg, { check: args.includes("--check") }))); }
  catch (error) { console.error(`[pi-web service tier] patch failed: ${error.message}`); process.exitCode = 1; }
}
