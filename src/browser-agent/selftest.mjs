import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserRuntime } from "./runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.PI_PORTABLE_DATA || path.resolve(here, "..", "..", "..", "..");
const evidenceDir = path.join(dataRoot, "browser-agent", "evidence");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-browser-selftest-"));
const profileDir = path.join(temporaryRoot, "profile");
const probeExecutable = path.join(temporaryRoot, "window-probe.exe");
const runtime = new BrowserRuntime({
  dataRoot,
  profileDir,
  screenshotDir: evidenceDir,
  logFile: path.join(dataRoot, "browser-agent", "browser.log"),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runHidden(file, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`${path.basename(file)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").replace(/^\uFEFF/u, "").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) reject(new Error(`${path.basename(file)} exited ${code}: ${errorText || output}`));
      else resolve({ stdout: output, stderr: errorText });
    });
  });
}

async function compileWindowProbe() {
  if (process.platform !== "win32") return null;
  const windowsDir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  let compiler = null;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      compiler = candidate;
      break;
    } catch {}
  }
  if (!compiler) throw new Error("C# compiler unavailable; cannot prove the Windows visible-window boundary");
  await runHidden(compiler, [
    "/nologo",
    "/target:exe",
    `/out:${probeExecutable}`,
    path.join(here, "window-probe.cs"),
  ]);
  return probeExecutable;
}

async function probeWindows(executable, rootPid = 0) {
  if (!executable) return { skipped: true, foregroundHandle: null, visibleWindows: [] };
  const result = await runHidden(executable, [String(rootPid)], { timeoutMs: 10_000 });
  return JSON.parse(result.stdout);
}

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>pi browser self-test</title></head>
<body>
  <main>
    <h1>Browser self-test</h1>
    <label for="name">Name</label>
    <input id="name" autocomplete="off" placeholder="type here">
    <button id="save" type="button">Submit</button>
    <p id="result" aria-live="polite"></p>
    <a href="/next">Next page</a>
  </main>
  <script>
    document.querySelector('#save').addEventListener('click', () => {
      document.querySelector('#result').textContent = 'Saved ' + document.querySelector('#name').value;
    });
  </script>
</body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url === "/next") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>next</title><h1>Next page</h1>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const testUrl = `http://127.0.0.1:${address.port}/`;
const startedAt = new Date().toISOString();
let evidence;
let failure;

try {
  let unsafeProtocolRejected = false;
  await runtime.navigate("file:///C:/Windows/win.ini").catch((error) => {
    unsafeProtocolRejected = String(error?.message || error).includes("unsupported browser URL protocol");
  });
  assert(unsafeProtocolRejected, "non-http browser URL protocol was not rejected");
  assert(!runtime.status().running, "invalid URL unexpectedly started the browser");

  const windowProbe = await compileWindowProbe();
  const windowsBefore = await probeWindows(windowProbe, 0);
  const initial = await runtime.open(testUrl, { timeoutMs: 20_000 });
  const status = runtime.status();
  assert(status.running, "browser did not report running state");
  assert(Number.isInteger(status.pid) && status.pid > 0, "browser root pid is unavailable");
  assert(initial.title === "pi browser self-test", `unexpected initial title: ${initial.title}`);
  assert(initial.controls.some((item) => item.role === "textbox" && item.name === "Name"), "textbox missing from DOM snapshot");
  assert(initial.controls.some((item) => item.role === "button" && item.name === "Submit"), "button missing from DOM snapshot");

  const inputRef = initial.controls.find((item) => item.role === "textbox" && item.name === "Name").ref;
  const afterType = await runtime.type({ ref: inputRef }, "pi-ok", { timeoutMs: 10_000 });
  const typedInput = afterType.controls.find((item) => item.role === "textbox" && item.name === "Name");
  assert(typedInput?.value === "pi-ok", "typed value was not observed in DOM snapshot");
  await runtime.press({ ref: typedInput.ref }, "End", { timeoutMs: 10_000 });
  const buttonRef = afterType.controls.find((item) => item.role === "button" && item.name === "Submit").ref;
  const afterClick = await runtime.click({ ref: buttonRef }, { timeoutMs: 10_000 });
  await runtime.wait({ targetText: "Saved pi-ok", exact: true }, { timeoutMs: 10_000 });
  assert(afterClick.text.includes("Saved pi-ok"), "click/type result was not observed in DOM snapshot");

  const shot = await runtime.screenshot({ timeoutMs: 15_000 });
  assert(shot.data.length > 1000, `screenshot is unexpectedly small: ${shot.data.length}`);
  const nextTab = await runtime.newTab(`${testUrl}next`, { timeoutMs: 10_000 });
  assert(nextTab.title === "next", `new tab navigation failed: ${nextTab.title}`);
  const tabs = await runtime.tabs();
  assert(tabs.length === 2 && tabs.some((tab) => tab.url === `${testUrl}next`), "new tab state is incorrect");
  const selected = await runtime.selectTab(0);
  assert(selected.title === "pi browser self-test", "tab selection failed");
  const afterCloseTab = await runtime.closeTab();
  assert(afterCloseTab.title === "next", "tab close did not select the remaining tab");

  const windowsDuring = await probeWindows(windowProbe, status.pid);
  assert(windowsDuring.visibleWindows.length === 0, `headless browser created visible windows: ${JSON.stringify(windowsDuring.visibleWindows)}`);
  assert(windowsDuring.foregroundHandle === windowsBefore.foregroundHandle,
    `foreground window changed: ${windowsBefore.foregroundHandle} -> ${windowsDuring.foregroundHandle}`);

  const closeResult = await runtime.close();
  assert(closeResult.closed && closeResult.exited, `browser did not exit cleanly: ${JSON.stringify(closeResult)}`);

  evidence = {
    ok: true,
    startedAt,
    completedAt: new Date().toISOString(),
    url: testUrl,
    title: initial.title,
    browser: status,
    dom: {
      controls: initial.controls.length,
      typedAndClicked: afterClick.text.includes("Saved pi-ok"),
      unsafeProtocolRejected,
    },
    screenshot: { path: shot.file, bytes: shot.data.length },
    tabs: {
      opened: tabs,
      remainingTitle: afterCloseTab.title,
    },
    windows: {
      foregroundBefore: windowsBefore.foregroundHandle,
      foregroundDuring: windowsDuring.foregroundHandle,
      visibleWindowCount: windowsDuring.visibleWindows.length,
      processCount: windowsDuring.processIds?.length ?? null,
    },
    close: closeResult,
  };
} catch (error) {
  failure = error;
  await runtime.close().catch(() => {});
  evidence = {
    ok: false,
    startedAt,
    completedAt: new Date().toISOString(),
    error: String(error?.stack || error),
    browser: runtime.status(),
  };
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

await fs.mkdir(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, `selftest-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...evidence, evidenceFile }, null, 2));
if (failure) process.exitCode = 1;
