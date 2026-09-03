import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REF_ATTRIBUTE = "data-pi-browser-ref";
const DEFAULT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 20_000;
const VIEWPORT = { width: 1440, height: 900 };
// 常驻:浏览器进程脱离 pi 进程生命周期,靠 profile/DevToolsActivePort 跨会话重连;PI_BROWSER_RESIDENT=0 回到会话结束即关闭。
export const RESIDENT = process.env.PI_BROWSER_RESIDENT !== "0";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Browser operation cancelled");
  error.name = "AbortError";
  throw error;
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol === "about:") return parsed.href;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 1000);
  } catch {
    return String(value || "").slice(0, 1000);
  }
}

function compareVersionNames(left, right) {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
  }
  return right.localeCompare(left);
}

async function isFile(file) {
  if (!file) return false;
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function newestEdgeCoreExecutable(root) {
  if (!root) return null;
  try {
    const entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionNames);
    for (const entry of entries) {
      const executable = path.join(root, entry, "msedge.exe");
      if (await isFile(executable)) return executable;
    }
  } catch {
    // EdgeCore is optional.
  }
  return null;
}

export async function resolveBrowserExecutable(explicitPath = process.env.PI_BROWSER_EXECUTABLE) {
  if (explicitPath) {
    if (await isFile(explicitPath)) return path.resolve(explicitPath);
    throw new Error(`PI_BROWSER_EXECUTABLE does not exist: ${explicitPath}`);
  }

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }

  for (const root of [
    path.join(programFilesX86, "Microsoft", "EdgeCore"),
    path.join(programFiles, "Microsoft", "EdgeCore"),
  ]) {
    const executable = await newestEdgeCoreExecutable(root);
    if (executable) return executable;
  }

  throw new Error("No supported Edge/Chrome executable found. Set PI_BROWSER_EXECUTABLE to an absolute path.");
}

export async function resolvePlaywrightModule(explicitPath = process.env.PI_BROWSER_PLAYWRIGHT) {
  const candidates = [
    explicitPath,
    process.env.PI_VSCODIUM_HOME && path.join(process.env.PI_VSCODIUM_HOME, "app", "resources", "app", "node_modules", "playwright-core", "index.mjs"),
    "D:\\Documents\\vscodium\\app\\resources\\app\\node_modules\\playwright-core\\index.mjs",
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Documents", "vscodium", "app", "resources", "app", "node_modules", "playwright-core", "index.mjs"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Documents", "claude", "vscodium", "app", "resources", "app", "node_modules", "playwright-core", "index.mjs"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = path.extname(candidate) ? candidate : path.join(candidate, "index.mjs");
    if (await isFile(normalized)) return path.resolve(normalized);
  }

  throw new Error("playwright-core was not found. Set PI_BROWSER_PLAYWRIGHT to its index.mjs or package directory.");
}

async function loadChromium(modulePath) {
  const loaded = await import(pathToFileURL(modulePath).href);
  if (!loaded.chromium?.connectOverCDP) {
    throw new Error(`playwright-core Chromium connector is unavailable: ${modulePath}`);
  }
  return loaded.chromium;
}

function normalizeNavigationUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("url is required");
  const value = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`url must be absolute: ${value}`);
  }
  if (parsed.protocol === "about:" && parsed.href === "about:blank") return parsed.href;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported browser URL protocol: ${parsed.protocol}`);
  }
  return parsed.href;
}

async function readDebugEndpoint(profileDir, timeoutMs = 1500) {
  try {
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const [portText] = (await fs.readFile(portFile, "utf8")).trim().split(/\r?\n/u);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const version = await response.json();
    const browserWebSocketUrl = String(version.webSocketDebuggerUrl || "");
    const endpoint = new URL(browserWebSocketUrl);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
      throw new Error(`refusing non-loopback CDP endpoint: ${browserWebSocketUrl}`);
    }
    return { port, browserWebSocketUrl, product: String(version.Browser || "Chromium") };
  } catch {
    return null;
  }
}

async function waitForDebugEndpoint({ child, profileDir, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (child.exitCode !== null) throw new Error(`Headless browser exited before CDP was ready (code ${child.exitCode})`);
    const endpoint = await readDebugEndpoint(profileDir, 800);
    if (endpoint) return endpoint;
    await sleep(100);
  }
  throw new Error(`Headless browser CDP startup timed out after ${timeoutMs}ms`);
}

async function waitForEndpointGone(port, timeoutMs) {
  if (!port) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function killProcessTreeHidden(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "win32") return;
  await new Promise((resolve) => {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 8000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function sendBrowserClose(browserWebSocketUrl, timeoutMs = 3000) {
  if (!browserWebSocketUrl || typeof WebSocket !== "function") return false;
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const socket = new WebSocket(browserWebSocketUrl);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.addEventListener("open", () => {
      opened = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
        if (message.id === 1) finish(!message.error);
      } catch {
        // A closing browser can terminate the socket before a complete response.
      }
    });
    socket.addEventListener("close", () => finish(opened), { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
  });
}

export function formatSnapshot(snapshot) {
  const lines = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title || "(untitled)"}`,
  ];
  if (snapshot.text) lines.push("", "Page text:", snapshot.text);
  lines.push("", `Interactive elements (${snapshot.controls.length}):`);
  if (!snapshot.controls.length) lines.push("(none)");
  for (const item of snapshot.controls) {
    const fields = [`[${item.ref}]`, item.role || item.tag];
    if (item.name) fields.push(`name=${JSON.stringify(item.name)}`);
    if (item.value !== undefined) fields.push(`value=${JSON.stringify(item.value)}`);
    if (item.placeholder) fields.push(`placeholder=${JSON.stringify(item.placeholder)}`);
    if (item.href) fields.push(`href=${JSON.stringify(item.href)}`);
    if (item.checked !== undefined) fields.push(`checked=${item.checked}`);
    if (item.disabled) fields.push("disabled=true");
    lines.push(fields.join(" "));
  }
  return lines.join("\n");
}

export class BrowserRuntime {
  constructor({
    dataRoot,
    profileDir = path.join(dataRoot, "browser-agent", "profile"),
    screenshotDir = path.join(dataRoot, "browser-agent", "screenshots"),
    logFile = path.join(dataRoot, "browser-agent", "browser.log"),
    executablePath,
    playwrightPath,
  }) {
    if (!dataRoot) throw new Error("BrowserRuntime requires dataRoot");
    this.dataRoot = dataRoot;
    this.profileDir = profileDir;
    this.screenshotDir = screenshotDir;
    this.logFile = logFile;
    this.executablePath = executablePath;
    this.playwrightPath = playwrightPath;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.child = null;
    this.endpoint = null;
    this.starting = null;
    this.closing = null;
    this.screenshotSequence = 0;
  }

  status() {
    return {
      running: Boolean(this.browser?.isConnected?.()),
      pid: this.child?.pid ?? null,
      product: this.endpoint?.product ?? null,
      port: this.endpoint?.port ?? null,
      profileDir: this.profileDir,
      executablePath: this.executablePath ?? null,
      playwrightPath: this.playwrightPath ?? null,
      headless: true,
      resident: RESIDENT,
    };
  }

  async log(event, details = {}) {
    const row = {
      at: new Date().toISOString(),
      event,
      ...details,
    };
    try {
      await fs.mkdir(path.dirname(this.logFile), { recursive: true });
      await fs.appendFile(this.logFile, `${JSON.stringify(row)}\n`, "utf8");
    } catch {
      // Logging must never break browser operation.
    }
  }

