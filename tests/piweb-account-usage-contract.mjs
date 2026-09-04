#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PIWEB_ACCOUNT_USAGE_PATH, RunSupervisor } from "../src/run-supervisor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiSource = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");
const quotaUi = uiSource.slice(uiSource.indexOf('const VERSION = "piweb-account-usage-v1"'));
const bridgeSource = fs.readFileSync(path.join(root, "src", "bridge", "codex-responses-proxy.mjs"), "utf8");

function responseCollector() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body); },
  };
}

test("quota control is compact, cached, keyboard accessible, and opens on pointerdown", () => {
  assert.match(quotaUi, /const ENDPOINT = "\/__pi_account_usage"/u);
  assert.match(quotaUi, /const BROWSER_REFRESH_MS = 60_000/u);
  assert.match(quotaUi, /button\.addEventListener\("pointerdown"/u, "physical presses must render from browser memory immediately");
  assert.match(quotaUi, /dataset\.piAccountUsageOpenLatencyMs/u, "live UI must expose measured open latency");
  assert.match(quotaUi, /aria-haspopup", "dialog/u);
  assert.match(quotaUi, /aria-expanded/u);
  assert.match(quotaUi, /event\.key !== "Escape"/u);
  assert.match(quotaUi, /prefers-reduced-motion/u);
  assert.match(quotaUi, /width:352px/u);
  assert.match(quotaUi, /remaining: "剩余"/u);
  assert.match(quotaUi, /resets: "重置次数"/u);
  assert.match(quotaUi, /resetAt: "重置时间"/u);
  assert.match(quotaUi, /account\.email/u);
  assert.match(quotaUi, /console\.error\("\[pi-web account usage\] refresh failed:/u, "refresh degradation must never be silent");
  assert.doesNotMatch(quotaUi, /\/v1\/responses|\/api\/agent/u, "quota UI must never invoke a model path");
});

test("bridge account usage endpoint uses the cached monitor and stays outside bearer auth", () => {
  const usageAt = bridgeSource.indexOf('if (url === "/account-usage"');
  const bearerAt = bridgeSource.indexOf("const bearer =");
  assert.ok(usageAt > 0 && bearerAt > usageAt, "local quota endpoint must be reachable without sending credentials to the browser");
  assert.match(bridgeSource, /\/backend-api\/wham\/usage/u);
  assert.match(bridgeSource, /account-usage-cache\.json/u);
  assert.match(bridgeSource, /accountUsageMonitor\.start\(\)/u);
  assert.match(bridgeSource, /账号额度接口失败/u);
});

test("supervisor proxies a sanitized same-origin snapshot from the loopback bridge", async () => {
  assert.equal(PIWEB_ACCOUNT_USAGE_PATH, "/__pi_account_usage");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-proxy-"));
  const calls = [];
  const supervisor = new RunSupervisor({
    dataRoot: temporary,
    bridgePort: 18794,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        ok: true,
        enabled: true,
        modelTokensConsumed: 0,
        accounts: [{ id: "acct2", email: "acct2@gmail.com", remainingPercent: 91 }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = responseCollector();
  await supervisor.handleAccountUsageProxy(response, new URL("http://127.0.0.1/__pi_account_usage?refresh=1"));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["http://127.0.0.1:18794/account-usage?refresh=1"]);
  const body = JSON.parse(response.body);
  assert.equal(body.modelTokensConsumed, 0);
  assert.equal(body.accounts[0].email, "acct2@gmail.com");
  assert.equal(response.headers["cache-control"], "no-store");
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("supervisor quota proxy failure is visible to both the UI and the log", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-error-"));
  const logFile = path.join(temporary, "supervisor.log");
  const supervisor = new RunSupervisor({
    dataRoot: temporary,
    logFile,
    fetchImpl: async () => { throw new Error("bridge unavailable"); },
  });
  const response = responseCollector();
  await supervisor.handleAccountUsageProxy(response, new URL("http://127.0.0.1/__pi_account_usage"));
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error, "账号额度服务暂不可用");
  assert.match(fs.readFileSync(logFile, "utf8"), /"event":"account-usage-proxy-error"/u);
  fs.rmSync(temporary, { recursive: true, force: true });
});
