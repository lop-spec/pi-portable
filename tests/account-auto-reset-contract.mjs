import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAccountAutoReset, exhaustedWindows, selectResetCard } from "../src/bridge/account-auto-reset.mjs";
import { sendWithAccountFailover } from "../src/bridge/account-pool.mjs";
import { PiWebUiProxy } from "../src/piweb-ui-proxy.mjs";

const clock = Date.parse("2026-09-14T00:00:00Z");
const identity = { token: "secret-access-token", accountId: "account-1" };
const context = { id: "acct1", identity };
const usage = (full = true, seconds = 18000) => ({ rate_limit: { allowed: !full, limit_reached: full,
  primary_window: { used_percent: full ? 100 : 0, limit_window_seconds: seconds, reset_at: clock / 1000 + 18000 } } });
const credit = (id = "card-1", patch = {}) => ({ id, status: "available", is_supported_by_plan: true,
  reset_type: "codex_rate_limits", expires_at: new Date(clock + 86400000).toISOString(), ...patch });
const cards = (...credits) => ({ available_count: credits.filter(c => c.status === "available").length, credits });

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-reset-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = clock, consumed = false;
  const posts = [], logs = [];
  const base = { dataDir, now: () => time, log: line => logs.push(line),
    requestUsage: async () => usage(!consumed),
    requestCards: async () => cards(credit("card-1", { status: consumed ? "redeemed" : "available" })),
    consumeCard: async (auth, body) => { posts.push({ auth, body }); consumed = true; return { code: "reset" }; },
    ...options };
  const manager = createAccountAutoReset(base);
  return { manager, dataDir, posts, logs, base, advance: ms => { time += ms; }, setConsumed: value => { consumed = value; } };
}

test("exact plan/type/expiry eligibility; earliest-expiring card covers every exhausted window", () => {
  const w = exhaustedWindows(usage());
  assert.equal(selectResetCard(cards(credit()), w, clock).id, "card-1");
  for (const patch of [{ status: "redeemed" }, { is_supported_by_plan: false }, { is_supported_by_plan: undefined },
    { expires_at: null }, { expires_at: new Date(clock).toISOString() }, { reset_type: "unknown" }, { reset_type: "codex_weekly" }]) {
    assert.equal(selectResetCard(cards(credit("bad", patch)), w, clock), null);
  }
  assert.equal(selectResetCard({ credits: [credit()] }, w, clock), null, "unknown balance is not a usable count");
  assert.equal(selectResetCard({ available_count: 0, credits: [credit()] }, w, clock), null);
  assert.equal(selectResetCard(cards(credit("full"), credit("five", { reset_type: "codex_five_hour", expires_at: new Date(clock + 1000).toISOString() })), w, clock).id, "five");
  const both = [...w, ...exhaustedWindows(usage(true, 604800))];
  assert.equal(selectResetCard(cards(credit("five", { reset_type: "codex_five_hour" }), credit("full")), both, clock).id, "full");
});

test("generic 429, partial usage, unknown/reset-free windows never consume cards", async t => {
  for (const payload of [usage(false), {}, usage(true, 3600), { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } },
    { rate_limit: { ...usage().rate_limit, primary_window: { used_percent: 99, limit_window_seconds: 18000 } } }]) {
    const f = fixture(t, { requestUsage: async () => payload });
    assert.equal(await f.manager.tryReset(context), false);
    assert.equal(f.posts.length, 0);
    assert.match(f.logs.at(-1), /quota-not-exhausted/);
  }
});

test("concurrent aliases use exactly one existing card; durable state and public snapshot contain no token", async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.manager.tryReset({ ...context, id: `acct${i}` })));
  assert.ok(results.every(Boolean)); assert.equal(f.posts.length, 1);
  assert.deepEqual(Object.keys(f.posts[0].body).sort(), ["credit_id", "redeem_request_id"]);
  assert.match(f.posts[0].body.redeem_request_id, /^[0-9a-f-]{36}$/u);
  assert.equal(f.posts[0].auth.token, identity.token);
  const files = fs.readdirSync(path.join(f.dataDir, "account-auto-reset-state"));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, "account-auto-reset-state", files[0]), "utf8")).status, "verified");
  assert.doesNotMatch(JSON.stringify(f.manager.snapshot()) + f.logs.join() + fs.readFileSync(path.join(f.dataDir, "account-auto-reset-state", files[0]), "utf8"), /secret-access-token|account-1/);
  assert.equal(await f.manager.tryReset(context), false, "propagation cooldown prevents immediate second card");
});