  async ensureStarted({ signal, timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
    throwIfAborted(signal);
    if (this.browser?.isConnected?.()) {
      await this.ensurePage();
      return this.status();
    }
    if (this.starting) return this.starting;
    this.starting = this.start({ signal, timeoutMs }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async start({ signal, timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
    throwIfAborted(signal);
    await fs.mkdir(this.profileDir, { recursive: true });
    await fs.mkdir(this.screenshotDir, { recursive: true });

    this.playwrightPath = await resolvePlaywrightModule(this.playwrightPath);
    this.executablePath = await resolveBrowserExecutable(this.executablePath);
    const chromium = await loadChromium(this.playwrightPath);

    let endpoint = await readDebugEndpoint(this.profileDir);
    let child = null;
    if (!endpoint) {
      await fs.rm(path.join(this.profileDir, "DevToolsActivePort"), { force: true });
      const args = [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`,
        "--window-size=1440,900",
        "--disable-background-mode",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ];
      child = spawn(this.executablePath, args, {
        cwd: path.dirname(this.executablePath),
        windowsHide: true,
        shell: false,
        stdio: "ignore",
        detached: RESIDENT,
      });
      if (RESIDENT) child.unref();
      this.child = child;
      child.once("exit", (code, exitSignal) => {
        this.log("process-exit", { pid: child.pid ?? null, code, signal: exitSignal }).catch(() => {});
        if (this.child === child) this.child = null;
      });
      try {
        endpoint = await waitForDebugEndpoint({ child, profileDir: this.profileDir, timeoutMs, signal });
      } catch (error) {
        if (child.pid && child.exitCode === null) await killProcessTreeHidden(child.pid);
        throw error;
      }
      await this.log("process-start", {
        pid: child.pid ?? null,
        executablePath: this.executablePath,
        product: endpoint.product,
        port: endpoint.port,
        headless: true,
        resident: RESIDENT,
      });
    } else {
      await this.log("process-reconnect", { product: endpoint.product, port: endpoint.port, headless: true, resident: RESIDENT });
    }

    try {
      throwIfAborted(signal);
    } catch (error) {
      if (child?.pid && child.exitCode === null) await killProcessTreeHidden(child.pid);
      throw error;
    }
    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`, {
        timeout: Math.min(Math.max(timeoutMs, 1000), 60_000),
      });
    } catch (error) {
      if (child?.pid && child.exitCode === null) await killProcessTreeHidden(child.pid);
      throw new Error(`Failed to connect Playwright over loopback CDP: ${error.message}`);
    }

    const contexts = browser.contexts();
    if (!contexts.length) {
      await browser.close().catch(() => {});
      throw new Error("Chromium CDP connection has no browser context");
    }
    this.browser = browser;
    this.context = contexts[0];
    this.endpoint = endpoint;
    this.context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    browser.on("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = null;
      this.context = null;
      this.page = null;
      this.endpoint = null;
    });
    await this.ensurePage();
    return this.status();
  }

  async ensurePage() {
    if (!this.context) throw new Error("Headless browser is not connected");
    if (this.page && !this.page.isClosed()) return this.page;
    const pages = this.context.pages().filter((candidate) => !candidate.isClosed());
    this.page = pages.at(-1) ?? await this.context.newPage();
    await this.page.setViewportSize(VIEWPORT).catch(() => {});
    return this.page;
  }

  async currentPage(options) {
    await this.ensureStarted(options);
    return this.ensurePage();
  }

  async open(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (url) return this.navigate(url, { signal, timeoutMs });
    await this.currentPage({ signal, timeoutMs });
    return this.snapshot({ signal });
  }

  async navigate(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = normalizeNavigationUrl(url);
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await this.log("navigate", { url: safeUrl(page.url()) });
    return this.snapshot({ signal });
  }

  async text({ signal, maxText = 60_000 } = {}) {
    const page = await this.currentPage({ signal });
    throwIfAborted(signal);
    const started = Date.now();
    const result = await page.evaluate((limit) => {
      const text = String(document.body?.innerText || "").trim();
      return { url: location.href, title: document.title, total: text.length, text: text.slice(0, limit) };
    }, maxText);
    await this.log("text", { url: safeUrl(result.url), chars: result.total, ms: Date.now() - started });
    return result;
  }

  async evaluate(expression, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof expression !== "string" || !expression.trim()) throw new Error("expression is required");
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    const started = Date.now();
    let value;
    try {
      // 字符串表达式在页面主世界求值;非 JSON 可序列化值(DOM 节点等)由 Playwright 折叠为 undefined。
      value = await page.evaluate(expression);
    } catch (error) {
      await this.log("eval-error", { url: safeUrl(page.url()), ms: Date.now() - started, error: String(error?.message || error).slice(0, 300) });
      throw error;
    }
    await this.log("eval", { url: safeUrl(page.url()), ms: Date.now() - started });
    return { url: page.url(), value };
  }

  async detach() {
    const browser = this.browser;
    const status = this.status();
    if (!browser) return { detached: false, alreadyDetached: true, pid: status.pid, port: status.port };
    await this.log("detach", { pid: status.pid, port: status.port });
    this.browser = null;
    this.context = null;
    this.page = null;
    this.endpoint = null;
    this.child = null;
    // connectOverCDP 的 browser.close() 只断开本端连接,浏览器进程继续常驻。
    await browser.close().catch(() => {});
    return { detached: true, pid: status.pid, port: status.port };
  }

  async snapshot({ signal, maxText = 12_000, maxControls = 160 } = {}) {
    const page = await this.currentPage({ signal });
    throwIfAborted(signal);
    return page.evaluate(({ refAttribute, textLimit, controlLimit }) => {
      const compact = (value, limit = 240) => String(value || "").replace(/\s+/gu, " ").trim().slice(0, limit);
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && Number(style.opacity || "1") > 0
          && rect.width > 0
          && rect.height > 0
          && node.getAttribute("aria-hidden") !== "true";
      };
      const inferredRole = (node) => {
        const declared = node.getAttribute("role");
        if (declared) return declared;
        const tag = node.tagName.toLowerCase();
        if (tag === "a" && node.hasAttribute("href")) return "link";
        if (tag === "button") return "button";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "summary") return "button";
        if (node.isContentEditable) return "textbox";
        if (tag === "input") {
          const type = String(node.getAttribute("type") || "text").toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          return "textbox";
        }
        return tag;
      };
      const accessibleName = (node) => {
        const labelledBy = compact(node.getAttribute("aria-labelledby"));
        const labelledText = labelledBy
          ? labelledBy.split(" ").map((id) => document.getElementById(id)?.innerText || "").join(" ")
          : "";
        const labelText = "labels" in node && node.labels
          ? [...node.labels].map((label) => label.innerText || "").join(" ")
          : "";
        return compact(
          node.getAttribute("aria-label")
          || labelledText
          || labelText
          || node.getAttribute("alt")
          || node.getAttribute("title")
          || node.innerText
          || node.getAttribute("value")
          || node.getAttribute("placeholder"),
        );
      };

      document.querySelectorAll(`[${refAttribute}]`).forEach((node) => node.removeAttribute(refAttribute));
      const selector = [
        "a[href]", "button", "input", "textarea", "select", "summary",
        "[role]", "[contenteditable='true']", "[onclick]", "[tabindex]:not([tabindex='-1'])",
      ].join(",");
      const controls = [];
      for (const node of document.querySelectorAll(selector)) {
        if (controls.length >= controlLimit || !visible(node)) continue;
        const ref = `e${controls.length + 1}`;
        node.setAttribute(refAttribute, ref);
        const tag = node.tagName.toLowerCase();
        const inputType = tag === "input" ? String(node.getAttribute("type") || "text").toLowerCase() : "";
        const item = {
          ref,
          tag,
          role: inferredRole(node),
          name: accessibleName(node),
        };
        const placeholder = compact(node.getAttribute("placeholder"));
        if (placeholder) item.placeholder = placeholder;
        if (tag === "a" && node.href) item.href = String(node.href).slice(0, 1000);
        if ("disabled" in node && node.disabled) item.disabled = true;
        if ("checked" in node && (inputType === "checkbox" || inputType === "radio")) item.checked = Boolean(node.checked);
        if ("value" in node && !["button", "submit", "reset", "image", "file"].includes(inputType)) {
          item.value = inputType === "password" ? "[redacted]" : compact(node.value, 200);
        }
        controls.push(item);
      }
      return {
        url: location.href,
        title: document.title,
        text: String(document.body?.innerText || "").trim().slice(0, textLimit),
        controls,
      };
    }, { refAttribute: REF_ATTRIBUTE, textLimit: maxText, controlLimit: maxControls });
  }

