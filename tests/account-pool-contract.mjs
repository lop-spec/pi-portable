// 账号池合同测试：冷却期解析、sticky 选择顺序、429/401 处置、failover 环重发语义。
// 全部用临时 homes 与注入的假传输驱动，不碰真实凭据、不出网。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAccountPool,
  jwtExpiryMs,
  parseCooldownUntilMs,
  sendWithAccountFailover,
} from "../src/bridge/account-pool.mjs";

const b64u = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (expSec, sub = "x") => `${b64u({ alg: "none" })}.${b64u({ exp: expSec, sub })}.sig`;

const NOW = 1_756_700_000_000; // 固定时钟：所有相对期限断言都确定。
const FRESH_EXP_SEC = Math.floor(NOW / 1000) + 30 * 86_400;

function makeHomes(ids = ["primary", "acct2", "acct3"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-homes-"));
  for (const id of ids) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "auth.json"), JSON.stringify({
      tokens: { access_token: fakeJwt(FRESH_EXP_SEC, id), account_id: `acc-${id}`, refresh_token: `rt-${id}` },
    }), "utf8");
  }
  return root;
}

function makePool(root, overrides = {}) {
  return createAccountPool({
    homesRoot: root,
    poolStateFile: path.join(root, "state", "account-pool.json"),
    pinStateFile: path.join(root, "account-pool-pin.json"),
    connect: () => { throw new Error("测试不出网"); },
    refreshTransport: async () => { throw new Error("测试默认不刷新"); },
    now: () => NOW,
    ...overrides,
  });
}

test("jwtExpiryMs 解析 exp；坏 token 返回 null", () => {
  assert.equal(jwtExpiryMs(fakeJwt(1_800_000_000)), 1_800_000_000_000);
  assert.equal(jwtExpiryMs("not-a-jwt"), null);
});

test("429 冷却期：真实 usage_limit_reached 响应体的 resets_in_seconds 被 6 小时上限截断", () => {
  const body = '{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1788748110,"eligible_promo":null,"resets_in_seconds":511593}';
  const until = parseCooldownUntilMs(429, body, {}, NOW);
  assert.equal(until, NOW + 6 * 60 * 60_000);
});

test("429 冷却期：Retry-After 头优先；缺信息回落默认 30 分钟；401 固定 15 分钟", () => {
  assert.equal(parseCooldownUntilMs(429, "", { "retry-after": "120" }, NOW), NOW + 120_000);
  assert.equal(parseCooldownUntilMs(429, "no numbers here", {}, NOW), NOW + 30 * 60_000);
  assert.equal(parseCooldownUntilMs(401, "", {}, NOW), NOW + 15 * 60_000);
});

test("sticky 选择：备用账号先消耗（acct2 首选），primary 永远垫底且 useDownstream", async () => {
  const root = makeHomes();
  const pool = makePool(root);
  const first = await pool.pick(new Set());
  assert.equal(first.id, "acct2");
  assert.equal(first.useDownstream, false);
  assert.equal(first.accountId, "acc-acct2");
  // sticky：再挑仍是 acct2。
  assert.equal((await pool.pick(new Set())).id, "acct2");
  // 排除 acct2 → acct3；再排除 → primary（下游身份）。
  assert.equal((await pool.pick(new Set(["acct2"]))).id, "acct3");
  const last = await pool.pick(new Set(["acct2", "acct3"]));
  assert.equal(last.id, "primary");
  assert.equal(last.useDownstream, true);
});

test("onUpstreamFailure：429→冷却+switch；池内 401 刷新成功→retry；primary 401→give-up", async () => {
  const root = makeHomes();
  let refreshCalls = 0;
  const pool = makePool(root, {
    refreshTransport: async () => { refreshCalls += 1; return { access_token: fakeJwt(FRESH_EXP_SEC + 86_400) }; },
  });
  const acct2 = await pool.pick(new Set());
  assert.equal(await pool.onUpstreamFailure(acct2, 429, "", {}), "switch");
  assert.equal(pool.snapshot().find((m) => m.id === "acct2").cooldownMinLeft, 30);
  // 冷却后重挑绕开 acct2。
  assert.equal((await pool.pick(new Set())).id, "acct3");
  const acct3 = await pool.pick(new Set());
  assert.equal(await pool.onUpstreamFailure(acct3, 401, "", {}), "retry");
  assert.equal(refreshCalls, 1);
  assert.equal(await pool.onUpstreamFailure({ id: "primary", useDownstream: true }, 401, "", {}), "give-up");
  assert.equal(await pool.onUpstreamFailure(acct3, 500, "", {}), "give-up");
});

