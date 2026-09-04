// 前缀冻结合同:compact-guard 从"每轮滑窗"改为"冻结边界+水位滞回"后,
// 冻结期投影必须满足字节前缀性质(上一轮投影 = 本轮投影的前缀),缓存 miss 只许发生在(重)冻结轮。
// 跑法: node --test tests/prefix-freeze-contract.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const contractData = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prefix-freeze-"));
process.env.PI_PORTABLE_HOME = root;
process.env.PI_PORTABLE_DATA = contractData;
process.env.LOP_MEMORY_HOME = path.join(contractData, "memory");
process.env.LOP_MEMORY_DISABLE_PI_DISCOVERY = "1";
process.env.PI_CHAIN_SKIP_STARTUP_SCAN = "1";
process.env.PI_CHAIN_METRICS = path.join(contractData, "metrics.jsonl");
process.env.PI_CHAIN_LOG = path.join(contractData, "chain.log");
// 2026-09-04 起 compact-guard 在便携运行面(PI_PORTABLE_DATA)默认关闭,机制本身未删;
// 本合同专测冻结/前缀性质,显式开启以继续守住该机制,不受运行面默认值影响。
process.env.LOP_COMPACT_GUARD = "1";
process.on("exit", () => fs.rmSync(contractData, { recursive: true, force: true }));

const policy = await import(pathToFileURL(path.join(root, "src", "lop-chain.ts")).href + `?freeze=${Date.now()}`);
const handlers = new Map();
const mockPi = {
  on(name, handler) {
    const list = handlers.get(name) || [];
    list.push(handler);
    handlers.set(name, list);
  },
  sendMessage() {},
  sendUserMessage() {},
};
policy.default(mockPi);
const contextHandler = handlers.get("context")[0];
const compactHandler = (handlers.get("session_compact") || [[]])[0];

const SYS_TOKENS = 5000;
const bigTool = (n) => ({ role: "toolResult", content: `T${n} ` + "x".repeat(40000) }); // ≈10k tok
const smallTool = (n) => ({ role: "toolResult", content: `t${n} ` + "y".repeat(10000) }); // ≈2.5k tok
const asst = (n) => ({ role: "assistant", content: [{ type: "text", text: `第${n}轮完成` }] });

const history = [{ role: "user", content: "长任务开始" }];
let lastProjectedTok = 0;
const estTok = (arr) => arr.reduce((a, m) => {
  if (m.role === "assistant") return a + Math.ceil((m.content?.[0]?.text || "").length / 4);
  return a + Math.ceil(String(m.content || "").length / 4);
}, 0);

const projections = [];
const freezeRounds = [];
let prevSerialized = null;
let stableRounds = 0;
let unstableRounds = 0;
let postFreezeRounds = 0;

const ROUNDS = 40;
for (let round = 1; round <= ROUNDS; round += 1) {
  const newMsgs = [asst(round), freezeRounds.length === 0 ? bigTool(round) : smallTool(round)];
  history.push(...newMsgs);
  const usage = (lastProjectedTok || estTok(history)) + estTok(newMsgs) + SYS_TOKENS;
  // 深拷贝模拟"每轮从会话重建"——投影不得依赖上一轮对象引用
  const messages = history.map((m) => JSON.parse(JSON.stringify(m)));
  const out = contextHandler({ messages }, { getContextUsage: () => ({ tokens: usage }) });
  const projected = out?.messages || messages;
  lastProjectedTok = estTok(projected);
  const serialized = projected.map((m) => JSON.stringify(m));
  const isTrimRound = serialized.some((s) => s.includes("lop-compact-guard"));
  const newlyFroze = isTrimRound && (freezeRounds.length === 0 ||
    (prevSerialized && !serialized.slice(0, prevSerialized.length).every((s, i) => s === prevSerialized[i]) &&
     serialized.length >= prevSerialized.length));
  if (freezeRounds.length > 0) {
    postFreezeRounds += 1;
    const prefixStable = prevSerialized &&
      serialized.length >= prevSerialized.length &&
      prevSerialized.every((s, i) => s === serialized[i]);
    if (prefixStable) stableRounds += 1;
    else { unstableRounds += 1; freezeRounds.push(round); }
  } else if (isTrimRound) {
    freezeRounds.push(round);
  }
  projections.push(serialized);
  prevSerialized = serialized;
}

// 1) 冻结确实发生(增长期越线)
assert.ok(freezeRounds.length >= 1, "应至少发生一次冻结");
// 2) 触发前投影恒等(无裁剪)
for (let i = 0; i < freezeRounds[0] - 1; i += 1) {
  assert.ok(!projections[i].some((s) => s.includes("lop-compact-guard")), `第${i + 1}轮不应有裁剪`);
}
// 3) 核心:冻结后稳定前缀率 ≥95%(重冻结轮计为不稳定)
const stableRate = stableRounds / postFreezeRounds;
console.log(`prefix-freeze: freezeRounds=${JSON.stringify(freezeRounds)} postFreeze=${postFreezeRounds} stable=${stableRounds} rate=${(stableRate * 100).toFixed(1)}%`);
assert.ok(stableRate >= 0.95, `稳定前缀率 ${(stableRate * 100).toFixed(1)}% < 95%`);
// 4) 重冻结次数受控(稳态 2.5k/轮,水位带宽 ~65k → 每 ~26 轮才允许一次)
assert.ok(freezeRounds.length <= 2, `冻结次数 ${freezeRounds.length} 超预期`);
// 5) 存根确定性:同一位置的存根文本跨轮逐字节一致(抽查冻结后第 2、5 轮)
const a = projections[freezeRounds[0]];
const b = projections[Math.min(freezeRounds[0] + 3, ROUNDS - 1)];
for (let i = 0; i < a.length; i += 1) {
  if (a[i].includes("lop-compact-guard")) assert.equal(a[i], b[i], `位置 ${i} 存根跨轮漂移`);
}
// 6) session_compact 复位:复位后小上下文不再裁剪
if (compactHandler) {
  compactHandler({}, {});
  const fresh = [{ role: "user", content: "新压缩后" }, asst(999), smallTool(999)];
  const out2 = contextHandler({ messages: fresh.map((m) => JSON.parse(JSON.stringify(m))) }, { getContextUsage: () => ({ tokens: 8000 }) });
  const s2 = (out2?.messages || fresh).map((m) => JSON.stringify(m));
  assert.ok(!s2.some((s) => s.includes("lop-compact-guard")), "复位后低水位不应裁剪");
}

console.log("prefix-freeze contract: ALL PASS");
