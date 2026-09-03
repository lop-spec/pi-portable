// lop-swarm 自检:无 LLM 单测(默认) + 端到端(--e2e,需 8794 桥与 pi cli)。
// 用法: node src/lop-swarm/selftest.mjs [--e2e] [--workers 2] [--keep]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  validatePlan, createRun, claimNext, collectResult, collectVerdict, protectedViolations, renderTable,
  runSwarm, readStatus, applyRun, detectPiCli, readJson,
} from "./runtime.mjs";

const args = process.argv.slice(2);
const E2E = args.includes("--e2e");
const KEEP = args.includes("--keep");
const WORKERS = Number(args[args.indexOf("--workers") + 1]) || 2;
const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: String(error.message || error) }); console.log(`FAIL ${name}: ${String(error.message || error).slice(0, 300)}`); }
};
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lop-swarm-selftest-"));
const dataRoot = path.join(tmpRoot, "data");
const goodTask = (id) => ({ id, goal: `implement ${id} properly`, deliverable: `src/${id}.js`, verify: { cmd: `node tests/${id}.test.js` } });

// ---------- U1 契约校验 ----------
check("U1 缺 verify.cmd 拒收", () => {
  const r = validatePlan([{ id: "a", goal: "do something real", deliverable: "x", verify: { cmd: "  " } }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("verify.cmd 必填")));
  assert.equal(r.tasks.length, 0);
});
check("U1 重复 id / 非法 id 拒收", () => {
  const r = validatePlan([goodTask("a"), goodTask("a"), { ...goodTask("b"), id: "Bad ID" }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("id 重复")));
  assert.ok(r.errors.some((e) => e.includes("id 非法")));
});
check("U1 判据文件自动进保护列表", () => {
  const repo = path.join(tmpRoot, "plan-repo");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.writeFileSync(path.join(repo, "tests", "a.test.js"), "process.exit(0)");
  const r = validatePlan([goodTask("a")], { cwd: repo });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].protected, ["tests/a.test.js"]);
});

// ---------- U2 认领 ----------
check("U2 4 任务 2 槽认领各恰一次,并发 20 次零重复", () => {
  const plan = validatePlan(["t1", "t2", "t3", "t4"].map(goodTask));
  const { runDir } = createRun({ cwd: tmpRoot, tasks: plan.tasks, dataRoot });
  const claimed = [];
  const slots = ["w1", "w2"];
  for (let i = 0; i < 20; i += 1) {
    const c = claimNext(runDir, slots[i % 2]);
    if (c) claimed.push({ worker: slots[i % 2], id: c.task.id });
  }
  assert.equal(claimed.length, 4);
  assert.deepEqual(claimed.map((c) => c.id).sort(), ["t1", "t2", "t3", "t4"]);
  assert.equal(new Set(claimed.map((c) => c.worker)).size, 2);
  const log = fs.readFileSync(path.join(runDir, "claims.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 4);
  assert.equal(fs.readdirSync(path.join(runDir, "queue", "pending")).length, 0);
});

// ---------- U3 结果契约 ----------
check("U3 缺 result.json → missing-result;坏 JSON → invalid-result;id 不符 → invalid-result", () => {
  const dir = path.join(tmpRoot, "u3");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(collectResult({ id: "x" }, [path.join(dir, "none.json")]).reason, "missing-result");
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.equal(collectResult({ id: "x" }, [path.join(dir, "bad.json")]).reason, "invalid-result");
  fs.writeFileSync(path.join(dir, "wrong.json"), JSON.stringify({ id: "y", status: "done", summary: "s" }));
  assert.equal(collectResult({ id: "x" }, [path.join(dir, "wrong.json")]).reason, "invalid-result");
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ id: "x", status: "done", summary: "did it", files_changed: ["a.js"] }));
  const ok = collectResult({ id: "x" }, [path.join(dir, "missing.json"), path.join(dir, "ok.json")]);
  assert.equal(ok.ok, true);
  assert.equal(ok.result.summary, "did it");
  fs.writeFileSync(path.join(dir, "v.json"), JSON.stringify({ id: "x", verdict: "pass", reason: "fine" }));
  assert.equal(collectVerdict({ id: "x" }, [path.join(dir, "v.json")]).verdict.verdict, "pass");
  assert.equal(collectVerdict({ id: "x" }, [path.join(dir, "nope.json")]).reason, "verifier-missing-verdict");
});
check("U3 改保护文件 → protected-modified 判定", () => {
  assert.deepEqual(protectedViolations(["src/a.js", "tests\\a.test.js"], ["tests/a.test.js"]), ["tests/a.test.js"]);
  assert.deepEqual(protectedViolations(["src/a.js"], ["tests/a.test.js"]), []);
});

