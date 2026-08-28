// 查 GitHub Actions 运行状态(用 GCM 凭证)。用法:node ci-status.mjs [--watch]
import { execFileSync } from "node:child_process";

const REPO = "lop-spec/pi-portable";
const WATCH = process.argv.includes("--watch");

function token() {
  const out = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split("=", 2))).password;
}
const tk = token();
async function api(p) {
  const r = await fetch("https://api.github.com" + p, {
    headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github+json", "User-Agent": "pi-portable-ci" },
  });
  return r.json();
}

async function once() {
  const runs = await api(`/repos/${REPO}/actions/runs?per_page=3`);
  if (!runs.workflow_runs?.length) { console.log("(无运行记录)"); return null; }
  const r = runs.workflow_runs[0];
  console.log(`#${r.run_number} ${r.head_branch || r.head_sha?.slice(0, 7)} status=${r.status} conclusion=${r.conclusion || "-"} ${r.html_url}`);
  if (r.status === "completed" && r.conclusion !== "success") {
    const jobs = await api(`/repos/${REPO}/actions/runs/${r.id}/jobs`);
    for (const j of jobs.jobs || []) {
      for (const s of j.steps || []) {
        if (s.conclusion === "failure") console.log(`  FAILED STEP: ${s.name}`);
      }
    }
    const logUrl = `/repos/${REPO}/actions/runs/${r.id}/logs`;
    const logRes = await fetch("https://api.github.com" + logUrl, {
      headers: { Authorization: "Bearer " + tk, "User-Agent": "pi-portable-ci" }, redirect: "follow",
    });
    if (logRes.ok) {
      const buf = Buffer.from(await logRes.arrayBuffer());
      // zip 里找错误行(粗暴但有效:搜可打印片段)
      const text = buf.toString("latin1");
      const errors = text.split(/[\r\n]+/).filter((l) => /error|Error|失败|throw|not found|未/.test(l) && l.length < 300).slice(-12);
      if (errors.length) console.log("  --- 日志尾部错误线索 ---\n" + errors.map((e) => "  " + e.replace(/[^\x20-\x7e一-鿿]/g, "")).join("\n"));
    }
  }
  return r;
}

if (WATCH) {
  for (let i = 0; i < 60; i++) {
    const r = await once();
    if (r?.status === "completed") break;
    await new Promise((res) => setTimeout(res, 15000));
  }
} else await once();
