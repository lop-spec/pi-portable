// pi-portable 后台对抗预审:与本机 adversary-worker.mjs 同签名(start/claim/consume),
// 但为便携环境重实现:进程内内存态(单 pi 进程自产自销,无子进程、无状态文件),
// provider 走包内 8794 桥(openai-responses SSE),凭证取数据根 auth.json。全程 fail-open。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const DATA = process.env.PI_PORTABLE_DATA || "";
const PORT = Number(process.env.PI_BRIDGE_PORT || 8794);
const MODEL = process.env.PI_ADVERSARY_MODEL || "gpt-5.6-sol";
const TIMEOUT_MS = Number(process.env.PI_ADVERSARY_TIMEOUT_MS || 30000);
const MIN_CHARS = 12;

// 判据与本机 SYSTEM_PREFLIGHT 同源(rule-enforcer/adversary.mjs),保持双机行为一致。
const SYSTEM_PREFLIGHT =
  "你是执行前的预警器。给你一个用户对 AI 编码助手提出的请求," +
  "从三个互相独立的视角,各指出**执行者最可能做错或做偏**的一条:\n" +
  "1) scope — 做偏:把范围做大于所求、忽略请求里已给出的约束、答非所问、重做已存在的东西\n" +
  "2) cheaper — 造轮子:这类请求往往已有现成答案(用户认可过的旧版、官方文档与默认值、" +
  "本机既有资产),执行者最容易跳过检索自己从零造\n" +
  "3) evidence — 凭印象:不取运行态或实测证据,只看静态内容或凭经验就下结论\n" +
  "判据:这条一旦发生,用户会说「不是这个意思」「这个我早说过了」「难道没有现成的吗」「要用实测回答」。\n" +
  "不索取更多信息,不给方案,不复述请求,不做道德提醒。\n" +
  "硬性输出约束(违反即无效):traps 恰好 3 个元素,三视角各一条,point ≤30 字," +
  "必须落到请求里的具体对象上,压字数不等于写空话;不要任何解释、前言、markdown 代码块。\n" +
  '只输出 JSON:{"traps":[{"lens":"scope|cheaper|evidence","point":"<=30字"}],' +
  '"top":"<=45字,三条里最可能真实发生的那一条。**没有值得提醒的就填空字符串**——' +
  '大多数请求都是直白的,硬凑一条出来是错误行为,会让这个机制退化成噪声"}';

const jobs = new Map(); // session_id -> { startedAt, done, result, delivered }

function bridgeAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, "auth.json"), "utf8"));
    return { token: j?.tokens?.access_token || "", account: j?.tokens?.account_id || "" };
  } catch { return { token: "", account: "" }; }
}

// SSE 调桥,汇总 output_text;超时/连接失败 resolve 失败对象,绝不抛出。
function callBridge(prompt, job) {
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
      instructions: SYSTEM_PREFLIGHT,
      input: [{ role: "user", content: [{ type: "input_text", text: String(prompt).slice(0, 4000) }] }],
      reasoning: { effort: "max" },
      max_output_tokens: 1200,
    }), "utf8");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: "/v1/responses", method: "POST",
      headers: {
        "content-type": "application/json", "content-length": body.length,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(account ? { "chatgpt-account-id": account } : {}),
        originator: "pi_portable_adversary", "OpenAI-Beta": "responses=experimental",
      },
      timeout: TIMEOUT_MS,
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
      res.on("end", () => finish(parseReview(text, t0, res.statusCode)));
      res.on("error", () => finish({ ok: false, reason: "响应流中断" }));
    });
    req.on("socket", (socket) => { job.socket = socket; });
    job.cancel = () => {
      try { job.socket?.unref?.(); } catch {}
      req.destroy();
      finish({ ok: false, canceled: true, reason: "已由确定性当前证据覆盖" });
    };
    req.on("timeout", () => { req.destroy(); finish({ ok: false, reason: `桥超时(${TIMEOUT_MS}ms)` }); });
    req.on("error", (e) => finish({ ok: false, reason: "桥不可达:" + (e?.code || "ERR") }));
    req.write(body); req.end();
  });
}