// ---------- U4 表格不含子代理文本 ----------
check("U4 renderTable 不含生产者/验证者对话文本", () => {
  const secret = "THIS_IS_WORKER_CHAT_TEXT_DO_NOT_LEAK";
  const summary = {
    runId: "r", runDir: "d", cwd: "c", isolation: "worktree", slots: 2, wallMs: 1000, counts: { done: 1, failed: 0, pending: 0 },
    tasks: [{ id: "a", status: "done", reason: "ok", verifyExit: 0, expectOk: null, verdict: "pass", verdictReason: "", diffLines: 3, changedFiles: ["x"], worker: "w1", usage: { input: 1, output: 2 }, lastAssistantText: secret, workerFinal: secret }],
  };
  const table = renderTable(summary);
  assert.ok(!table.includes(secret));
  assert.ok(table.includes("| a | done | ok |"));
});

// ---------- U5 静默:所有子进程启动带 windowsHide ----------
check("U5 runtime.mjs 全部 spawn/exec/execFile 带 windowsHide:true", () => {
  const src = fs.readFileSync(path.join(here, "runtime.mjs"), "utf8");
  const calls = (src.match(/\b(spawn|exec|execFile)\(/g) || []).length;
  const hidden = (src.match(/windowsHide: true/g) || []).length;
  assert.ok(calls >= 4, `calls=${calls}`);
  assert.ok(hidden >= calls, `hidden=${hidden} < calls=${calls}`);
  assert.ok(!src.includes("windowsHide: false"));
});

// ---------- E2E ----------
async function e2e() {
  const cli = detectPiCli();
  assert.ok(cli, "pi cli.js 未找到");
  const repo = path.join(tmpRoot, "e2e-repo");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  const specs = {
    add: { goal: "Create src/add.js (CommonJS) exporting function add(a, b) that returns a + b. Export as module.exports = { add }.", test: `const { add } = require("../src/add.js"); if (add(2, 3) !== 5 || add(-1, 1) !== 0) { console.error("FAIL add"); process.exit(1); } console.log("OK add");` },
    mul: { goal: "Create src/mul.js (CommonJS) exporting function mul(a, b) that returns a * b. Export as module.exports = { mul }.", test: `const { mul } = require("../src/mul.js"); if (mul(2, 3) !== 6 || mul(-1, 4) !== -4) { console.error("FAIL mul"); process.exit(1); } console.log("OK mul");` },
    rev: { goal: "Create src/rev.js (CommonJS) exporting function rev(s) that returns the string reversed. Export as module.exports = { rev }.", test: `const { rev } = require("../src/rev.js"); if (rev("abc") !== "cba" || rev("") !== "") { console.error("FAIL rev"); process.exit(1); } console.log("OK rev");` },
  };
  for (const [id, s] of Object.entries(specs)) fs.writeFileSync(path.join(repo, "tests", `${id}.test.js`), s.test + "\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# lop-swarm e2e demo\n");
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { windowsHide: true, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "swarm@local");
  g("config", "user.name", "swarm");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const tasks = Object.entries(specs).map(([id, s]) => ({ id, goal: s.goal, deliverable: `src/${id}.js`, verify: { cmd: `node tests/${id}.test.js`, expect: `OK ${id}` } }));
  const plan = validatePlan(tasks, { cwd: repo });
  assert.equal(plan.ok, true, plan.errors.join(";"));
  const { runId, runDir } = createRun({ cwd: repo, tasks: plan.tasks, dataRoot });
  console.log(`E2E run=${runId} dir=${runDir} cli=${cli}`);
  const t0 = Date.now();
  const summary = await runSwarm({ runDir, workers: WORKERS, verifier: "pi", keepWorktrees: KEEP, cli, onProgress: (l) => console.log(`  … ${l}`) });
  const table = renderTable(summary);
  console.log(table);
  const wallMs = Date.now() - t0;

  check("E2E 全部任务 done", () => {
    assert.equal(summary.counts.done, 3, JSON.stringify(summary.tasks.map((t) => [t.id, t.status, t.reason, t.error || ""])));
  });
  check("E2E claims.log 每 id 恰一次且两 worker 都认领过", () => {
    const rows = fs.readFileSync(path.join(runDir, "claims.log"), "utf8").trim().split("\n").map((l) => l.split("\t"));
    assert.deepEqual(rows.map((r) => r[2]).sort(), ["add", "mul", "rev"]);
    if (WORKERS >= 2) assert.equal(new Set(rows.map((r) => r[1])).size, 2, "两个 worker 未都认领");
  });
  check("E2E 三份 verdict.json 且 verifier 输入不含 worker 最终文本", () => {
    for (const id of ["add", "mul", "rev"]) {
      const out = path.join(runDir, "out", id);
      assert.ok(fs.existsSync(path.join(out, "verdict.json")), `${id} 无 verdict.json`);
      const input = fs.readFileSync(path.join(out, "verifier-input.md"), "utf8");
      const workerFinal = fs.readFileSync(path.join(out, "worker-final.txt"), "utf8").trim();
      const sentence = workerFinal.split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 24)[0];
      if (sentence) assert.ok(!input.includes(sentence), `${id} verifier 输入泄漏 worker 文本`);
      assert.ok(!input.includes("worker.log"));
    }
  });
  check("E2E 主链回收表 < 2KB 且不含 worker 最终文本", () => {
    assert.ok(Buffer.byteLength(table, "utf8") < 2048, `table bytes=${Buffer.byteLength(table, "utf8")}`);
    for (const id of ["add", "mul", "rev"]) {
      const workerFinal = fs.readFileSync(path.join(runDir, "out", id, "worker-final.txt"), "utf8").trim();
      const sentence = workerFinal.split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 24)[0];
      if (sentence) assert.ok(!table.includes(sentence));
    }
  });
  const applied = await applyRun({ runDir });
  check("E2E swarm_apply 三补丁应用到主 cwd 且复验通过", () => {
    assert.equal(applied.rows.filter((r) => r.applied && r.verifyExit === 0).length, 3, JSON.stringify(applied.rows));
  });
  const status = readStatus(runDir);
  const metrics = {
    runId, wallMs, workers: WORKERS, tableBytes: Buffer.byteLength(table, "utf8"),
    perTask: status.tasks.map((t) => ({ id: t.id, status: t.status, reason: t.reason, durationMs: t.durationMs, worker: t.worker, tokens: t.usage, verifierTokens: t.verifierUsage, model: t.model })),
  };
  console.log("E2E_METRICS " + JSON.stringify(metrics));
  fs.writeFileSync(path.join(runDir, "e2e-metrics.json"), JSON.stringify(metrics, null, 2));
}

if (E2E) await e2e();

const failed = results.filter((r) => !r.ok);
console.log(`SUMMARY ${results.length - failed.length}/${results.length} passed; tmp=${tmpRoot}${KEEP ? " (kept)" : ""}`);
if (!KEEP && !E2E) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
process.exit(failed.length ? 1 : 0);