test("POST timeout is durable across restart and never consumes another card; later reads reconcile", async t => {
  const posts = []; let resolved = false;
  const f = fixture(t, {
    requestUsage: async () => usage(!resolved),
    requestCards: async () => cards(credit("card-1", { status: resolved ? "redeemed" : "available" }), credit("card-2")),
    consumeCard: async (_, body) => { posts.push(body); throw new Error("token=do-not-log"); },
  });
  assert.equal(await f.manager.tryReset(context), false);
  assert.equal(f.manager.snapshot().accounts.acct1.status, "uncertain");
  f.advance(61000);
  const restarted = createAccountAutoReset(f.base);
  assert.equal(await restarted.tryReset(context), false);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1], "idempotent recovery reuses both card and UUID after restart");
  assert.doesNotMatch(f.logs.join(), /do-not-log/);
  resolved = true; f.advance(61000);
  assert.equal(await restarted.tryReset(context), true);
  assert.equal(posts.length, 2, "read reconciliation does not POST");
});

test("unknown consume response and stale post-reset usage stop; no blind replay", async t => {
  for (const code of ["future-code", "reset", "already_redeemed"]) {
    const f = fixture(t, { requestUsage: async () => usage(), consumeCard: async () => ({ code }) });
    assert.equal(await f.manager.tryReset(context), false);
    assert.equal(f.manager.snapshot().accounts.acct1.status, "uncertain");
  }
});

test("disabled configuration persists, backup failure preserves it; cancellation before POST spends nothing", async t => {
  const f = fixture(t, { backup: () => { throw new Error("backup unavailable"); } });
  assert.equal(f.manager.snapshot().enabled, true);
  f.manager.configure(false);
  assert.equal(await f.manager.tryReset(context), false);
  assert.equal(f.posts.length, 0);
  assert.throws(() => f.manager.configure(true), /backup unavailable/);
  assert.equal(createAccountAutoReset(f.base).snapshot().enabled, false);
  const cancelled = fixture(t);
  assert.equal(await cancelled.manager.tryReset({ ...context, isCancelled: () => true }), false);
  assert.equal(cancelled.posts.length, 0);
  let stop = false;
  const stopping = fixture(t, { requestCards: async () => { stop = true; return cards(credit()); } });
  assert.equal(await stopping.manager.tryReset({ ...context, isCancelled: () => stop }), false);
  assert.equal(stopping.posts.length, 0);
});

test("corrupt state/config and identity absence are visible and prevent spending", async t => {
  const f = fixture(t);
  assert.equal(await f.manager.tryReset({ ...context, identity: { token: "x" } }), false);
  fs.writeFileSync(path.join(f.dataDir, "account-auto-reset.json"), "bad-json");
  assert.equal(await f.manager.tryReset(context), false);
  assert.equal(f.manager.snapshot().settingsError, true);
  assert.equal(f.posts.length, 0);
  const badState = fixture(t);
  await badState.manager.tryReset(context);
  badState.advance(61000);
  const dir = path.join(badState.dataDir, "account-auto-reset-state");
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), "{}");
  assert.equal(await badState.manager.tryReset(context), false);
  assert.equal(badState.posts.length, 1);
  assert.match(badState.logs.at(-1), /failed/);
});

test("cross-process manager instance cannot consume a second card while first POST is in flight", async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { consumeCard: async () => { started(); await gate; return { code: "reset" }; } });
  const pending = f.manager.tryReset(context);
  await entered;
  const other = createAccountAutoReset(f.base);
  assert.equal(await other.tryReset(context), false);
  assert.match(f.logs.at(-1), /another-process-in-flight/);
  release(); await pending;
});

async function failover({ statuses, reset = async () => true, pin = false, statusCode = 429, errorBody = '{"error":{"type":"usage_limit_reached"}}' }) {
  const a = { id: "a" }, b = { id: "b" }, sent = [], failures = [], resets = [];
  const result = await sendWithAccountFailover({
    pool: { pick: async excluded => !excluded.has("a") ? a : pin ? { id: "a", pinnedUnavailable: true } : !excluded.has("b") ? b : null,
      onUpstreamFailure: async account => { failures.push(account.id); return "switch"; } },
    headers: {}, applyIdentity: (_, a) => ({ account: a.id }),
    send: async headers => { sent.push(headers.account); return { statusCode: statuses.shift() ?? statusCode, headers: {} }; },
    drain: async () => Buffer.from(errorBody), decode: raw => raw.toString(),
    onQuotaExhausted: async a => { resets.push(a.id); return reset(a); },
  });
  return { result, sent, failures, resets };
}

test("successful reset replays same identity once, without cooling or switching", async () => {
  const f = await failover({ statuses: [429, 200] });
  assert.deepEqual(f.sent, ["a", "a"]); assert.deepEqual(f.failures, []);
  assert.equal(f.result.attempts, 2);
});

