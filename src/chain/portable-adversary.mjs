// pi-portable 后台对抗预审 v2:三路正交独立审查 + 盲聚合 + 验证器投票。
// 文献依据:检测维度正交分工(CodeX-Verify +39.7pp)与信息不对称是真实多样性来源,
// 同模型单调用多 persona 是最弱形态(v1 基线实测 3 直白种子全误报 block);
// block 需 ≥2/3 路独立非空(验证器投票,Generative Verifiers 结论:验证器质量=系统天花板);
// 三路互不可见(盲),聚合为确定性规则,零附加 LLM 调用。
// 对外签名与 v1 完全兼容:start/claim/consume/acknowledge/shutdown。全程 fail-open。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const DATA = process.env.PI_PORTABLE_DATA || "";
const PORT = Number(process.env.PI_BRIDGE_PORT || 8794);
const MODEL = process.env.PI_ADVERSARY_MODEL || "gpt-5.6-sol";
const TIMEOUT_MS = Number(process.env.PI_ADVERSARY_TIMEOUT_MS || 30000);
// v2: 门槛 12→6。v1 基线实测「优化一下这个项目的性能」等 11 字高危请求全被挡掉,
// 短执行请求恰是 scope 风险最高的一类。
const MIN_CHARS = Number(process.env.PI_ADVERSARY_MIN_CHARS || 6);

export function authFilesFromModelConfigs(files, provider = "codex-bridge") {
  const result = [];
  for (const modelsFile of Array.isArray(files) ? files : []) {
    if (!modelsFile) continue;
    try {
      const config = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
      const node = config?.providers?.[provider];
      const values = [];
      const visit = (value) => {
        if (typeof value === "string") values.push(value);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      visit(node);
      for (const value of values) {
        const match = value.match(/readFileSync\(\s*(['"])([^'"]+?auth\.json)\1/iu);
        if (!match?.[2]) continue;
        const authFile = path.isAbsolute(match[2]) ? match[2] : path.resolve(path.dirname(modelsFile), match[2]);
        if (!result.includes(authFile)) result.push(authFile);
      }
    } catch { /* 无模型配置或非受支持命令时继续 */ }
  }
  return result;
}

export function bridgeAuthFromFiles(files) {
  for (const file of Array.isArray(files) ? files : []) {
    if (!file) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const token = j?.tokens?.access_token || "";
      const account = j?.tokens?.account_id || "";
      if (token) return { token, account, file };
    } catch { /* 继续尝试下一份现有凭证资产 */ }
  }
  return { token: "", account: "", file: "" };
}

function bridgeAuth() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || "";
  const modelFiles = [...new Set([
    DATA ? path.join(DATA, ".pi", "agent", "models.json") : "",
    agentDir ? path.join(agentDir, "models.json") : "",
    path.join(os.homedir(), ".pi", "agent", "models.json"),
  ].filter(Boolean))];
  const files = [...new Set([
    process.env.PI_ADVERSARY_AUTH_FILE || "",
    DATA ? path.join(DATA, "auth.json") : "",
    DATA ? path.join(DATA, ".pi", "agent", "auth.json") : "",
    agentDir ? path.join(agentDir, "auth.json") : "",
    ...authFilesFromModelConfigs(modelFiles),
    path.join(os.homedir(), ".pi", "agent", "auth.json"),
  ].filter(Boolean))];
  return bridgeAuthFromFiles(files);
}

// 通用单调用:SSE 调桥汇总 output_text。供本模块三路与 auto-gate 生成器复用。
// 超时/连接失败 resolve 失败对象,绝不抛出。cancelBox.cancel 可中途取消。
export function callBridgeText({ system, user, maxTokens = 600, timeoutMs = TIMEOUT_MS, cancelBox = {} }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { token, account } = bridgeAuth();
    const body = Buffer.from(JSON.stringify({
      model: MODEL,
      stream: true,
      store: false,
      instructions: String(system || ""),
      input: [{ role: "user", content: [{ type: "input_text", text: String(user || "").slice(0, 6000) }] }],
      reasoning: { effort: "max" },
      max_output_tokens: maxTokens,
    }), "utf8");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: "/v1/responses", method: "POST",
      headers: {
        "content-type": "application/json", "content-length": body.length,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(account ? { "chatgpt-account-id": account } : {}),
        originator: "pi_portable_adversary", "OpenAI-Beta": "responses=experimental",
      },
      timeout: timeoutMs,
    }, (res) => {
      let text = "";
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.type === "response.output_text.delta") text += j.delta || "";
            else if (j.type === "response.output_text.done" && !text) text = j.text || "";
          } catch { /* keepalive 等非 JSON 行 */ }
        }
      });
      res.on("end", () => {
        const s = String(text || "").trim();
        finish(s ? { ok: true, text: s, ms: Date.now() - t0 }
          : { ok: false, reason: `桥无输出(HTTP ${res.statusCode || "?"})`, ms: Date.now() - t0 });
      });
      res.on("error", () => finish({ ok: false, reason: "响应流中断", ms: Date.now() - t0 }));
    });
    cancelBox.cancel = () => {
      req.destroy();
      finish({ ok: false, canceled: true, reason: "已取消", ms: Date.now() - t0 });
    };
    req.on("timeout", () => { req.destroy(); finish({ ok: false, reason: `桥超时(${timeoutMs}ms)`, ms: Date.now() - t0 }); });
    req.on("error", (e) => finish({ ok: false, reason: "桥不可达:" + (e?.code || "ERR"), ms: Date.now() - t0 }));
    req.write(body); req.end();
  });
}

