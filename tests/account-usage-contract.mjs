#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACCOUNT_USAGE_FRESH_MS,
  ACCOUNT_USAGE_REFRESH_MS,
  createAccountUsageMonitor,
  identityFromAuthJson,
  parseAccountUsagePayload,
} from "../src/bridge/account-usage.mjs";

const b64u = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload) => `${b64u({ alg: "none" })}.${b64u(payload)}.sig`;

function temporaryMembers(nowMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-usage-"));
  const specs = [
    ["primary", "primary@example.com", false],
    ["acct2", "acct2@gmail.com", true],
  ];
  const members = specs.map(([id, email, writable]) => {
    const home = path.join(root, id);
    fs.mkdirSync(home, { recursive: true });
    const authPath = path.join(home, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      tokens: {
        id_token: jwt({ email }),
        access_token: jwt({ exp: Math.floor(nowMs / 1000) + 3600, "https://api.openai.com/profile": { email } }),
        account_id: `account-${id}`,
      },
    }));
    return { id, authPath, writable };
  });
  return { root, members };
}

test("identity and wham usage parsing expose only the requested compact fields", () => {
  const auth = {
    tokens: {
      id_token: jwt({ email: "person@gmail.com" }),
      access_token: jwt({ exp: 1_900_000_000 }),
      account_id: "account-1",
    },
  };
  assert.deepEqual(identityFromAuthJson(auth), {
    token: auth.tokens.access_token,
    accountId: "account-1",
    email: "person@gmail.com",
  });
  assert.deepEqual(parseAccountUsagePayload({
    plan_type: "pro",
    rate_limit: { allowed: true, primary_window: { used_percent: 9.2, resets_at: 1_788_748_110 } },
    rate_limit_reset_credits: { applicable_available_count: 0 },
  }), {
    usedPercent: 9,
    remainingPercent: 91,
    resetAt: "2026-09-07T02:28:30.000Z",
    resetCredits: 0,
    allowed: true,
    planType: "pro",
  });
});

test("monitor refreshes accounts in parallel, stays fresh for five minutes, and persists no credentials", async () => {
  let nowMs = 1_788_500_000_000;
  const fixture = temporaryMembers(nowMs);
  const cacheFile = path.join(fixture.root, "state", "account-usage-cache.json");
  const starts = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const monitor = createAccountUsageMonitor({
    members: () => fixture.members,
    accountState: () => fixture.members.map((member) => ({ id: member.id, active: member.id === "acct2" })),
    cacheFile,
    now: () => nowMs,
    requestUsage: async (_identity, member) => {
      starts.push(member.id);
      await gate;
      return {
        rate_limit: { allowed: true, primary_window: { used_percent: member.id === "acct2" ? 40 : 9, resets_at: Math.floor((nowMs + 86_400_000) / 1000) } },
        rate_limit_reset_credits: { available_count: member.id === "acct2" ? 2 : 0 },
      };
    },
  });

  const first = monitor.refresh("test");
  const same = monitor.refresh("deduplicated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.sort(), ["acct2", "primary"], "all account requests must start before either completes");
  release();
  await Promise.all([first, same]);

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.refreshIntervalMs, ACCOUNT_USAGE_REFRESH_MS);
  assert.equal(snapshot.accuracyMaxAgeMs, ACCOUNT_USAGE_FRESH_MS);
  assert.equal(snapshot.modelTokensConsumed, 0);
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(snapshot.accounts.find((account) => account.id === "primary").remainingPercent, 91);
  assert.equal(snapshot.accounts.find((account) => account.id === "acct2").resetCredits, 2);
  assert.equal(snapshot.accounts.find((account) => account.id === "acct2").active, true);
  assert.equal(snapshot.accounts.every((account) => account.stale === false), true);

  const cacheText = fs.readFileSync(cacheFile, "utf8");
  assert.doesNotMatch(cacheText, /access_token|account-primary|account-acct2|eyJ/iu);
  assert.match(cacheText, /acct2@gmail\.com/u);

  nowMs += ACCOUNT_USAGE_FRESH_MS + 1;
  assert.equal(monitor.snapshot().accounts.every((account) => account.stale === true), true);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("failed refresh keeps the last successful values, marks them stale, and always logs the failure", async () => {
  let nowMs = 1_788_500_000_000;
  const fixture = temporaryMembers(nowMs);
  const logs = [];
  let fail = false;
  const monitor = createAccountUsageMonitor({
    members: () => fixture.members,
    accountState: () => [],
    cacheFile: path.join(fixture.root, "usage.json"),
    now: () => nowMs,
    log: (line) => logs.push(line),
    requestUsage: async () => {
      if (fail) {
        const error = new Error("upstream rejected Bearer secret-value");
        error.statusCode = 503;
        throw error;
      }
      return { rate_limit: { primary_window: { used_percent: 25, resets_at: Math.floor((nowMs + 3600_000) / 1000) } } };
    },
  });
  await monitor.refresh("test");
  nowMs += ACCOUNT_USAGE_FRESH_MS + 1;
  fail = true;
  await monitor.refresh("test-failure");
  const accounts = monitor.snapshot().accounts;
  assert.equal(accounts.every((account) => account.remainingPercent === 75), true);
  assert.equal(accounts.every((account) => account.stale === true), true);
  assert.equal(accounts.every((account) => account.error === "HTTP 503"), true);
  assert.equal(logs.filter((line) => line.includes("账号额度刷新失败")).length, 2);
  assert.doesNotMatch(logs.join("\n"), /secret-value|eyJ/iu);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
