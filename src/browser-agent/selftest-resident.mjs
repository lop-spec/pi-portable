// 常驻与延迟自检:两阶段跨进程。
//   phase A(本进程):open → 记 pid/port → detach → 退出(浏览器应继续存活)
//   phase B(子进程):open → 期望 process-reconnect 且 port 相同 → text/eval/snapshot 各 N 次计时 → 按参数决定 close
// 用法:node selftest-resident.mjs [--keep]   (--keep 结束后不关浏览器,留作真正的常驻实例)
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserRuntime, RESIDENT } from "./runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.PI_PORTABLE_DATA || path.resolve(here, "..", "..", "..", "..");
const evidenceDir = path.join(dataRoot, "browser-agent", "evidence");
const testUrl = process.env.PI_BROWSER_SELFTEST_URL || "https://example.com/";
const rounds = Number(process.env.PI_BROWSER_SELFTEST_ROUNDS || 20);
const keep = process.argv.includes("--keep");
const phase = process.argv.includes("--phase-b") ? "B" : "A";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
async function timed(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}
async function alive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const runtime = new BrowserRuntime({ dataRoot });

if (phase === "A") {
  assert(RESIDENT, "PI_BROWSER_RESIDENT=0 时无法做常驻自检");
  await runtime.open(testUrl, { timeoutMs: 30_000 });
  const before = runtime.status();
  assert(before.running && before.port, "phase A: browser not running");
  const detach = await runtime.detach();
  assert(detach.detached, "phase A: detach failed");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert(await alive(before.port), `phase A: browser died after detach (port ${before.port})`);

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--phase-b", ...(keep ? ["--keep"] : [])], {
    env: { ...process.env, PI_BROWSER_EXPECT_PORT: String(before.port), PI_BROWSER_EXPECT_PID: String(before.pid ?? "") },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => out.push(chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  const text = Buffer.concat(out).toString("utf8");
  process.stdout.write(text);
  // 父进程退出后浏览器是否仍活着,是常驻的最终判据
  let stillAlive = await alive(before.port);
  if (!keep) {
    // 非常驻收尾:给浏览器最多 5s 退出时间再判定
    const deadline = Date.now() + 5000;
    while (stillAlive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      stillAlive = await alive(before.port);
    }
  }
  console.log(JSON.stringify({ phaseA: { pid: before.pid, port: before.port, aliveAfterChild: stillAlive, keep } }));
  if (code !== 0) process.exit(code);
  if (keep) assert(stillAlive, "browser was expected to stay resident with --keep");
  else assert(!stillAlive, "browser should have been closed by phase B");
  process.exit(0);
}

// phase B
const expectPort = Number(process.env.PI_BROWSER_EXPECT_PORT);
const logBefore = await fs.readFile(runtime.logFile, "utf8").catch(() => "");
const linesBefore = logBefore.split("\n").length;
await runtime.open(testUrl, { timeoutMs: 30_000 });
const status = runtime.status();
assert(status.running, "phase B: browser not running");
assert(status.port === expectPort, `phase B: port changed ${expectPort} -> ${status.port} (cold start instead of reconnect)`);
assert(status.pid === null, "phase B: pid should be null on reconnect (process not owned by this pi)");
const logAfter = await fs.readFile(runtime.logFile, "utf8");
const newRows = logAfter.split("\n").slice(linesBefore - 1).filter(Boolean).map((row) => JSON.parse(row));
assert(newRows.some((row) => row.event === "process-reconnect" && row.port === expectPort), "phase B: no process-reconnect log row");
assert(!newRows.some((row) => row.event === "process-start"), "phase B: unexpected process-start (cold start)");

const textMs = [];
const evalMs = [];
const snapshotMs = [];
for (let i = 0; i < rounds; i += 1) {
  textMs.push(await timed(() => runtime.text({ maxText: 5000 })));
  evalMs.push(await timed(() => runtime.evaluate("document.title")));
  snapshotMs.push(await timed(() => runtime.snapshot({ maxText: 2000 })));
}
const shotMs = await timed(() => runtime.screenshot({ timeoutMs: 15_000 }));
const evalResult = await runtime.evaluate("({ title: document.title, links: document.links.length })");
assert(evalResult.value && typeof evalResult.value.title === "string", "phase B: eval did not return JSON value");
const pageText = await runtime.text({ maxText: 5000 });
assert(pageText.total > 0 && pageText.text.length > 0, "phase B: text returned nothing");

const metrics = {
  url: testUrl,
  rounds,
  reconnect: { port: status.port, product: status.product },
  textMsMedian: +median(textMs).toFixed(2),
  evalMsMedian: +median(evalMs).toFixed(2),
  snapshotMsMedian: +median(snapshotMs).toFixed(2),
  textMsMax: +Math.max(...textMs).toFixed(1),
  evalMsMax: +Math.max(...evalMs).toFixed(1),
  snapshotMsMax: +Math.max(...snapshotMs).toFixed(1),
  screenshotMs: +shotMs.toFixed(1),
  evalSample: evalResult.value,
  textChars: pageText.total,
};
await fs.mkdir(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, `resident-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
await fs.writeFile(evidenceFile, JSON.stringify(metrics, null, 2), "utf8");
console.log(JSON.stringify({ phaseB: { ...metrics, evidenceFile } }));

if (keep) await runtime.detach();
else await runtime.close();
process.exit(0);