// ---- 三路正交视角(每路单视角独立调用,信息面互不相同) ----
const LANE_COMMON = [
  "判据:这条一旦发生,用户会说「不是这个意思」「这个我早说过了」「要用实测回答」。",
  "只输出 JSON:{\"finding\":\"<=45字\"}。不要任何解释、前言、markdown 代码块。",
  "硬约束:仅当你能指出**具体的、落在请求对象上**的失败面时才输出;泛泛的「可能没考虑周全」不算。",
  "大多数请求是直白的,finding 输出空字符串是正常且常见的结果——硬凑一条是错误行为,会让机制退化成噪声。",
].join("\n");

const LANES = [
  {
    key: "scope",
    system: "你是执行前预警器的【范围】视角。给你用户对 AI 编码助手的请求,只判断一件事:执行者最可能把范围做偏的一点——做大于所求、忽略请求里已给出的约束、答非所问、重做已存在的东西。\n" + LANE_COMMON,
  },
  {
    key: "cheaper",
    system: "你是执行前预警器的【现成资产】视角。结合工作目录线索,只判断一件事:这类请求是否很可能已有现成答案(既有文件/工具/用户认可过的旧版/官方默认),执行者最容易跳过检索自己从零造。\n" + LANE_COMMON,
  },
  {
    key: "evidence",
    system: "你是执行前预警器的【实证】视角。结合工作区状态,只判断一件事:执行者最可能不取运行态或实测证据、只凭静态内容或经验就下结论的一点。\n" + LANE_COMMON,
  },
];

function laneUser(key, prompt, extras) {
  const head = `用户请求:\n${String(prompt || "").slice(0, 4000)}`;
  if (key === "cheaper" && extras.listing) return `${head}\n\n工作目录文件(浅层):${extras.listing}`;
  if (key === "evidence" && extras.gitSummary) return `${head}\n\n工作区状态:\n${extras.gitSummary}`;
  return head;
}

export function parseLaneFinding(text) {
  const body = String(text || "").trim()
    .replace(/^```(?:json)?\s*/iu, "").replace(/```\s*$/u, "");
  try {
    const parsed = JSON.parse(body);
    return { ok: true, finding: String(parsed?.finding || "").trim().slice(0, 60) };
  } catch { return { ok: false, finding: "" }; }
}

// 信息型请求分类(确定性):纯查看/解释/列举且无改状态意图。此类请求打回一轮的
// 代价大于收益(v2 基线:D2「查看目录」/D3「解释构建」拿到 3/3 真发现仍属过度干预),
// block 降级为 warn——打回权只留给会改状态的执行型任务。
const INFO_HEAD = /(?:查看|看看|看一下|列出|列举|解释|说明|介绍|分析|对比|比较|统计|是什么|有哪些|有什么|为什么|怎么回事)/u;
const MUTATION_INTENT = /(?:修复|修好|修改|改成|改为|改掉|优化|部署|重构|写一?个?|新建|创建|删除|删掉|升级|安装|添加|加上|配置|迁移|重启|执行|运行|落地|实现|提交|推送|更新|处理|接入|清理|修正|调整|启用|禁用|开启|关闭)/u;

export function isInfoOnlyRequest(prompt) {
  const text = String(prompt || "").normalize("NFKC");
  return INFO_HEAD.test(text) && !MUTATION_INTENT.test(text);
}

