import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  FOLLOWUP_MARK,
  FOLLOWUP_RELOAD_MARK,
  MARK,
  applyFollowupModeUi,
  applyComposerControls,
  COMPOSER_MARK,
  applyPiWebInteractions,
  formatAtMentions,
  getClipboardPastePlan,
  isAwayFromBottom,
  uploadClipboardFiles,
} from "../tools/patch-piweb-interactions.mjs";
import lopFollowupExtension, {
  FOLLOWUP_PROFILES,
  FOLLOWUP_STATE_TYPE,
  assistantText,
  finalStandaloneLine,
} from "../src/extensions/lop-followup.ts";

const scriptPath = path.resolve(new URL("../tools/patch-piweb-interactions.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function clipboard({ files = [], text = "", includeItems = true } = {}) {
  return {
    items: includeItems
      ? files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }))
      : [],
    files,
    getData(type) { return type === "text/plain" || type === "text" ? text : ""; },
  };
}

function file(name, type = "", size = 12, extra = {}) {
  return { name, type, size, lastModified: 1, ...extra };
}

function fixtureBundle() {
  return [
    "function composer(){let X=\"\",H=\"C:/work\",eu=!0;",
    "useImperativeHandle(ref,()=>({insertText(e){let t=ez.current;if(!t)return void Q(t=>t+(t?\" \":\"\")+e);let n=t.selectionStart??t.value.length,r=t.selectionEnd??t.value.length,i=t.value.slice(0,n),o=t.value.slice(r),s=i.length>0&&!i.endsWith(\" \")?\" \":\"\",l=i+s+e+o;eX.current=l,Q(l),ev(null),requestAnimationFrame(()=>{t.focus()})}}));",
    "let tx=(0,i.useCallback)(()=>{},[]),tv=(0,i.useCallback)(e=>{let t=Array.from(e.clipboardData?.items??[]).filter(e=>e.type.startsWith(\"image/\"));t.length&&(e.preventDefault(),e1(t.map(e=>e.getAsFile()).filter(e=>null!==e)))},[e1]);",
    "(0,i.useEffect)(()=>{fetch(`/api/skills?cwd=${encodeURIComponent(H)}`)},[eu,H]);",
    "return(0,r.jsxs)(\"div\",{children:[(0,r.jsx)(nv,{error:u}),(0,r.jsx)(ny,{warnings:h}),body]})}",
    "function chat(){let td=(0,i.useCallback)(()=>{e2(e=>Math.max(e,2*B.length))},[B.length]),tc=eL&&0===B.length&&!_.isStreaming&&!e0,tu=!!_.streamingMessage?.content.length,tp=e?.cwd??o??void 0,tg=(0,i.useRef)(null),tf=(0,i.useRef)(null);",
    ";(0,i.useLayoutEffect)(()=>{let e=tf.current;if(!q||!e$)return;work()},[q]);",
    "return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsxs)(\"div\",{className:\"relative flex min-w-0 flex-1 overflow-hidden\",children:[(0,r.jsx)(\"div\",{ref:eP,className:\"min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]\",children:messages}),W?null:(0,r.jsx)(nR,{messages:B,streamingMessage:_.streamingMessage,scrollContainer:eP,messageRefs:ta,onRevealHistory:td})]}),input]})}",
    "function t6({options:e,value:t,onChange:n,onClear:o,emptyLabel:s,selectedLabel:l,disabled:a=!1,busy:d=!1,isAutoSelection:c=!1,ariaLabel:u,variant:h=\"toolbar\",placement:p=\"up\"}){let C=t2(),R=!1,N=a||d,$=e,D=l??(t?t.modelId:s??\"Select model\");let B=\"field\"===h?{}:{display:\"flex\",alignItems:\"center\",justifyContent:C?\"flex-start\":void 0,gap:6,width:C?\"100%\":void 0,maxWidth:C?\"100%\":220,height:32,padding:C?\"8px 10px\":\"8px 12px\",overflow:\"hidden\",border:\"none\",borderRadius:9,background:R?\"var(--bg-hover)\":\"none\",color:\"var(--text-muted)\",cursor:N?\"not-allowed\":\"pointer\",fontSize:12,opacity:N?.5:1,transition:\"background 0.12s, color 0.12s\"};return(0,r.jsxs)(\"div\",{style:{position:\"relative\",width:\"field\"===h||C?\"100%\":void 0,minWidth:0,flex:\"toolbar\"===h&&C?\"1 1 auto\":void 0},children:[(0,r.jsxs)(\"button\",{\"aria-label\":u,\"aria-haspopup\":\"listbox\",\"aria-expanded\":R,\"aria-busy\":d||void 0,disabled:N,title:d?\"Switching model\":N?D:$.length>0||o?\"Change model\":\"No available models\",children:[(0,r.jsx)(\"svg\",{}),(0,r.jsx)(\"span\",{style:{flex:1,minWidth:0,overflow:\"hidden\",textOverflow:\"ellipsis\",whiteSpace:\"nowrap\"},children:D}),\"field\"===h&&(0,r.jsx)(\"svg\",{})]})]})}",
    "let nb=(0,i.forwardRef)(function({onSend:e,onAbort:t,onSteer:n,onFollowUp:o,isStreaming:s,model:l,isAutoModelSelection:a,modelNames:d,modelList:c,modelError:u,modelScopeWarnings:h,onModelChange:p,modelSwitching:g,onCompact:f,onAbortCompaction:m,isCompacting:x,compactError:v,compactResult:b,toolPreset:k,onToolPresetChange:w,thinkingLevel:j,onThinkingLevelChange:S,availableThinkingLevels:C,thinkingLevelMap:M,retryInfo:R,queuedMessages:I,inputHistory:W=[],onRecallQueue:E,slashCommands:P,slashCommandsLoading:N,onLoadSlashCommands:$,onBuiltinCommand:z,soundEnabled:F,onSoundToggle:A,onAudioUnlock:D,onPromptWithStreamingBehavior:B,draftKey:O,cwd:H},U){let _,q,{t:Y}=fake(),Z=!1,X=\"\",es=[],eX={current:X},eQ={current:es},ty=[];eX.current=X,eQ.current=es,(0,i.useImperativeHandle)(U,()=>({}));return(0,r.jsxs)(\"div\",{children:[(ty.length>0||l||u)&&p&&(0,r.jsx)(t6,{options:ty,value:l,onChange:p,disabled:s,busy:g,isAutoSelection:a})]})})",
    'let preference=function(e=nU()){if(!e)return"default";try{let t=e.getItem(nH);return(0,nO.sn)(t)?t:"default"}catch{return"default"}}();',
    'function controls(){let [preset,setPreset]=(0,i.useState)("default");let audio=()=>{let e=localStorage.getItem("pi-sound-enabled");return null===e||"true"===e};return(0,r.jsxs)("div",{style:{marginLeft:Z?0:"auto"},children:[!s&&w&&(0,r.jsxs)("div",{ref:eF,style:{position:"relative"},children:[(0,r.jsxs)("button",{onClick:()=>!s&&et(e=>!e),disabled:s,title:Y("chat.changeToolPreset")})]}),void 0!==A&&(0,r.jsx)("button",{onClick:A,title:F?Y("chat.disableSound"):Y("chat.enableSound")})]})}',
    "function fakeHook(){let e={state:{extensionStatuses:[]}};void 0!==e.state.extensionStatuses&&eq(e.state.extensionStatuses??[]);let t9=(0,i.useCallback)(async e=>{if(!e.startsWith(\"/\"))return{handled:!1};let t=e.match(/^\\/([^\\s]+)(?:\\s+([\\s\\S]*))?$/);if(!t)return{handled:!1};let[,n,r=\"\"]=t,i=r.trim(),o=e0.current??await tW(),s=e=>(e.handled&&noop(),e);try{switch(n){case\"reload\":if(!o)return s({handled:!0,error:\"No active session to reload\"});return await nB(o,{type:\"reload\"}),s({handled:!0});case\"clone\":return s({handled:!0});default:return{handled:!1}}}catch(e){return s({handled:!0,error:String(e)})}},[])}",
  ].join("");
}

