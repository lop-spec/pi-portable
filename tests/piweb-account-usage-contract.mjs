#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import "./account-login-contract.mjs";
import { fileURLToPath } from "node:url";

import {
  PIWEB_ACCOUNT_SELECT_PATH,
  PIWEB_ACCOUNT_USAGE_PATH,
  PiWebUiProxy,
} from "../src/piweb-ui-proxy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiSource = fs.readFileSync(path.join(root, "src", "piweb-archive-ui.js"), "utf8");
// Only the quota IIFE: later IIFEs (service tier) legitimately read /api/agent and are covered by their own contract.
const quotaStart = uiSource.indexOf('const VERSION = "piweb-account-usage-');
const quotaUi = uiSource.slice(quotaStart, uiSource.indexOf("\n})();", quotaStart));
assert.ok(quotaStart > 0 && quotaUi.length > 10000, "quota UI section must be located");
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
  // D26: the gauge and panel only carry the shared primitives (.pw-quota / .pw-menu); fonts, radii,
  // shadows, width (320) and the reduced-motion handling all come from the app's stylesheet.
  assert.match(quotaUi, /button\.className = "pw-quota"/u);
  assert.match(quotaUi, /className = "pw-menu pw-menu--up pw-slot-popover pw-quota-panel"/u);
  assert.doesNotMatch(quotaUi, /cssText|style\.(font|borderRadius|boxShadow)/u, "no inline font, radius or shadow");
  const tick = String.fromCharCode(96);
  const cssStart = uiSource.indexOf("const CSS = " + tick);
  const injectedCss = uiSource.slice(cssStart, uiSource.indexOf(tick + ";", cssStart));
  assert.ok(cssStart > 0 && injectedCss.length > 1000, "the single injected stylesheet must be located");
  assert.doesNotMatch(injectedCss, /@keyframes|animation:|transition:/u, "motion comes from the .pw-menu primitive, which honours prefers-reduced-motion");
  assert.match(quotaUi, /register\(\{ name: "quota", slot: "composer"/u, "the gauge is appended into [data-pi-composer-slot], in document order");
  assert.doesNotMatch(quotaUi, /panel\.focus\(/u, "a mouse open must not focus (and ring) the whole panel");
  assert.match(quotaUi, /setOpen\(!state\.open, performance\.now\(\), event\.detail === 0\)/u, "keyboard opens move focus to the first item");
  assert.match(quotaUi, /switchAccount: "切换"/u);
  assert.match(quotaUi, /reauth: "重新登录", addAccount: "添加账号"/u);
  assert.match(quotaUi, /const LOGIN_ENDPOINT = "\/__pi_account_login"/u);
  assert.match(quotaUi, /reauth\.addEventListener\("click"/u);
  assert.match(quotaUi, /addButton\.addEventListener\("click"/u);
  assert.match(quotaUi, /input\.setAttribute\("aria-label", text\.callback\)/u);
  assert.doesNotMatch(quotaUi, /window\.open\(/u, "authorization opens only through an explicit user link");
  assert.match(quotaUi, /action\.className = "pw-btn pw-btn--sm"/u);
  assert.match(quotaUi, /switchAccount\(String\(account\.id/u);
  assert.match(quotaUi, /remaining: "剩余"/u);
  assert.match(quotaUi, /resets: "重置卡余额（不是当前可立即使用的次数）"/u);
  assert.match(quotaUi, /resetCountShort: "重置卡"/u);
  assert.match(quotaUi, /account\.resetCredits \?\? "—"/u, "unknown balances must not be displayed as zero");
  assert.match(quotaUi, /resetCards\.title = text\.resets/u);
  assert.match(quotaUi, /resetAt: "重置时间"/u);
  assert.match(quotaUi, /account\.email/u);
  assert.match(quotaUi, /console\.error\("\[pi-web account usage\] refresh failed:/u, "refresh degradation must never be silent");
  assert.match(quotaUi, /console\.error\("\[pi-web account usage\] account switch failed:/u, "switch failures must never be silent");
  assert.doesNotMatch(quotaUi, /\/v1\/responses|\/api\/agent/u, "quota UI must never invoke a model path");
});

test("account management uses existing header whitespace and never overlays account information", () => {
  assert.match(quotaUi, /controls\.append\(reauth, remove, action\)/u);
  assert.match(quotaUi, /top\.appendChild\(controls\)/u);
  assert.doesNotMatch(quotaUi, /row\.appendChild\(controls\)/u, "management buttons must not add a separate row");
  assert.match(quotaUi, /reauth\.title = `\$\{text\.reauth\} \$\{email\}`/u);
  assert.match(quotaUi, /remove\.setAttribute\("aria-label"/u);
  // Delete/re-login/switch replace the value on row hover or keyboard focus; hidden ones stay focusable.
  assert.match(uiSource, /\.pi-account-usage-row:not\(:hover,:focus-within\) \.pi-account-row-controls\{position:absolute;[^}]*clip-path:inset\(50%\)/u);
  assert.doesNotMatch(uiSource, /\.pi-account-row-controls\{display:none/u, "display:none would make the row actions unreachable by keyboard");
  const footer = uiSource.match(/\.pi-account-login-footer\{([^}]+)\}/u)?.[1];
  assert.ok(footer);
  assert.doesNotMatch(footer, /position\s*:\s*(sticky|fixed|absolute)/u, "add account must flow after the list, not cover its last row");
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
        accounts: [{ id: "acct2", email: "acct2@gmail.com", remainingPercent: 91, resetCredits: 2 }],
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
  assert.equal(body.accounts[0].resetCredits, 2, "real card balance must survive the same-origin proxy unchanged");
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

test("a busy bridge is waited for, then answered from the last snapshot instead of a false 503", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-busy-"));
  const logFile = path.join(temporary, "ui-proxy.log");
  let mode = "slow", calls = 0;
  const proxy = new PiWebUiProxy({
    dataRoot: temporary,
    logFile,
    accountUsageReuseMs: 0,
    accountUsageTimeoutMs: 400,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (mode === "down") throw new Error("bridge unavailable");
      // The old proxy gave up after 500 ms; a busy bridge answering late is normal, not an outage.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 150);
        init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); });
      });
      return new Response(JSON.stringify({ ok: true, enabled: true, accounts: [{ id: "acct2", remainingPercent: 70 }] }), { status: 200 });
    },
  });
  const read = async () => {
    const response = responseCollector();
    await proxy.handleAccountUsageProxy(response, new URL("http://127.0.0.1/__pi_account_usage"));
    return { ...response, json: JSON.parse(response.body) };
  };
  const first = await read();
  assert.equal(first.status, 200);
  assert.equal(first.headers["x-pi-usage-source"], "bridge");
  mode = "down";
  const stale = [await read(), await read(), await read()];
  for (const response of stale) {
    assert.equal(response.status, 200, "a failing bridge must not turn a known snapshot into a 503");
    assert.equal(response.json.proxyStale, true);
    assert.equal(response.json.accounts[0].remainingPercent, 70);
    assert.equal(response.headers["x-pi-usage-source"], "stale-snapshot");
  }
  const errors = fs.readFileSync(logFile, "utf8").split("\n").filter((line) => line.includes('"account-usage-proxy-error"'));
  assert.equal(errors.length, 1, "failures are logged on the transition, not once per poll");
  mode = "slow";
  assert.equal((await read()).headers["x-pi-usage-source"], "bridge");
  assert.match(fs.readFileSync(logFile, "utf8"), /"event":"account-usage-proxy-recovered"[^\n]*"failures":3/u);
  assert.equal(calls, 5);
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("parallel tabs share one bridge read and recent snapshots are reused", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-shared-"));
  let calls = 0;
  const proxy = new PiWebUiProxy({
    dataRoot: temporary,
    logFile: path.join(temporary, "ui-proxy.log"),
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ ok: true, enabled: true, accounts: [] }), { status: 200 });
    },
  });
  const read = async () => {
    const response = responseCollector();
    await proxy.handleAccountUsageProxy(response, new URL("http://127.0.0.1/__pi_account_usage"));
    return response;
  };
  const results = await Promise.all([read(), read(), read()]);
  assert.deepEqual(results.map((response) => response.status), [200, 200, 200]);
  assert.equal(calls, 1, "concurrent polls are single-flight");
  assert.equal((await read()).headers["x-pi-usage-source"], "memory");
  assert.equal(calls, 1);
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("a bridge slower than the page budget is not aborted: its answer lands in the snapshot", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-account-usage-slow-"));
  const logFile = path.join(temporary, "ui-proxy.log");
  let delay = 50, generation = 0;
  const proxy = new PiWebUiProxy({
    dataRoot: temporary,
    logFile,
    accountUsageReuseMs: 0,
    accountUsageTimeoutMs: 100,
    fetchImpl: async () => {
      const value = ++generation;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response(JSON.stringify({ ok: true, enabled: true, accounts: [{ id: "acct1", remainingPercent: value }] }), { status: 200 });
    },
  });
  const read = async () => {
    const response = responseCollector();
    await proxy.handleAccountUsageProxy(response, new URL("http://127.0.0.1/__pi_account_usage"));
    return { ...response, json: JSON.parse(response.body) };
  };
  assert.equal((await read()).json.accounts[0].remainingPercent, 1);
  delay = 300;
  const slow = await read();
  assert.equal(slow.status, 200);
  assert.equal(slow.headers["x-pi-usage-source"], "stale-slow");
  assert.equal(slow.json.accounts[0].remainingPercent, 1, "the page gets the last snapshot at once");
  await new Promise((resolve) => setTimeout(resolve, 350));
  delay = 50;
  assert.equal((await read()).json.accounts[0].remainingPercent, 3, "a fresh read follows; the slow read 2 was kept, not aborted");
  assert.equal(proxy.accountUsage.failures, 0);
  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, /"event":"account-usage-proxy-slow"/u, "a degraded answer is logged");
  assert.doesNotMatch(log, /"event":"account-usage-proxy-error"/u, "a slow bridge is not an outage");
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("the browser backs off 5 s / 15 s / 45 s with jitter and retries at once when the panel opens on an error", () => {
  assert.match(quotaUi, /const RETRY_MS = \[5_000, 15_000, 45_000\]/u);
  assert.match(quotaUi, /0\.8 \+ Math\.random\(\) \* 0\.4/u);
  assert.match(quotaUi, /if \(state\.error \|\| !state\.lastFetchAt/u);
});
