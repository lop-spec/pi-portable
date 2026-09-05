#!/usr/bin/env node
// pi-web 0.8.11 local patch: refresh Pi's native OpenAI Codex catalogue when
// the model button opens, expose the refreshed list immediately, and persist a
// selected model as Pi's global default so new sessions inherit it.
//
// Usage: node patch-piweb-live-models.mjs [--pkg <package>] [--backup <dir>] [--check|--revert]
// Safety: exact version + unique anchors; every target is backed up before the
// first write; generated page chunks are content-addressed and old chunks stay.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLIENT_MARK = "__pwLiveModelsV1";
export const ROUTE_MARK = "__pwLiveModelRouteV1";
export const GLOBAL_DEFAULT_MARK = "__pwGlobalModelDefaultV1";
export const PATCH_REVISION = "r1";
const IDENT = "[A-Za-z_$][\\w$]*";

function only(matches, label) {
  if (matches.length !== 1) throw new Error(`${label} anchor matched ${matches.length} times (expected 1); refusing to write`);
  return matches[0];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function applyLiveModelsClient(src, label = "client") {
  if (src.includes(CLIENT_MARK)) return { out: src, applied: false };

  const callbackRe = new RegExp(
    `(${IDENT})=\\(0,(${IDENT})\\.useCallback\\)\\(async (${IDENT})=>\\{let (${IDENT})=([^,;]{1,160}),(${IDENT})=\\4\\?\`/api/models\\?cwd=\\$\\{encodeURIComponent\\(\\4\\)\\}\`:"/api/models",(${IDENT})=await fetch\\(\\6,\\3\\?\\{signal:\\3\\}:void 0\\)`,
    "g",
  );
  const callback = only([...src.matchAll(callbackRe)], `${label}: loadModels callback`);
  const [callbackText, loadModels, react, signal, cwd, cwdExpression, url, response] = callback;
  const callbackReplacement = `${loadModels}=(0,${react}.useCallback)(async(${signal},pwForceModelRefresh=!1)=>{let ${cwd}=${cwdExpression},${url}=${cwd}?"/api/models?cwd="+encodeURIComponent(${cwd})+(pwForceModelRefresh?"&refresh=1":""):pwForceModelRefresh?"/api/models?refresh=1":"/api/models",${response}=await fetch(${url},${signal}?{signal:${signal}}:void 0)`;

  const effectRe = new RegExp(
    `\\(0,(${IDENT})\\.useEffect\\)\\(\\(\\)=>\\{let (${IDENT})=new AbortController;return ${escapeRegex(loadModels)}\\(\\2\\.signal\\)\\.catch\\((${IDENT})=>\\{if\\(\\3 instanceof DOMException&&"AbortError"===\\3\\.name\\)return\\}\\),\\(\\)=>\\2\\.abort\\(\\)\\},\\[${escapeRegex(loadModels)},(${IDENT})\\]\\)`,
    "g",
  );
  const effect = only([...src.matchAll(effectRe)], `${label}: model-list effect`);
  const [, effectReact, controller, error, refreshKey] = effect;
  const effectReplacement = `(0,${effectReact}.useEffect)(()=>{let ${controller}=new AbortController,pwLiveModelClick=${error}=>{let pwModelTarget=${error}.target;pwModelTarget instanceof Element&&pwModelTarget.closest('.model-selector>button[aria-haspopup="listbox"]')&&${loadModels}(void 0,!0).catch(${error}=>console.error("[pi-web] live model refresh failed:",${error} instanceof Error?${error}.message:String(${error})))};return document.addEventListener("click",pwLiveModelClick,!0),${loadModels}(${controller}.signal).catch(${error}=>{if(${error} instanceof DOMException&&"AbortError"===${error}.name)return}),()=>{${controller}.abort(),document.removeEventListener("click",pwLiveModelClick,!0)}},[${loadModels},${refreshKey}])`;

  let out = src.replace(callbackText, callbackReplacement);
  out = out.replace(effect[0], effectReplacement);
  out += `\n;typeof window<"u"&&(window.${CLIENT_MARK}=!0);`;
  return { out, applied: true };
}

function nearestFunctionBefore(src, index, label) {
  const functions = [...src.slice(0, index).matchAll(new RegExp(`async function (${IDENT})\\((${IDENT})\\)\\{`, "g"))];
  if (functions.length === 0) throw new Error(`${label}: containing async function not found`);
  return functions.at(-1);
}

export function applyLiveModelsRoute(src, label = "models-route") {
  if (src.includes(ROUTE_MARK)) return { out: src, applied: false };
  const serviceAnchor = "createAgentSessionServices)({";
  const serviceHits = src.split(serviceAnchor).length - 1;
  if (serviceHits !== 1) throw new Error(`${label}: createAgentSessionServices anchor matched ${serviceHits} times (expected 1)`);
  const serviceIndex = src.indexOf(serviceAnchor);
  const loader = nearestFunctionBefore(src, serviceIndex, label);
  const [, loadFunction, cwdArgument] = loader;
  const signature = `async function ${loadFunction}(${cwdArgument}){`;
  const signatureHits = src.split(signature).length - 1;
  if (signatureHits !== 1) throw new Error(`${label}: loader signature matched ${signatureHits} times (expected 1)`);

  const servicesRe = new RegExp(
    `(${IDENT})=await \\(0,(${IDENT})\\.createAgentSessionServices\\)\\(([\\s\\S]{1,700}?)\\),(${IDENT})=\\1\\.modelRuntime\\.getError\\(\\)`,
    "g",
  );
  const services = only([...src.matchAll(servicesRe)], `${label}: service creation`);
  const [servicesText, service, moduleName, serviceArgs, modelError] = services;
  // The service expression sits inside a minified `let a=...,service=...,error=...`
  // declaration. End that declaration before emitting the observable refresh
  // statement, then start a new declaration for the original error variable.
  const servicesReplacement = `${service}=await (0,${moduleName}.createAgentSessionServices)(${serviceArgs}),pwLiveCatalogRefresh=await ${service}.modelRuntime.refresh({allowNetwork:!0,force:pwForceModelRefresh,providers:["openai-codex"]}).catch(a=>(console.error("[pi-web] model catalog refresh failed:",a instanceof Error?a.message:String(a)),{errors:new Map}));pwLiveCatalogRefresh.errors.size&&console.error("[pi-web] model catalog refresh failed:",[...pwLiveCatalogRefresh.errors.keys()].join(","));let ${modelError}=${service}.modelRuntime.getError()`;

  const cacheRe = new RegExp(`await \\(0,(${IDENT})\\.rC\\)\\((${IDENT}),\\(\\)=>${escapeRegex(loadFunction)}\\(\\2\\)\\)`, "g");
  const cache = only([...src.matchAll(cacheRe)], `${label}: model cache call`);
  const cacheIndex = cache.index;
  const handler = nearestFunctionBefore(src, cacheIndex, `${label}: GET handler`);
  const requestArgument = handler[2];
  const [, cacheModule, resolvedCwd] = cache;
  const cacheReplacement = `await("1"===new URL(${requestArgument}.url).searchParams.get("refresh")?${loadFunction}(${resolvedCwd},!0):(0,${cacheModule}.rC)(${resolvedCwd},()=>${loadFunction}(${resolvedCwd})))`;

  let out = src.replace(signature, `async function ${loadFunction}(${cwdArgument},pwForceModelRefresh=!1){`);
  out = out.replace(servicesText, servicesReplacement);
  out = out.replace(cache[0], cacheReplacement);
  out += `\n/*${ROUTE_MARK}*/`;
  return { out, applied: true };
}

export function applyGlobalModelDefault(src, label = "rpc-manager") {
  if (src.includes(GLOBAL_DEFAULT_MARK)) return { out: src, applied: false };
  const caseAnchor = 'case"set_model":';
  const hits = src.split(caseAnchor).length - 1;
  if (hits !== 1) throw new Error(`${label}: set_model case matched ${hits} times (expected 1)`);
  const start = src.indexOf(caseAnchor);
  const region = src.slice(start, start + 1800);
  const setter = only([...region.matchAll(new RegExp(`return await this\\.inner\\.setModel\\((${IDENT})\\),`, "g"))], `${label}: setModel call`);
  const model = setter[1];
  const replacement = `await this.inner.setModel(${model},{persist:!0}),await this.inner.settingsManager.flush();let pwModelPersistErrors=this.inner.settingsManager.drainErrors();if(pwModelPersistErrors.length)throw console.error("[pi-web] global model default persist failed:",pwModelPersistErrors.map(a=>a instanceof Error?a.message:String(a)).join("; ")),Error("Failed to persist global model default");return `;
  const absolute = start + setter.index;
  const out = src.slice(0, absolute) + replacement + src.slice(absolute + setter[0].length) + `\n/*${GLOBAL_DEFAULT_MARK}*/`;
  return { out, applied: true };
}

function main() {
  const args = process.argv.slice(2);
  const argValue = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const check = args.includes("--check");
  const pkg = argValue("--pkg", path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@agegr", "pi-web"));
  const portable = path.resolve(pkg).toLowerCase().includes(`${path.sep}portable${path.sep}app${path.sep}`);
  const backup = argValue("--backup", path.join(process.env.LOCALAPPDATA ?? "", "pi-web", `backup-0.8.11-pre-live-models-v1${portable ? "" : "-global"}`));
  const die = (message) => { console.error(`[ABORT] ${message}`); process.exit(1); };

  const packageFile = path.join(pkg, "package.json");
  if (!fs.existsSync(packageFile)) die(`package directory missing: ${pkg}`);
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (packageJson.version !== "0.8.11") die(`package version ${packageJson.version} != 0.8.11; refusing to execute`);

  if (args.includes("--revert")) {
    if (!fs.existsSync(backup)) die(`backup directory missing: ${backup}`);
    const restored = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(source); continue; }
        const relative = path.relative(backup, source);
        const target = path.join(pkg, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        restored.push(relative);
      }
    })(backup);
    console.log(JSON.stringify({ status: "reverted", pkg, restored }, null, 1));
    return;
  }

  const manifest = path.join(pkg, ".next", "server", "app", "page_client-reference-manifest.js");
  if (!fs.existsSync(manifest)) die("page_client-reference-manifest.js not found");
  const hashes = [...new Set([...fs.readFileSync(manifest, "utf8").matchAll(/static\/chunks\/app\/page-([a-z0-9]+)\.js/gu)].map((match) => match[1]))];
  if (hashes.length !== 1) die(`page chunk reference count is ${hashes.length}, expected 1`);
  const currentHash = hashes[0];
  const chunkDir = path.join(pkg, ".next", "static", "chunks", "app");
  const currentChunk = path.join(chunkDir, `page-${currentHash}.js`);
  const modelsRoute = path.join(pkg, ".next", "server", "app", "api", "models", "route.js");
  if (!fs.existsSync(currentChunk) || !fs.existsSync(modelsRoute)) die("page chunk or models route is missing");

  const rpcCandidates = [];
  (function findRpc(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { findRpc(file); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const source = fs.readFileSync(file, "utf8");
      if (source.includes('case"set_model":') && source.includes("Model not found:")) rpcCandidates.push({ file, source });
    }
  })(path.join(pkg, ".next", "server", "chunks"));
  if (rpcCandidates.length !== 1) die(`RPC manager candidates: ${rpcCandidates.length}, expected 1`);
  const rpc = rpcCandidates[0];
  const clientSource = fs.readFileSync(currentChunk, "utf8");
  const routeSource = fs.readFileSync(modelsRoute, "utf8");

  if (clientSource.includes(CLIENT_MARK) && routeSource.includes(ROUTE_MARK) && rpc.source.includes(GLOBAL_DEFAULT_MARK)) {
    console.log(JSON.stringify({ status: "already-patched", pkg, chunk: path.basename(currentChunk) }));
    return;
  }

  let client;
  let route;
  let globalDefault;
  try {
    client = applyLiveModelsClient(clientSource);
    route = applyLiveModelsRoute(routeSource);
    globalDefault = applyGlobalModelDefault(rpc.source);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const fingerprint = crypto.createHash("sha1")
    .update(currentHash).update(":").update(PATCH_REVISION).update(":")
    .update(applyLiveModelsClient.toString()).update(":")
    .update(applyLiveModelsRoute.toString()).update(":")
    .update(applyGlobalModelDefault.toString())
    .digest("hex");
  const nextHash = client.applied ? (`pwm${fingerprint}`).slice(0, currentHash.length) : currentHash;
  const nextChunk = path.join(chunkDir, `page-${nextHash}.js`);
  if (nextHash !== currentHash && fs.existsSync(nextChunk) && !fs.readFileSync(nextChunk, "utf8").includes(CLIENT_MARK)) {
    die(`target chunk exists and is not this patch: ${nextChunk}`);
  }

  const refEdits = [];
  if (nextHash !== currentHash) {
    const candidates = [];
    (function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        // Physical backups are immutable evidence, never deployment inputs.
        if (entry.isDirectory()) {
          if (entry.name !== "_历史版本") walk(file);
        } else if (!entry.name.includes(".bak-")) candidates.push(file);
      }
    })(path.join(pkg, ".next", "server", "app"));
    for (const name of ["build-manifest.json", "app-build-manifest.json", "react-loadable-manifest.json"]) {
      const file = path.join(pkg, ".next", name);
      if (fs.existsSync(file)) candidates.push(file);
    }
    for (const file of candidates) {
      const source = fs.readFileSync(file, "utf8");
      const count = source.split(currentHash).length - 1;
      if (count > 0) refEdits.push({ file, count, out: source.replaceAll(currentHash, nextHash) });
    }
    if (refEdits.reduce((sum, entry) => sum + entry.count, 0) < 1) die("page chunk references not found");
  }

  const summary = {
    status: check ? "check-ok" : "patched",
    pkg,
    version: packageJson.version,
    chunk: { from: `page-${currentHash}.js`, to: `page-${nextHash}.js`, renamed: nextHash !== currentHash },
    applied: { client: client.applied, modelsRoute: route.applied, globalDefault: globalDefault.applied },
    rpcChunk: path.relative(pkg, rpc.file),
    refEdits: refEdits.map((entry) => ({ file: path.relative(pkg, entry.file), count: entry.count })),
    backup,
  };
  if (check) { console.log(JSON.stringify(summary, null, 1)); return; }

  const targets = new Set([currentChunk, modelsRoute, rpc.file, ...refEdits.map((entry) => entry.file)]);
  for (const file of targets) {
    const destination = path.join(backup, path.relative(pkg, file));
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  if (client.applied) fs.writeFileSync(nextChunk, client.out);
  for (const entry of refEdits) fs.writeFileSync(entry.file, entry.out);
  if (route.applied) fs.writeFileSync(modelsRoute, route.out);
  if (globalDefault.applied) fs.writeFileSync(rpc.file, globalDefault.out);
  console.log(JSON.stringify(summary, null, 1));
}

const realPath = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
if (process.argv[1] && realPath(process.argv[1]).toLowerCase() === realPath(fileURLToPath(import.meta.url)).toLowerCase()) main();
