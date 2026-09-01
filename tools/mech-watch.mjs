// 四机制(Best-of-N/auto-gate/S6 盲聚合/方案先行)实时观测。零依赖零常驻。
// 汇总:  node tools/mech-watch.mjs [--since 2026-09-01T08] [--log <lop-chain.log>]
// 跟随:  node tools/mech-watch.mjs -f     (Ctrl+C 退出;新事件逐行打印)
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const DEFAULT_LOG = process.env.PI_CHAIN_LOG ||
  [
    "C:/Users/lop/AppData/Local/pi-web/portable/data/lop-chain.log",
    path.join(process.env.PI_PORTABLE_DATA || "", "lop-chain.log"),
    "D:/Downloads/pi-protable/data/lop-chain.log",
  ].find((p) => p && fs.existsSync(p));
const LOG = opt("--log", DEFAULT_LOG);
const SINCE = opt("--since", new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 13));
const FOLLOW = args.includes("-f");

const MECH = /S6 (DELIVERED|BLOCK|pass|failed|MISSED)|AUTO_GATE|BESTOFN|PLAN_ROUND|PLAN_CAPTURED|GOAL_GATE (SET|PASS|RETRY|EXHAUSTED|CLEAR|LEDGER)|GOAL_REDIRECT/;
const BUCKETS = [
  ["S6 早投递(steer)", /S6 DELIVERED/],
  ["S6 打回(≥2/3 票)", /S6 BLOCK/],
  ["S6 放行", /S6 pass/],
  ["S6 fail-open", /S6 (failed|MISSED)/],
  ["auto-gate 装门", /AUTO_GATE INSTALL/],
  ["auto-gate 不可验证", /AUTO_GATE (empty|not-verifiable)/],
  ["auto-gate 候选被拒", /AUTO_GATE reject/],
  ["auto-gate 降级", /AUTO_GATE DEMOTE/],
  ["Best-of-N", /BESTOFN (START|PASS|FAIL)/],
  ["方案先行轮", /PLAN_ROUND|PLAN_CAPTURED/],
  ["目标门 SET/PASS/RETRY", /GOAL_GATE (SET|PASS|RETRY)/],
  ["换向器跳闸", /GOAL_REDIRECT (evidence|tabu)/],
];

if (!LOG || !fs.existsSync(LOG)) {
  console.error("找不到 lop-chain.log,用 --log 指定");
  process.exit(1);
}

if (FOLLOW) {
  console.log(`跟随 ${LOG} (四机制事件,Ctrl+C 退出)`);
  let offset = fs.statSync(LOG).size;
  let tailBuf = "";
  setInterval(() => {
    try {
      const size = fs.statSync(LOG).size;
      if (size < offset) offset = 0; // 轮转
      if (size === offset) return;
      const fd = fs.openSync(LOG, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      tailBuf += buf.toString("utf8");
      let nl;
      while ((nl = tailBuf.indexOf("\n")) >= 0) {
        const line = tailBuf.slice(0, nl);
        tailBuf = tailBuf.slice(nl + 1);
        if (MECH.test(line)) console.log(line.slice(0, 200));
      }
    } catch {}
  }, 1000);
} else {
  const lines = fs.readFileSync(LOG, "utf8").split("\n")
    .filter((line) => line.slice(1, 24) >= SINCE);
  console.log(`${LOG}\nsince ${SINCE} | 链日志 ${lines.length} 行`);
  for (const [label, re] of BUCKETS) {
    const hits = lines.filter((line) => re.test(line));
    if (hits.length) console.log(`  ${label}: ${hits.length}`);
  }
  const recent = lines.filter((line) => MECH.test(line)).slice(-10);
  console.log(`--- 最近 ${recent.length} 条 ---`);
  for (const line of recent) console.log(line.slice(0, 170));
}