test("池状态跨实例持久化：冷却表落盘后新实例仍然生效", async () => {
  const root = makeHomes();
  const pool = makePool(root);
  await pool.onUpstreamFailure(await pool.pick(new Set()), 429, "", {});
  const rebooted = makePool(root);
  assert.equal((await rebooted.pick(new Set())).id, "acct3");
});

test("pin 模式：锁定账号不可用时显式报错，不回落消耗 primary", async () => {
  const root = makeHomes();
  fs.writeFileSync(path.join(root, "account-pool-pin.json"), JSON.stringify({ autoRotate: false, account: "acct2" }), "utf8");
  const pool = makePool(root);
  assert.equal((await pool.pick(new Set())).id, "acct2");
  await pool.onUpstreamFailure(await pool.pick(new Set()), 429, "", {});
  const pinned = await pool.pick(new Set());
  assert.equal(pinned.pinnedUnavailable, true);
  assert.equal(pinned.id, "acct2");
});

// —— failover 环 —— //

const applyIdentity = (headers, account) => {
  if (!account || account.useDownstream) return headers;
  return { ...headers, authorization: `Bearer ${account.token}` };
};
const drain = async (response) => Buffer.from(response.body || "", "utf8");
const decode = (raw) => raw.toString("utf8");

test("failover 环：首账号 429 → 切号重发 → 下游只见 200", async () => {
  const root = makeHomes();
  const pool = makePool(root);
  const sent = [];
  const send = async (headers) => {
    sent.push(headers.authorization);
    return sent.length === 1
      ? { statusCode: 429, headers: {}, body: '{"type":"usage_limit_reached","resets_in_seconds":511593}' }
      : { statusCode: 200, headers: {} };
  };
  const outcome = await sendWithAccountFailover({ pool, headers: { authorization: "Bearer downstream" }, send, applyIdentity, drain, decode });
  assert.equal(outcome.response.statusCode, 200);
  assert.equal(outcome.drained, null);
  assert.equal(outcome.account.id, "acct3");
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]); // 重发换了身份头
  assert.equal(pool.snapshot().find((m) => m.id === "acct2").cooldownMinLeft > 0, true);
});

test("failover 环：全池 429 → 每账号只试一次，返回最终 429 与 drained 文本", async () => {
  const root = makeHomes();
  const pool = makePool(root);
  let calls = 0;
  const send = async () => { calls += 1; return { statusCode: 429, headers: {}, body: '{"type":"usage_limit_reached"}' }; };
  const outcome = await sendWithAccountFailover({ pool, headers: { authorization: "Bearer downstream" }, send, applyIdentity, drain, decode });
  assert.equal(outcome.response.statusCode, 429);
  assert.equal(calls, 3); // acct2 → acct3 → primary，各一次
  assert.match(outcome.drained.text, /usage_limit_reached/);
});

test("failover 环：无池时单次透传，身份头原样", async () => {
  const sent = [];
  const send = async (headers) => { sent.push(headers); return { statusCode: 200, headers: {} }; };
  const outcome = await sendWithAccountFailover({ pool: null, headers: { authorization: "Bearer downstream" }, send, applyIdentity, drain, decode });
  assert.equal(outcome.response.statusCode, 200);
  assert.deepEqual(sent, [{ authorization: "Bearer downstream" }]);
});

test("failover 环：primary 401 give-up 原样返回（客户端自己走重新登录）", async () => {
  const root = makeHomes(["primary"]); // 池里只有 primary
  const pool = makePool(root);
  const send = async () => ({ statusCode: 401, headers: {}, body: "unauthorized" });
  const outcome = await sendWithAccountFailover({ pool, headers: { authorization: "Bearer downstream" }, send, applyIdentity, drain, decode });
  assert.equal(outcome.response.statusCode, 401);
  assert.equal(outcome.account.useDownstream, true);
  assert.equal(outcome.drained.text, "unauthorized");
});