test("composer places model at right and removes tool/sound controls with full/muted defaults", () => {
  const source = fixtureBundle();
  const result = applyComposerControls(source);
  assert.ok(result.applied);
  assert.ok(result.out.includes(COMPOSER_MARK));
  assert.match(result.out, /__pwFullToolDefaultV1\*\/return"full"/);
  assert.doesNotMatch(result.out, /getItem\(nH\)/);
  assert.match(result.out, /marginLeft:Z\?0:"auto"\},children:\[\(ty\.length/);
  assert.match(result.out, /useState\)\("full"\)/);
  assert.doesNotMatch(result.out, /localStorage\.getItem\("pi-sound-enabled"\)/);
  assert.doesNotMatch(result.out, /!s&&w&&|void 0!==A&&/);
  assert.equal(applyComposerControls(result.out).out, result.out);
  assert.throws(() => applyComposerControls(source.replace('marginLeft:Z?0:"auto"', 'marginLeft:0')), /right controls/);
});

function createFakeFollowupRuntime({ initialEntries = [], sendError = null } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const entries = initialEntries.map((entry) => structuredClone(entry));
  const statuses = new Map();
  const notifications = [];
  const sent = [];
  let idle = true;
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendUserMessage(message) {
      if (sendError) throw sendError;
      sent.push(message);
    },
  };
  const ctx = {
    sessionManager: { getEntries: () => entries },
    isIdle: () => idle,
    ui: {
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      notify(message, type = "info") { notifications.push({ message, type }); },
    },
  };
  lopFollowupExtension(pi);
  return {
    commands,
    entries,
    handlers,
    notifications,
    sent,
    statuses,
    ctx,
    setIdle(value) { idle = value; },
    async fire(name, event = {}) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    state() {
      return [...entries].reverse().find((entry) => entry.customType === FOLLOWUP_STATE_TYPE)?.data;
    },
  };
}

