import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  MARK,
  applyConversationNodes,
  applyConversationNodesRoute,
  collectConversationNodeRecords,
  toConversationNodeLine,
} from "../tools/patch-piweb-conversation-nodes.mjs";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  content: [
    { type: "thinking", thinking: "internal" },
    { type: "text", text },
  ],
});

test("conversation nodes are real user questions plus stop conclusions only", () => {
  const transientRecovery = user(
    "[lop-run-supervisor recovery] run=x attempt=1 transient=1\n"
      + "Pi Web interrupted before persistence.\n\n原始请求:\n恢复我真正的问题",
  );
  const messages = [
    user("  # 用户问题\n第二行  "),
    assistant("先检查一下", "toolUse"),
    { role: "toolResult", content: [{ type: "text", text: "noise" }] },
    assistant("## 最终结论\n\n已经完成 **修复**。", "stop"),
    user("[lop-run-supervisor recovery] run=x attempt=2 leaf=y\n继续完成原目标"),
    assistant("中途报错", "error"),
    transientRecovery,
    assistant("第二个结论", "stop"),
  ];
  const entryIds = messages.map((_, index) => `entry-${index}`);

  const nodes = collectConversationNodeRecords(messages, entryIds);
  assert.deepEqual(nodes.map(({ role, text, entryId, sourceIndex }) => ({ role, text, entryId, sourceIndex })), [
    { role: "user", text: "用户问题 第二行", entryId: "entry-0", sourceIndex: 0 },
    { role: "assistant", text: "最终结论 已经完成 修复。", entryId: "entry-3", sourceIndex: 3 },
    { role: "user", text: "恢复我真正的问题", entryId: "entry-6", sourceIndex: 6 },
    { role: "assistant", text: "第二个结论", entryId: "entry-7", sourceIndex: 7 },
  ]);
  assert.equal(nodes.every((node) => !node.text.includes("\n")), true);
  assert.equal(nodes.some((node) => node.text.includes("先检查")), false);
  assert.equal(nodes.some((node) => node.text.includes("继续完成原目标")), false);
});

test("one-line node summaries strip markdown and cap long content", () => {
  assert.equal(
    toConversationNodeLine("### 标题\n- [链接](https://example.com) 与 `代码`  **重点**"),
    "标题 链接 与 代码 重点",
  );
  const long = toConversationNodeLine("甲".repeat(240));
  assert.equal(long.length, 140);
  assert.equal(long.endsWith("…"), true);
  assert.equal(long.includes("\n"), false);
});

