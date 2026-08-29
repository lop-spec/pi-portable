// portable-adversary 单测:start → 等待 → consume,验证桥调用、判据输出与 block 语义。
// 用法:PI_PORTABLE_DATA=<含auth.json的目录> node tools/test-portable-adversary.mjs "<prompt>"
const m = await import("../src/chain/portable-adversary.mjs");
const ev = { session_id: "test-1", prompt: process.argv[2] || "" };
console.log("start:", JSON.stringify(m.startBackgroundReview(ev)));
await new Promise((r) => setTimeout(r, 9000));
const c = m.consumeBackgroundReview(ev);
console.log("consume:", c.status, c.reason || "");
if (c.body) console.log(c.body);