test("pure text remains a native browser paste", () => {
  const plan = getClipboardPastePlan(clipboard({ text: "hello world" }));
  assert.equal(plan.shouldPreventDefault, false);
  assert.equal(plan.text, "hello world");
  assert.deepEqual(plan.files, []);
});

test("Explorer image with an empty MIME type is recovered by extension without duplication", () => {
  const screenshot = file("screen.PNG");
  const plan = getClipboardPastePlan(clipboard({ files: [screenshot], text: "screen.PNG" }));
  assert.equal(plan.shouldPreventDefault, true);
  assert.equal(plan.files.length, 1, "items and files must not double-enumerate one clipboard file");
  assert.deepEqual(plan.images, [{ file: screenshot, mimeType: "image/png" }]);
  assert.equal(plan.text, "", "file-manager generated filename text must not be duplicated");
});

test("mixed clipboard preserves real text and routes a non-image file to upload", () => {
  const report = file("report.pdf", "application/pdf", 256);
  const plan = getClipboardPastePlan(clipboard({ files: [report], text: "请检查这份报告" }));
  assert.equal(plan.shouldPreventDefault, true);
  assert.equal(plan.text, "请检查这份报告");
  assert.deepEqual(plan.images, []);
  assert.deepEqual(plan.others, [report]);
  assert.deepEqual(plan.paths, []);
});

test("an exposed or textual absolute path is referenced directly instead of uploaded", () => {
  const direct = file("notes.txt", "text/plain", 20, { path: "C:\\Docs\\notes.txt" });
  const directPlan = getClipboardPastePlan(clipboard({ files: [direct], text: "C:\\Docs\\notes.txt" }));
  assert.deepEqual(directPlan.paths, ["C:/Docs/notes.txt"]);
  assert.deepEqual(directPlan.others, []);
  assert.equal(directPlan.text, "");

  const browserFile = file("brief.pdf", "application/pdf", 20);
  const uriPlan = getClipboardPastePlan(clipboard({ files: [browserFile], text: "file:///C:/My%20Docs/brief.pdf" }));
  assert.deepEqual(uriPlan.paths, ["C:/My Docs/brief.pdf"]);
  assert.deepEqual(uriPlan.others, []);
  assert.equal(uriPlan.text, "");
});