  locatorFor(page, target = {}) {
    if (target.ref) {
      if (!/^e\d{1,5}$/u.test(target.ref)) throw new Error(`invalid browser ref: ${target.ref}`);
      return page.locator(`[${REF_ATTRIBUTE}="${target.ref}"]`).first();
    }
    if (target.role) {
      return page.getByRole(target.role, {
        ...(target.name !== undefined ? { name: target.name } : {}),
        exact: target.exact ?? true,
      }).first();
    }
    if (target.selector) {
      let locator = page.locator(target.selector);
      if (target.targetText !== undefined) locator = locator.filter({ hasText: target.targetText });
      return locator.first();
    }
    if (target.targetText !== undefined) {
      return page.getByText(target.targetText, { exact: target.exact ?? true }).first();
    }
    throw new Error("target requires ref, selector, role, or targetText");
  }

  async click(target, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    const locator = this.locatorFor(page, target);
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    await locator.click({ timeout: timeoutMs });
    await page.waitForTimeout(150);
    return this.snapshot({ signal });
  }

  async type(target, value, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, submit = false } = {}) {
    if (typeof value !== "string") throw new Error("value is required for browser type");
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    const locator = this.locatorFor(page, target);
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    await locator.fill(value, { timeout: timeoutMs });
    if (submit) await locator.press("Enter", { timeout: timeoutMs });
    return this.snapshot({ signal });
  }

  async press(target, key, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof key !== "string" || !key.trim()) throw new Error("key is required for browser press");
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    if (target.ref || target.selector || target.role || target.targetText !== undefined) {
      await this.locatorFor(page, target).press(key, { timeout: timeoutMs });
    } else {
      await page.keyboard.press(key);
    }
    return this.snapshot({ signal });
  }

  async wait(target, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, milliseconds = 500 } = {}) {
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    if (target.ref || target.selector || target.role || target.targetText !== undefined) {
      await this.locatorFor(page, target).waitFor({ state: "visible", timeout: timeoutMs });
    } else {
      await page.waitForTimeout(Math.min(Math.max(Number(milliseconds) || 0, 0), 30_000));
    }
    return this.snapshot({ signal });
  }

  async screenshot({ signal, fullPage = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const page = await this.currentPage({ signal, timeoutMs });
    throwIfAborted(signal);
    await fs.mkdir(this.screenshotDir, { recursive: true });
    this.screenshotSequence += 1;
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const file = path.join(this.screenshotDir, `${stamp}-${String(this.screenshotSequence).padStart(3, "0")}.png`);
    const data = await page.screenshot({
      path: file,
      type: "png",
      fullPage: Boolean(fullPage),
      animations: "disabled",
      timeout: timeoutMs,
    });
    await this.log("screenshot", { url: safeUrl(page.url()), file, bytes: data.length, fullPage: Boolean(fullPage) });
    return { data, file, url: page.url(), title: await page.title(), fullPage: Boolean(fullPage) };
  }

  async tabs({ signal } = {}) {
    await this.ensureStarted({ signal });
    const pages = this.context.pages().filter((candidate) => !candidate.isClosed());
    return Promise.all(pages.map(async (page, index) => ({
      index,
      current: page === this.page,
      url: page.url(),
      title: await page.title().catch(() => ""),
    })));
  }

  async selectTab(index, { signal } = {}) {
    await this.ensureStarted({ signal });
    const pages = this.context.pages().filter((candidate) => !candidate.isClosed());
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error(`tabIndex out of range: ${index}`);
    this.page = pages[index];
    await this.page.bringToFront();
    await this.page.setViewportSize(VIEWPORT).catch(() => {});
    return this.snapshot({ signal });
  }

  async newTab(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = url ? normalizeNavigationUrl(url) : null;
    await this.ensureStarted({ signal, timeoutMs });
    this.page = await this.context.newPage();
    await this.page.setViewportSize(VIEWPORT).catch(() => {});
    if (target) {
      await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    }
    return this.snapshot({ signal });
  }

  async closeTab({ signal } = {}) {
    const page = await this.currentPage({ signal });
    await page.close();
    this.page = null;
    await this.ensurePage();
    return this.snapshot({ signal });
  }

  async saveTextArtifact(prefix, text) {
    await fs.mkdir(this.screenshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const file = path.join(this.screenshotDir, `${prefix}-${stamp}.txt`);
    await fs.writeFile(file, text, "utf8");
    return file;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  async closeInternal() {
    const browser = this.browser;
    const child = this.child;
    const endpoint = this.endpoint ?? await readDebugEndpoint(this.profileDir);
    const pid = child?.pid ?? null;

    if (!browser && !endpoint && !child) return { closed: true, alreadyClosed: true, profileDir: this.profileDir };
    await this.log("close-start", { pid, port: endpoint?.port ?? null });

    let graceful = false;
    if (endpoint?.browserWebSocketUrl) graceful = await sendBrowserClose(endpoint.browserWebSocketUrl);
    if (!graceful && browser?.isConnected?.()) {
      graceful = await browser.close().then(() => true, () => false);
    }

    let exited = child ? await waitForExit(child, 5000) : await waitForEndpointGone(endpoint?.port, 5000);
    if (!exited && pid) {
      await killProcessTreeHidden(pid);
      exited = await waitForExit(child, 3000);
    }
    if (!exited) await this.log("close-not-exited", { pid, port: endpoint?.port ?? null, owned: Boolean(child) });
    if (browser?.isConnected?.()) await browser.close().catch(() => {});

    this.browser = null;
    this.context = null;
    this.page = null;
    this.endpoint = null;
    this.child = null;
    await this.log("close-end", { pid, graceful, exited });
    return { closed: true, graceful, exited, profileDir: this.profileDir };
  }
}