function parseReview(text, t0, status) {
  const s = String(text || "").trim();
  if (!s) return { ok: false, reason: `桥无输出(HTTP ${status || "?"})` };
  try {
    const j = JSON.parse(s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
    const verdicts = (Array.isArray(j.traps) ? j.traps : []).slice(0, 3).map((t) => ({
      lens: String(t?.lens || "review"), point: String(t?.point || "").slice(0, 50), novel: true, blocking: false,
    }));
    return {
      ok: true, kind: "preflight", topMiss: String(j.top || "").slice(0, 80), verdicts,
      ms: Date.now() - t0, provider: "pi-bridge", providerLabel: `桥 ${MODEL} max`,
    };
  } catch { return { ok: false, reason: "审查输出不是合法 JSON" }; }
}

function render(result) {
  const details = (result.verdicts || []).map((v) => "  · [" + v.lens + "] " + v.point).filter(Boolean).join("\n");
  return "【后台对抗预审 " + (result.ms || 0) + "ms｜" + (result.providerLabel || "pi-bridge") + "】\n\n  ⚠ "
    + String(result.topMiss || "未给出首要风险") + (details ? "\n\n" + details : "")
    + "\n\n请在继续执行或收尾前显式核对这些失败面。";
}

export function startBackgroundReview(ev) {
  const prompt = String(ev?.prompt || "");
  const key = String(ev?.session_id || "");
  if (!key) return { status: "skip", reason: "事件里没有 session_id" };
  if (prompt.replace(/\s/g, "").length < MIN_CHARS) return { status: "skip", reason: "请求未达到后台预审门槛" };
  const job = { startedAt: Date.now(), done: false, result: null, delivered: false, cancel: null };
  jobs.set(key, job);
  callBridge(prompt, job)
    .then((r) => {
      if (job.acknowledged) return;
      job.result = r; job.done = true;
    })
    .catch((e) => {
      if (job.acknowledged) return;
      job.result = { ok: false, reason: String(e).slice(0, 120) }; job.done = true;
    });
  return { status: "started" };
}

export function acknowledgeBackgroundReview(ev) {
  const job = jobs.get(String(ev?.session_id || ""));
  if (!job) return { status: "skip", reason: "本轮没有后台审查任务" };
  job.delivered = true;
  job.acknowledged = true;
  job.acknowledgedReason = String(ev?.reason || "current-evidence").slice(0, 120);
  job.result = { ok: true, topMiss: "", verdicts: [], providerLabel: "deterministic-current-evidence" };
  job.done = true;
  try { job.cancel?.(); } catch {}
  return { status: "acknowledged", reason: job.acknowledgedReason };
}

export function claimBackgroundReview(ev) {
  const job = jobs.get(String(ev?.session_id || ""));
  if (!job) return { status: "skip", reason: "本轮没有后台审查任务" };
  if (!job.done) return { status: "failed", reason: "后台审查仍在运行,按 fail-open 放行", pending: true };
  if (!job.result?.ok) return { status: "failed", reason: job.result?.reason || "后台审查没有有效结果" };
  if (!String(job.result.topMiss || "").trim()) return { status: "skip", reason: "预审无首要遗漏,不投递" };
  if (job.delivered) return { status: "skip", reason: "已投递" };
  job.delivered = true;
  return { status: "ready", context: render(job.result), review: job.result };
}

export function shutdownBackgroundReviews() {
  let canceled = 0;
  for (const job of jobs.values()) {
    try { job.cancel?.(); canceled += 1; } catch {}
  }
  jobs.clear();
  return { canceled };
}

export function consumeBackgroundReview(ev) {
  const key = String(ev?.session_id || "");
  const job = jobs.get(key);
  if (!job) return { status: "skip", reason: "本轮没有后台审查任务" };
  if (!job.done) {
    try { job.cancel?.(); } catch {}
    jobs.delete(key);
    return { status: "failed", reason: "后台审查仍在运行,已取消并按 fail-open 放行" };
  }
  const result = job.result;
  jobs.delete(key);
  if (!result?.ok) return { status: "failed", reason: result?.reason || "后台审查没有有效结果" };
  if (job.delivered) return { status: "pass", reason: "后台预审已在执行阶段投递", review: result };
  if (!String(result.topMiss || "").trim()) return { status: "pass", reason: "后台预审未发现首要遗漏", review: result };
  return {
    status: "block",
    reason: "后台预审尚未投递:" + String(result.topMiss).slice(0, 80),
    body: render(result),
    review: result,
  };
}