test("@ mentions normalize Windows paths and quote whitespace", () => {
  assert.equal(
    formatAtMentions(["C:\\My Docs\\brief.pdf", "src/main.ts"]),
    '@"C:/My Docs/brief.pdf" @src/main.ts',
  );
});

test("ordinary file upload never overwrites conflicts and returns inserted names", async () => {
  class FakeFormData {
    constructor() { this.rows = []; }
    append(key, value, name) { this.rows.push({ key, value, name }); }
  }
  const calls = [];
  const responses = [
    { status: 409, ok: false, json: async () => ({ conflicts: ["report.pdf"] }) },
    { status: 200, ok: true, json: async () => ({ uploaded: ["report.pasted-42-1.pdf"], errors: [] }) },
  ];
  const report = file("report.pdf", "application/pdf", 10);
  const result = await uploadClipboardFiles([report], "C:\\work space", {
    FormData: FakeFormData,
    now: () => 42,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });
  assert.deepEqual(result, { uploaded: ["report.pasted-42-1.pdf"], errors: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/files/C%3A/work%20space?type=upload&conflict=error");
  assert.deepEqual(calls[0].init.body.rows.map((row) => row.name), ["report.pdf"]);
  assert.deepEqual(calls[1].init.body.rows.map((row) => row.name), ["report.pasted-42-1.pdf"]);
  assert.ok(calls.every((call) => call.url.includes("conflict=error")), "overwrite mode must never be used");
});

test("ordinary file upload enforces the server size contract before network I/O", async () => {
  let fetched = false;
  await assert.rejects(
    uploadClipboardFiles([file("huge.bin", "application/octet-stream", 25 * 1024 * 1024 + 1)], "C:/work", {
      fetch: async () => { fetched = true; },
    }),
    /25 MB/,
  );
  assert.equal(fetched, false);
});

test("scroll-bottom visibility uses the same eight-pixel tail tolerance", () => {
  assert.equal(isAwayFromBottom(91, 100, 200), true);
  assert.equal(isAwayFromBottom(92, 100, 200), false);
  assert.equal(isAwayFromBottom(100, 100, 200), false);
});

test("bundle patch installs paste, scroll, follow-up menu, and compact model controls atomically", () => {
  const source = fixtureBundle();
  const patched = applyPiWebInteractions(source, "fixture");
  assert.equal(patched.applied, true);
  assert.match(patched.out, new RegExp(MARK));
  assert.match(patched.out, new RegExp(FOLLOWUP_MARK));
  assert.match(patched.out, new RegExp(FOLLOWUP_RELOAD_MARK));
  assert.match(patched.out, /pwPayload\.shouldPreventDefault/);
  assert.match(patched.out, /if\(!pwPayload\.shouldPreventDefault\)return/);
  assert.match(patched.out, /\/api\/files\//);
  assert.match(patched.out, /pwPayload\.text&&pwPasteInsert/);
  assert.match(patched.out, /"data-pw-scroll-bottom":"true"/);
  assert.match(patched.out, /e\.addEventListener\("scroll"/);
  assert.match(patched.out, /\[tc,B\.length,eP,pwScrollCheck\]/, "listener must attach after an initially loading session receives messages");
  assert.match(patched.out, /pwScrollAway\(e\.scrollTop,e\.clientHeight,e\.scrollHeight\)/);
  assert.match(patched.out, /"data-lop-followup-action":"root-fix"/);
  assert.match(patched.out, /"data-lop-followup-action":"plan"/);
  assert.match(patched.out, /case"lop-followup-ui"/);
  assert.match(patched.out, /message:`\/lop-followup \$\{i\}`/);
  assert.match(patched.out, /await z\("\/reload"\)/, "an already-running session must self-reload once when the extension is newly installed");
  assert.match(patched.out, /justifyContent:"center",gap:0,width:32,maxWidth:32/);
  assert.match(patched.out, /title:d\?"Switching model":N\?D:\$\.length>0\|\|o\?`Change model: \$\{D\}`/);
  assert.match(patched.out, /"field"===h&&\(0,r\.jsx\)\("span"/, "toolbar model name must be hidden while field variants keep it");
  assert.doesNotMatch(patched.out, /clipboardData\?\.items\?\?\[\]\)\.filter\(e=>e\.type\.startsWith\("image\/"\)\)/);

  const again = applyPiWebInteractions(patched.out, "fixture-patched");
  assert.equal(again.applied, false);
  assert.equal(again.out, patched.out);
});

test("a bundle carrying the previous interaction marker receives only the new follow-up UI", () => {
  const previous = fixtureBundle().replace("function composer(){", `function composer(){let ${MARK}=1;`);
  const patched = applyPiWebInteractions(previous, "previous-v2");
  assert.equal(patched.applied, true);
  assert.match(patched.out, new RegExp(FOLLOWUP_MARK));
  assert.match(patched.out, new RegExp(FOLLOWUP_RELOAD_MARK));
  assert.match(patched.out, /case"lop-followup-ui"/);
  assert.doesNotMatch(patched.out, /pwPayload\.shouldPreventDefault/, "base interactions must not be applied twice");

  const direct = applyFollowupModeUi(patched.out, "previous-v2-patched");
  assert.equal(direct.applied, false);
});

test("an anchor mismatch aborts before producing a partial bundle", () => {
  const source = fixtureBundle().replace("dataTransfer-does-not-exist", "unused");
  assert.throws(
    () => applyPiWebInteractions(source.replace("onRevealHistory:td", "onRevealHistory:missing"), "broken"),
    /交叉校验失败|锚点命中/,
  );
});

test("terminal detection accepts only the final standalone assistant line", () => {
  assert.equal(
    assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "完成\n已确认根治" }] }),
    "完成\n已确认根治",
  );
  assert.equal(finalStandaloneLine("完成\r\n\r\n已确认根治\r\n"), "已确认根治");
  assert.notEqual(finalStandaloneLine("完成\n已确认根治。"), FOLLOWUP_PROFILES["root-fix"].terminalLine);
  assert.equal(finalStandaloneLine("```text\n已确认根治\n"), null, "a marker inside an open code fence must not terminate");
  assert.equal(assistantText({ role: "user", content: "已确认根治" }), null, "user text must never terminate");
});