// 盲聚合(确定性,零 LLM):≥2 路独立非空 → block;恰 1 路 → warn(投递不打回);
// 完成路 <2 → fail-open(不 block,验证面不足时不做有损干预)。
export function aggregateVotes(lanes) {
  const source = Array.isArray(lanes) ? lanes : [];
  const settled = source.filter((lane) => lane?.done && lane?.ok);
  const votes = settled.filter((lane) => String(lane.finding || "").trim());
  if (settled.length < 2) {
    return { decision: "fail-open", votes: votes.length, settled: settled.length };
  }
  if (votes.length >= 2) return { decision: "block", votes: votes.length, settled: settled.length };
  if (votes.length === 1) return { decision: "warn", votes: votes.length, settled: settled.length };
  return { decision: "pass", votes: 0, settled: settled.length };
}

const LANE_LABEL = { scope: "范围", cheaper: "现成资产", evidence: "实证" };

function render(job) {
  const agg = aggregateVotes(job.lanes);
  const ms = Math.max(0, ...job.lanes.map((lane) => Number(lane.ms || 0)));
  const rows = job.lanes.map((lane) => {
    const state = !lane.done ? "超时" : !lane.ok ? "失败" : String(lane.finding || "").trim() ? lane.finding : "∅";
    return `  · [${LANE_LABEL[lane.key] || lane.key}] ${state}`;
  }).join("\n");
  const head = agg.decision === "block"
    ? `⚠ ${agg.votes}/3 路独立指向风险,继续执行或收尾前显式核对:`
    : `提示(仅 ${agg.votes}/3 路,不构成打回):`;
  return `【后台对抗预审 v2 三路盲聚合 ${ms}ms｜votes ${agg.votes}/3】\n\n${head}\n${rows}`;
}

function topFinding(job) {
  const hit = job.lanes.find((lane) => lane.done && lane.ok && String(lane.finding || "").trim());
  return hit ? `[${LANE_LABEL[hit.key] || hit.key}] ${hit.finding}` : "";
}

function gitText(cwd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "-c", "core.quotepath=false", ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? "" : String(stdout || "")));
  });
}

async function gatherContext(cwd) {
  const extras = { listing: "", gitSummary: "" };
  if (!cwd || typeof cwd !== "string") return extras;
  try { extras.listing = fs.readdirSync(cwd).slice(0, 50).join(", "); } catch {}
  const status = await gitText(cwd, ["status", "--porcelain"]);
  if (status) {
    const stat = await gitText(cwd, ["diff", "--stat", "HEAD"]);
    extras.gitSummary = [
      status.split("\n").slice(0, 20).join("\n"),
      stat.split("\n").slice(-10).join("\n"),
    ].filter(Boolean).join("\n---\n").slice(0, 1500);
  } else {
    extras.gitSummary = "(非 git 仓或无改动)";
  }
  return extras;
}

const jobs = new Map(); // session_id -> job

export function startBackgroundReview(ev) {
  const prompt = String(ev?.prompt || "");
  const key = String(ev?.session_id || "");
  const cwd = String(ev?.cwd || "");
  // 合同测试/离线运行的显式关闭开关。2026-09-02 实录:lop-chain-contract 用 9 条真实 prompt
  // 驱动 before_agent_start,每条起 3 路真桥调用 → 一次测试 27 个上游请求,烧掉稀缺的
  // priority 额度。跳过原因经 phase.s6Start 落 chain-metrics,不静默。
  if (process.env.PI_ADVERSARY_DISABLE === "1") return { status: "skip", reason: "disabled:PI_ADVERSARY_DISABLE" };
  if (!key) return { status: "skip", reason: "事件里没有 session_id" };
  if (prompt.replace(/\s/g, "").length < MIN_CHARS) return { status: "skip", reason: "请求未达到后台预审门槛" };
  const job = {
    startedAt: Date.now(), done: false, delivered: false, acknowledged: false,
    infoOnly: isInfoOnlyRequest(prompt),
    lanes: LANES.map((lane) => ({ key: lane.key, done: false, ok: false, finding: "", ms: 0, cancelBox: {} })),
  };
  jobs.set(key, job);
  (async () => {
    const extras = await gatherContext(cwd).catch(() => ({ listing: "", gitSummary: "" }));
    await Promise.all(LANES.map(async (lane, index) => {
      const slot = job.lanes[index];
      const reply = await callBridgeText({
        system: lane.system,
        user: laneUser(lane.key, prompt, extras),
        maxTokens: 600, timeoutMs: TIMEOUT_MS, cancelBox: slot.cancelBox,
      });
      slot.ms = Number(reply?.ms || 0);
      if (reply?.ok) {
        const parsed = parseLaneFinding(reply.text);
        slot.ok = parsed.ok;
        slot.finding = parsed.finding;
      } else {
        slot.ok = false;
        slot.reason = reply?.reason || "";
      }
      slot.done = true;
    }));
    if (!job.acknowledged) job.done = true;
  })().catch(() => { job.done = true; });
  return { status: "started" };
}

