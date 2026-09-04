#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PIWEB_ACCOUNT_SELECT_PATH,
  PIWEB_ACCOUNT_USAGE_PATH,
  PiWebUiProxy,
} from "../src/piweb-ui-proxy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiSource = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");
const quotaUi = uiSource.slice(uiSource.indexOf('const VERSION = "piweb-account-usage-v2"'));
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

function controlRequest(value, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(value))]);
  request.headers = {
    host: "127.0.0.1:30141",
    origin: "http://127.0.0.1:30141",
    "content-type": "application/json",
    ...headers,
  };
  return request;
}

test("quota control is half-area compact, cached, keyboard accessible, and opens on pointerdown", () => {
  assert.match(quotaUi, /const ENDPOINT = "\/__pi_account_usage"/u);
  assert.match(quotaUi, /const SELECT_ENDPOINT = "\/__pi_account_select"/u);
  assert.match(quotaUi, /const BROWSER_REFRESH_MS = 45_000/u);
  assert.match(quotaUi, /button\.addEventListener\("pointerdown"/u, "physical presses must render from browser memory immediately");
  assert.match(quotaUi, /dataset\.piAccountUsageOpenLatencyMs/u, "live UI must expose measured open latency");
  assert.match(quotaUi, /dataset\.piAccountSwitchLatencyMs/u, "live UI must expose confirmed switch latency");
  assert.match(quotaUi, /aria-haspopup", "dialog/u);
  assert.match(quotaUi, /aria-expanded/u);
  assert.match(quotaUi, /event\.key !== "Escape"/u);
  assert.match(quotaUi, /prefers-reduced-motion/u);
  assert.match(quotaUi, /width:280px/u);
  assert.doesNotMatch(quotaUi, /width:352px/u);
  assert.match(quotaUi, /switchAccount: "切换"/u);
  assert.match(quotaUi, /className = "pi-account-usage-switch"/u);
  assert.match(quotaUi, /remaining: "剩余"/u);
  assert.match(quotaUi, /resets: "重置次数"/u);
  assert.match(quotaUi, /resetAt: "重置时间"/u);
  assert.match(quotaUi, /account\.email/u);
  assert.match(quotaUi, /console\.error\("\[pi-web account usage\] refresh failed:/u, "refresh degradation must never be silent");
  assert.match(quotaUi, /console\.error\("\[pi-web account usage\] account switch failed:/u, "switch failures must never be silent");
  assert.doesNotMatch(quotaUi, /\/v1\/responses|\/api\/agent/u, "quota UI must never invoke a model path");
});

test("bridge usage and selection controls stay outside bearer auth and return confirmed active state", () => {
  const usageAt = bridgeSource.indexOf('if (url === "/account-usage"');
  const selectAt = bridgeSource.indexOf('if (url === "/account/select"');
  const bearerAt = bridgeSource.indexOf("const bearer =");
  assert.ok(usageAt > 0 && selectAt > usageAt && bearerAt > selectAt, "local controls must be reachable without sending credentials to the browser");
  assert.match(bridgeSource, /\/backend-api\/wham\/usage/u);
  assert.match(bridgeSource, /account-usage-cache\.json/u);
  assert.match(bridgeSource, /accountUsageMonitor\.start\(\)/u);
  assert.match(bridgeSource, /accounts: accountUsageMonitor\.snapshot\(\)\.accounts/u);
  assert.match(bridgeSource, /账号额度接口失败/u);
});

test("UI proxy serves a sanitized same-origin quota snapshot", async () => {
  assert.equal(PIWEB_ACCOUNT_USAGE_PATH, "/__pi_account_usage");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-proxy-"));
  const calls = [];
  const proxy = new PiWebUiProxy({
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
  await proxy.handleAccountUsageProxy(response, new URL("http://127.0.0.1/__pi_account_usage?refresh=1"));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["http://127.0.0.1:18794/account-usage?refresh=1"]);
  const body = JSON.parse(response.body);
  assert.equal(body.modelTokensConsumed, 0);
  assert.equal(body.accounts[0].email, "acct2@gmail.com");
  assert.equal(response.headers["cache-control"], "no-store");
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("same-origin account switch is confirmed by the bridge and immediately returns active rows", async () => {
  assert.equal(PIWEB_ACCOUNT_SELECT_PATH, "/__pi_account_select");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-select-proxy-"));
  const calls = [];
  const proxy = new PiWebUiProxy({
    dataRoot: temporary,
    bridgePort: 18794,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      return new Response(JSON.stringify({
        ok: true,
        id: "acct2",
        accounts: [
          { id: "primary", email: "primary@gmail.com", active: false },
          { id: "acct2", email: "acct2@gmail.com", active: true },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = responseCollector();
  await proxy.handleAccountSelectProxy(controlRequest({ id: "acct2" }), response);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:18794/account/select",
    method: "POST",
    body: JSON.stringify({ id: "acct2" }),
  }]);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.find((account) => account.id === "acct2").active, true);
  assert.equal(response.headers["cache-control"], "no-store");
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("cross-origin switch and quota proxy failures are visible in response and logs", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-error-"));
  const logFile = path.join(temporary, "ui-proxy.log");
  let calls = 0;
  const proxy = new PiWebUiProxy({
    dataRoot: temporary,
    logFile,
    fetchImpl: async () => { calls += 1; throw new Error("bridge unavailable"); },
  });

  const rejected = responseCollector();
  await proxy.handleAccountSelectProxy(controlRequest({ id: "acct2" }, { origin: "https://evil.example" }), rejected);
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);

  const failed = responseCollector();
  await proxy.handleAccountUsageProxy(failed, new URL("http://127.0.0.1/__pi_account_usage"));
  assert.equal(failed.status, 503);
  assert.equal(JSON.parse(failed.body).error, "账号额度服务暂不可用");

  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, /"event":"account-select-rejected"/u);
  assert.match(log, /"event":"account-usage-proxy-error"/u);
  fs.rmSync(temporary, { recursive: true, force: true });
});
