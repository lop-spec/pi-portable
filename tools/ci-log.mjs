// 拉取指定/最新 run 的失败步骤与日志片段。用法:node ci-log.mjs [runId]
import { execFileSync } from "node:child_process";

const REPO = "lop-spec/pi-portable";
const out = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
const tk = Object.fromEntries(out.trim().split("\n").map((l) => l.split("=", 2))).password;
const H = { Authorization: "Bearer " + tk, Accept: "application/vnd.github+json", "User-Agent": "pi-portable-ci" };

let runId = process.argv[2];
if (!runId) {
  const runs = await (await fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=1`, { headers: H })).json();
  runId = runs.workflow_runs[0].id;
  console.log(`run #${runs.workflow_runs[0].run_number} ${runs.workflow_runs[0].conclusion}`);
}
const jobs = await (await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${runId}/jobs`, { headers: H })).json();
for (const j of jobs.jobs || []) {
  console.log(`\nJOB ${j.name} => ${j.conclusion}`);
  for (const s of j.steps || []) console.log(`  ${s.conclusion === "failure" ? "✗" : s.conclusion === "success" ? "✓" : "·"} ${s.name}`);
  const failed = (j.steps || []).find((s) => s.conclusion === "failure");
  if (!failed) continue;
  const logRes = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${j.id}/logs`, { headers: H, redirect: "follow" });
  if (!logRes.ok) { console.log("  (日志不可读 " + logRes.status + ")"); continue; }
  const text = await logRes.text();
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(failed.name));
  const slice = lines.slice(Math.max(0, idx), idx + 60).filter((l) => l.trim());
  console.log("  --- 失败步骤日志 ---");
  console.log(slice.slice(-30).map((l) => "  " + l.replace(/^\S+\s/, "").slice(0, 200)).join("\n"));
}