test("extension uses only ordinary input/lifecycle APIs and sends one follow-up per settled assistant", async () => {
  const runtime = createFakeFollowupRuntime();
  assert.deepEqual(
    [...runtime.handlers.keys()].sort(),
    ["agent_settled", "input", "message_end", "session_shutdown", "session_start"],
    "the extension must not hook context, system prompts, tools, or provider requests",
  );
  assert.deepEqual([...runtime.commands.keys()], ["lop-followup"]);

  await runtime.fire("session_start", { reason: "startup" });
  await runtime.commands.get("lop-followup").handler("root-fix", runtime.ctx);
  await runtime.fire("input", { source: "rpc", text: "修复这个问题" });
  await runtime.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "已处理第一层问题" }], stopReason: "stop" } });
  await runtime.fire("agent_settled");
  assert.deepEqual(runtime.sent, [FOLLOWUP_PROFILES["root-fix"].prompt]);
  assert.equal(runtime.state().sent, 1);

  await runtime.fire("agent_settled");
  assert.equal(runtime.sent.length, 1, "duplicate settled events for the same assistant must not send twice");

  await runtime.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "修复完成\n已确认根治" }], stopReason: "stop" } });
  await runtime.fire("agent_settled");
  assert.equal(runtime.sent.length, 1);
  assert.equal(runtime.state().phase, "off");
  assert.equal(runtime.statuses.has("lop-followup"), false);
});