function pageFixture({ client }) {
  const effects = client
    ? "(0,i.useEffect)(()=>{let t=e8.current,n=eP.current;if(!t||!n)return;let r=new IntersectionObserver(()=>{},{});return r.observe(t),()=>r.disconnect()},[H,U,e,eQ,eX,eW,eP]),(0,i.useEffect)(()=>{e2(e=>Math.max(e,B.length))},[B.length]);"
    : "";
  return `
const p1=new URLSearchParams({deferThinking:"1",deferMedia:"1"});
const p2=new URLSearchParams({deferThinking:"1",deferMedia:"1"});
function nR({messages:e,streamingMessage:t,scrollContainer:n,messageRefs:o,onRevealHistory:s}){let[l,a]=(0,i.useState)(!1),[d,c]=(0,i.useState)([]),[u,h]=(0,i.useState)(null),[p,g]=(0,i.useState)(600),[f,m]=(0,i.useState)(!1),[x,v]=(0,i.useState)(null),y=(0,i.useRef)(!1),b=(0,i.useRef)(null),k=(0,i.useRef)([]),w=(0,i.useRef)({nodes:[],gap:50,fillsHeight:!1}),j=(0,i.useRef)(null),S=(0,i.useRef)(new Map),C=(0,i.useRef)(null),M=(0,i.useRef)(null),T=(0,i.useRef)(null),R=(0,i.useMemo)(()=>t?[...e,t]:e,[e,t]),I=(0,i.useRef)(R);I.current=R;let L={nodes:d,gap:50};w.current=L;let F=(0,i.useCallback)(()=>{let e=n.current,t=b.current;if(!e||!t)return;let r=o.current,i=e.getBoundingClientRect(),s=[],l=0,d=null;for(let t of I.current){if("user"!==t.role&&"assistant"!==t.role)continue;let n=r?.[l];if(l++,"user"===t.role){d=null;let r=n?.getBoundingClientRect();d={userMessage:t,assistantPreviews:[],scrollTop:r?r.top-i.top+e.scrollTop:null},s.push(d);continue}if(!d)continue;let o="assistant"===t.role?"preview":"";o&&d.assistantPreviews.push({markdown:o,element:n})}let u=s.map((e,t)=>({topRatio:0,targetTurn:e,index:t}));let h=T.current,p=h?u[h.nodeIndex]:null;if(h&&p){let t=p.targetTurn.assistantPreviews[0],n=p.targetTurn.scrollTop;if(null===n)return;T.current=null}c(u)},[o,n]);${client ? "(0,i.useEffect)(()=>{let e=setTimeout(()=>{F(),$()},50);return()=>clearTimeout(e)},[e.length,F,$]);" : ""}let A=(e,t)=>{},D=(e,t)=>{},O=(e,t,r)=>{};if(!l)return null;return(0,r.jsxs)("div",{children:[L.nodes.map(e=>(0,r.jsx)("div",{"data-minimap-node-index":e.index,"data-minimap-node-active":""},e.index)),f&&d.length>0&&(0,r.jsx)("div",{"data-minimap-preview-box":"",children:d.map(e=>{var t;return(0,r.jsxs)("div",{className:nw().turn,"data-minimap-preview-index":e.index,"data-located":"true",children:[(0,r.jsx)("span",{className:nw().number,"aria-hidden":"true",children:String(e.index+1).padStart(2,"0")}),(0,r.jsxs)("div",{className:nw().content,children:[(0,r.jsx)("button",{type:"button",className:nw().user,"data-minimap-preview-user":e.index,onClick:()=>{A(e,"smooth")},children:(0,r.jsx)("span",{className:nw().userText,children:"string"==typeof(t=e.targetTurn.userMessage).content?t.content.trim():t.content.filter(e=>"text"===e.type).map(e=>e.text).join("\\n").trim()})}),e.targetTurn.assistantPreviews.map((t,n)=>(0,r.jsx)("div",{children:t.markdown},n))]})]},e.index)})})]})}
function chat(){const {loading:A,error:D,messages:B,entryIds:O,historyCursor:H,hasEarlierMessages:U,sessionIdRef:eW,messagesEndRef:eE,scrollContainerRef:eP,loadContext:eX,activeLeafId:eQ}=function(){};let[e1,e2]=(0,i.useState)(50),e8=(0,i.useRef)(null),e4=(0,i.useRef)(null),e6=(0,i.useRef)(!1);${effects}let td=(0,i.useCallback)(()=>{e2(e=>Math.max(e,2*B.length))},[B.length]);return(0,r.jsx)(nR,{messages:B,streamingMessage:_.streamingMessage,scrollContainer:eP,messageRefs:ta,onRevealHistory:td})}
`;
}

test("page transform creates compact Q/A nodes and on-demand full-history loading", () => {
  const client = applyConversationNodes(pageFixture({ client: true }), "client", { browserMark: true });
  assert.equal(client.applied, true);
  assert.match(client.out, new RegExp(MARK));
  assert.match(client.out, /nodes:"1"/);
  assert.match(client.out, /pwParams\.set\("before",pwBefore\)/);
  assert.match(client.out, /conversation node pagination stalled/);
  assert.match(client.out, /entryIds:O,sessionId:eW\.current\?\?void 0,activeLeafId:eQ/);
  assert.match(client.out, /tail:"1000"/);
  assert.match(client.out, /nodeRole/);
  assert.match(client.out, /whiteSpace:"nowrap"/);
  assert.match(client.out, /targetTurn\.previewText/);
  assert.match(client.out, /l=mergeConversationNodeRecords\([^;]+\)\.length>0/);
  assert.match(client.out, /conversation node history load failed/);
  assert.doesNotThrow(() => new Function(client.out));
  assert.equal(applyConversationNodes(client.out, "client", { browserMark: true }).applied, false);

  const server = applyConversationNodes(pageFixture({ client: false }), "server", { browserMark: false });
  assert.equal(server.applied, true);
  assert.match(server.out, new RegExp(MARK));
  assert.doesNotThrow(() => new Function(server.out));
  assert.doesNotMatch(server.out, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/context/);
});