test("repeated 429 is bounded; reset failures retain failover and pinned-account behavior; 401 bypasses reset", async () => {
  const repeated = await failover({ statuses: [429, 429, 200] });
  assert.deepEqual(repeated.sent, ["a", "a", "b"]); assert.deepEqual(repeated.resets, ["a"]);
  const failed = await failover({ statuses: [429, 200], reset: async () => { throw new Error("failed"); } });
  assert.deepEqual(failed.sent, ["a", "b"]);
  const pinned = await failover({ statuses: [429, 429], pin: true });
  assert.deepEqual(pinned.sent, ["a", "a"]); assert.ok(pinned.result.drained);
  const unauthorized = await failover({ statuses: [401, 200] });
  assert.deepEqual(unauthorized.resets, []);
  const generic = await failover({ statuses: [429, 200], errorBody: '{"error":{"type":"rate_limit_error"}}' });
  assert.deepEqual(generic.resets, []); assert.deepEqual(generic.sent, ["a", "b"]);
});

test("same-origin local configuration is forwarded without credentials; CSRF/non-JSON/remote hosts rejected", async t => {
  const f = fixture(t), calls = [];
  const proxy = new PiWebUiProxy({ dataRoot: f.dataDir, bridgePort: 18794,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, autoReset: { enabled: false } })); } });
  const run = async (extra = {}, value = false) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ enabled: value }))]);
    req.headers = { host: "127.0.0.1:30142", origin: "http://127.0.0.1:30142", "content-type": "application/json", ...extra };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await proxy.handleAccountAutoReset(req, res); return res;
  };
  assert.equal((await run()).status, 200);
  assert.equal(calls[0].url, "http://127.0.0.1:18794/account/auto-reset");
  assert.equal(calls[0].init.headers.authorization, undefined);
  for (const headers of [{ origin: "https://evil.test" }, { origin: undefined }, { host: "evil.test", origin: "http://evil.test" },
    { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }]) assert.notEqual((await run(headers)).status, 200);
  assert.equal((await run({}, "false")).status, 400);
  assert.equal(calls.length, 1);
});

test("real isolated bridge exposes configuration, rejects browser-origin writes, persists backup/readback", async t => {
  const f = fixture(t);
  const homes = path.join(f.dataDir, "empty-homes"); fs.mkdirSync(homes);
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/bridge/codex-responses-proxy.mjs", import.meta.url))], {
    env: { ...process.env, PI_PORTABLE_DATA: f.dataDir, CODEX_ACCOUNT_HOMES: homes, CODEX_PROXY_PORT: String(port),
      CODEX_UPSTREAM_PROXY_HOST: "127.0.0.1", CODEX_UPSTREAM_PROXY_PORT: "9", CODEX_EGRESS_FALLBACK_PORTS: "" }, windowsHide: true, stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  let spawnError; child.on("error", error => { spawnError = error; });
  t.after(async () => {
    if (child.exitCode === null) {
      await fetch(`${base}/admin/shutdown-if-idle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1500) }).catch(() => {});
      await new Promise(resolve => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => { child.kill(); resolve(); }, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    }
  });
  let health;
  for (let i = 0; i < 50; i++) {
    try { health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) })).json(); break; } catch {}
    if (spawnError || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(health?.autoReset?.enabled, true, `isolated bridge failed: ${spawnError?.message || child.exitCode}`);
  const post = (enabled, headers = {}) => fetch(`${base}/account/auto-reset`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(2000) });
  assert.equal((await post(false, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post(false, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post("false")).status, 400);
  assert.equal((await (await post(false)).json()).autoReset.enabled, false);
  assert.equal((await (await fetch(`${base}/account-usage`)).json()).autoReset.enabled, false);
  assert.equal((await (await post(true)).json()).autoReset.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, "account-auto-reset.json"), "utf8")).enabled, true);
});

test("UI offers localized confirmed switch and status, preserves the separate reset-card balance", () => {
  const ui = fs.readFileSync(new URL("../src/piweb-archive-ui.js", import.meta.url), "utf8");
  for (const label of ["Auto-use cards", "自动用卡", "自動用卡", "重置卡余额（不是当前可立即使用的次数）"]) assert.ok(ui.includes(label));
  assert.match(ui, /autoResetButton\.setAttribute\("role", "switch"\)/);
  assert.match(ui, /state\.data\.autoReset = body\.autoReset/);
  assert.match(ui, /state\.data\?\.autoReset\?\.accounts\?\.\[account\.id\]/);
  const bridge = fs.readFileSync(new URL("../src/bridge/codex-responses-proxy.mjs", import.meta.url), "utf8");
  assert.match(bridge, /onQuotaExhausted: async/);
  const resetGuard = bridge.indexOf("const resetCheckedAccounts = new Set()");
  assert.ok(resetGuard > 0 && resetGuard < bridge.indexOf("selected = await requestWithOverloadRetry"), "one reset check per identity must span all model retries");
  assert.match(bridge, /resetCheckedAccounts\.has\(account\.id\)/);
  assert.match(bridge, /identity-mismatch/);
  assert.match(bridge, /accountUsageMonitor\?\.refreshIfDue\(true\)/);
});