test("plan mode sends the execution handoff once and disarms before that turn", async () => {
  const runtime = createFakeFollowupRuntime();
  await runtime.fire("session_start", { reason: "startup" });
  await runtime.commands.get("lop-followup").handler("plan", runtime.ctx);
  await runtime.fire("input", { source: "rpc", text: "先给计划" });
  await runtime.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "计划如下\n方案已确认" }], stopReason: "stop" } });
  await runtime.fire("agent_settled");

  assert.deepEqual(runtime.sent, [FOLLOWUP_PROFILES.plan.handoff]);
  assert.equal(runtime.state().phase, "off");
  await runtime.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "执行完毕" }], stopReason: "stop" } });
  await runtime.fire("agent_settled");
  assert.equal(runtime.sent.length, 1, "the execution response must not restart plan follow-ups");
});

test("manual takeover and the eight-turn ceiling pause visibly instead of silently stopping", async () => {
  const manual = createFakeFollowupRuntime();
  await manual.fire("session_start", { reason: "startup" });
  await manual.commands.get("lop-followup").handler("thorough", manual.ctx);
  await manual.fire("input", { source: "rpc", text: "初始任务" });
  await manual.fire("input", { source: "rpc", text: "我来补充" });
  assert.equal(manual.state().phase, "paused");
  assert.match(manual.statuses.get("lop-followup"), /已暂停/);
  assert.equal(manual.sent.length, 0);

  const limited = createFakeFollowupRuntime();
  await limited.fire("session_start", { reason: "startup" });
  await limited.commands.get("lop-followup").handler("target", limited.ctx);
  await limited.fire("input", { source: "rpc", text: "目标任务" });
  for (let turn = 0; turn < 9; turn += 1) {
    await limited.fire("message_end", { message: { role: "assistant", content: `仍在处理 ${turn}`, stopReason: "stop" } });
    await limited.fire("agent_settled");
  }
  assert.equal(limited.sent.length, 8);
  assert.equal(limited.state().phase, "paused");
  assert.equal(limited.state().reason, "automatic-limit");
});

test("CLI check is read-only, apply rotates the chunk URL, and rerun is idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piweb-interactions-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chunkDir = path.join(root, ".next", "static", "chunks", "app");
  const serverDir = path.join(root, ".next", "server", "app");
  await mkdir(chunkDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.8.11" }));
  const oldHash = "aaaaaaaaaaaaaaaa";
  const oldChunk = path.join(chunkDir, `page-${oldHash}.js`);
  const manifest = path.join(serverDir, "page_client-reference-manifest.js");
  await writeFile(oldChunk, fixtureBundle());
  await writeFile(manifest, `self.__RSC_MANIFEST={chunk:"static/chunks/app/page-${oldHash}.js"}`);
  const beforeManifest = await readFile(manifest, "utf8");

  const check = spawnSync(process.execPath, [scriptPath, "--check", "--pkg", root], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const checkSummary = JSON.parse(check.stdout);
  assert.equal(checkSummary.status, "check-ok");
  assert.equal(await readFile(manifest, "utf8"), beforeManifest);
  await assert.rejects(stat(path.join(chunkDir, checkSummary.chunk.to)), /ENOENT/);

  const backup = path.join(root, "backup");
  const apply = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  const summary = JSON.parse(apply.stdout);
  assert.equal(summary.status, "patched");
  const newChunk = path.join(chunkDir, summary.chunk.to);
  assert.match(await readFile(newChunk, "utf8"), new RegExp(MARK));
  assert.match(await readFile(manifest, "utf8"), new RegExp(summary.chunk.to.replace(/^page-|\.js$/g, "")));
  assert.equal(await readFile(oldChunk, "utf8"), fixtureBundle(), "old running-client chunk must remain untouched");
  await stat(path.join(backup, ".next", "static", "chunks", "app", `page-${oldHash}.js`));

  const rerun = spawnSync(process.execPath, [scriptPath, "--pkg", root, "--backup", backup], { encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).status, "already-patched");
});

test("launcher, CI contract suite, and release stage all carry the patch", async () => {
  const [launcher, workflow] = await Promise.all([
    readFile(new URL("../src/launcher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(launcher, /"patch-piweb-interactions\.mjs"/);
  assert.match(workflow, /node --test tests\/patch-piweb-interactions-contract\.mjs/);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-interactions\.mjs stage\/tools\/patch-piweb-interactions\.mjs/);
});