test("nodes context route returns only user and stop messages without a 1000-entry cap", () => {
  const fixture = `async function j(a,{params:b}){let{id:c}=await b,d=new URL(a.url),i=d.searchParams.get("leafId")??void 0,k=d.searchParams.has("deferThinking"),l=d.searchParams.has("deferMedia"),m=Number(d.searchParams.get("tail")),n=Number.isFinite(m)&&m>0?Math.min(m,1e3):50,o=d.searchParams.get("before")??void 0;try{let m=(0,g.Uv)(entries,o??i,{deferThinking:k,deferToolResultImages:l,tail:n,excludeLeaf:!!o,sessionId:c});return e.NextResponse.json({context:m,tail:n,before:o??null})}catch(a){return e.NextResponse.json({error:String(a)},{status:500})}}`;
  const result = applyConversationNodesRoute(fixture, "nodes-route");
  assert.equal(result.applied, true);
  assert.match(result.out, /searchParams\.has\("nodes"\)/);
  assert.match(result.out, /Number\.MAX_SAFE_INTEGER/);
  assert.match(result.out, /"assistant"===pwMessage\.role&&"stop"===pwMessage\.stopReason/);
  assert.match(result.out, /hasMore:!1/);
  assert.equal(applyConversationNodesRoute(result.out, "nodes-route").applied, false);
});

test("transform refuses drift before writing", () => {
  assert.throws(
    () => applyConversationNodes("function unrelated(){}", "drift", { browserMark: true }),
    /锚点命中|拒绝写入/,
  );
  assert.throws(() => applyConversationNodesRoute("function unrelated(){}"), /锚点命中|拒绝写入/);
});

test("launcher and cloud release keep conversation nodes in the product path", () => {
  const launcher = fs.readFileSync("src/launcher.mjs", "utf8");
  const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
  const list = launcher.match(/for \(const patchName of \[(.*?)\]\)/s)?.[1] ?? "";
  assert.match(list, /patch-piweb-conversation-nodes\.mjs/);
  assert.equal(list.trim().endsWith('"patch-piweb-conversation-nodes.mjs"'), true);
  assert.match(workflow, /node --test tests\/patch-piweb-conversation-nodes-contract\.mjs/);
  assert.match(workflow, /Copy-Item tools\/patch-piweb-conversation-nodes\.mjs stage\/tools\/patch-piweb-conversation-nodes\.mjs/);
  assert.match(workflow, /pi-web conversation-nodes patch missing/);
});

test("CLI patches both page bundles and nodes route, renames the client chunk, and backs up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-conversation-nodes-"));
  const pkg = path.join(root, "pkg");
  const backup = path.join(root, "backup");
  const clientHash = "123456789abc";
  const clientRel = `.next/static/chunks/app/page-${clientHash}.js`;
  const serverRel = ".next/server/app/page.js";
  const manifestRel = ".next/server/app/page_client-reference-manifest.js";
  const routeRel = ".next/server/app/api/sessions/[id]/context/route.js";
  for (const rel of [clientRel, serverRel, manifestRel, routeRel]) {
    fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });
  }
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.8.11" }));
  fs.writeFileSync(path.join(pkg, clientRel), pageFixture({ client: true }));
  fs.writeFileSync(path.join(pkg, serverRel), pageFixture({ client: false }) + `\n${clientHash}`);
  fs.writeFileSync(path.join(pkg, manifestRel), `static/chunks/app/page-${clientHash}.js`);
  fs.writeFileSync(path.join(pkg, routeRel), `async function j(a,{params:b}){let{id:c}=await b,d=new URL(a.url),i=d.searchParams.get("leafId")??void 0,k=d.searchParams.has("deferThinking"),l=d.searchParams.has("deferMedia"),m=Number(d.searchParams.get("tail")),n=Number.isFinite(m)&&m>0?Math.min(m,1e3):50,o=d.searchParams.get("before")??void 0;try{let m=(0,g.Uv)(entries,o??i,{deferThinking:k,deferToolResultImages:l,tail:n,excludeLeaf:!!o,sessionId:c});return e.NextResponse.json({context:m,tail:n,before:o??null})}catch(a){return e.NextResponse.json({error:String(a)},{status:500})}}`);

  const script = path.resolve("tools/patch-piweb-conversation-nodes.mjs");
  const run = spawnSync(process.execPath, [script, "--pkg", pkg, "--backup", backup], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.status, "patched");
  assert.equal(summary.applied.nodesRoute, true);
  assert.equal(summary.chunk.renamed, true);
  assert.notEqual(summary.chunk.from, summary.chunk.to);
  assert.equal(fs.existsSync(path.join(pkg, ".next/static/chunks/app", summary.chunk.to)), true);
  assert.match(fs.readFileSync(path.join(pkg, manifestRel), "utf8"), new RegExp(summary.chunk.to.slice(5, -3)));
  assert.match(fs.readFileSync(path.join(pkg, routeRel), "utf8"), new RegExp(MARK));
  assert.equal(fs.existsSync(path.join(backup, clientRel)), true);
  assert.equal(fs.existsSync(path.join(backup, serverRel)), true);
  assert.equal(fs.existsSync(path.join(backup, routeRel)), true);
});