export function acknowledgeBackgroundReview(ev) {
  const job = jobs.get(String(ev?.session_id || ""));
  if (!job) return { status: "skip", reason: "本轮没有后台审查任务" };
  job.delivered = true;
  job.acknowledged = true;
  job.acknowledgedReason = String(ev?.reason || "current-evidence").slice(0, 120);
  job.done = true;
  for (const lane of job.lanes) { try { lane.cancelBox.cancel?.(); } catch {} }
  return { status: "acknowledged", reason: job.acknowledgedReason };
}

function reviewSummary(job) {
  const agg = aggregateVotes(job.lanes);
  return {
    ok: true, kind: "preflight-v2", topMiss: topFinding(job),
    votes: agg.votes, settled: agg.settled, decision: agg.decision, infoOnly: job.infoOnly,
    lanes: job.lanes.map((lane) => ({ key: lane.key, ok: lane.ok, done: lane.done, finding: lane.finding, ms: lane.ms })),
    verdicts: job.lanes.filter((lane) => lane.done && lane.ok && String(lane.finding || "").trim())
      .map((lane) => ({ lens: lane.key, point: lane.finding, novel: true, blocking: false })),
    ms: Math.max(0, ...job.lanes.map((lane) => Number(lane.ms || 0))),
    provider: "pi-bridge", providerLabel: `桥 ${MODEL} 3路盲聚合`,
  };
}

export function claimBackgroundReview(ev) {
  const job = jobs.get(String(ev?.session_id || ""));
  if (!job) return { status: "skip", reason: "本轮没有后台审查任务" };
  if (!job.done) return { status: "failed", reason: "后台审查仍在运行,按 fail-open 放行", pending: true };
  if (job.acknowledged) return { status: "skip", reason: "已由确定性当前证据覆盖" };
  const agg = aggregateVotes(job.lanes);
  if (agg.decision === "fail-open") return { status: "failed", reason: `完成路不足(${agg.settled}/3),fail-open 放行` };
  if (agg.decision === "pass") return { status: "skip", reason: "预审 0/3 路无发现,不投递" };
  if (job.delivered) return { status: "skip", reason: "已投递" };
  job.delivered = true;
  return { status: "ready", context: render(job), review: reviewSummary(job) };
}

export function shutdownBackgroundReviews() {
  let canceled = 0;
  for (const job of jobs.values()) {
    for (const lane of job.lanes) { try { lane.cancelBox.cancel?.(); canceled += 1; } catch {} }
  }
  jobs.clear();
  return { canceled };
}

export function consumeBackgroundReview(ev) {
  const key = String(ev?.session_id || "");
  const job = jobs.get(key);
  if (!job) return { status: "skip", reason: "本轮没有后台审查任务" };
  if (!job.done) {
    for (const lane of job.lanes) { try { lane.cancelBox.cancel?.(); } catch {} }
    jobs.delete(key);
    return { status: "failed", reason: "后台审查仍在运行,已取消并按 fail-open 放行" };
  }
  jobs.delete(key);
  if (job.acknowledged) {
    return { status: "pass", reason: "已由确定性当前证据覆盖", review: { ok: true, topMiss: "", verdicts: [], providerLabel: "deterministic-current-evidence" } };
  }
  const review = reviewSummary(job);
  const agg = aggregateVotes(job.lanes);
  if (agg.decision === "fail-open") return { status: "failed", reason: `完成路不足(${agg.settled}/3),fail-open 放行`, review };
  if (job.delivered) return { status: "pass", reason: "后台预审已在执行阶段投递", review };
  if (agg.decision === "block" && job.infoOnly) {
    return { status: "pass", reason: `信息型请求 ${agg.votes}/3 路有发现,降级为提醒不打回`, review };
  }
  if (agg.decision === "block") {
    return {
      status: "block",
      reason: `后台预审 ${agg.votes}/3 路独立指向风险且尚未投递:` + String(review.topMiss).slice(0, 80),
      body: render(job),
      review,
    };
  }
  if (agg.decision === "warn") return { status: "pass", reason: `仅 ${agg.votes}/3 路有发现,不足以打回`, review };
  return { status: "pass", reason: "后台预审 0/3 路无发现", review };
}
