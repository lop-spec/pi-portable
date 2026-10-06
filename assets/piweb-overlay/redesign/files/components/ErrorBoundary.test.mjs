import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ErrorBoundary, ErrorBanner, isChunkLoadError } = await jiti.import("./ErrorBoundary.tsx");

const chunkError = () => Object.assign(new Error("Loading chunk 4703 failed.\n(error: /_next/static/chunks/4703.js)"), { name: "ChunkLoadError" });

test("recognises webpack and native dynamic-import failures", () => {
  assert.equal(isChunkLoadError(chunkError()), true);
  assert.equal(isChunkLoadError(new Error("Loading chunk 12 failed.")), true);
  assert.equal(isChunkLoadError(new Error("Failed to fetch dynamically imported module: /x.js")), true);
  assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true);
  assert.equal(isChunkLoadError(new Error("Cannot read properties of undefined")), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError("Loading chunk 1 failed"), false);
});

test("the banner is an alert with retry and reload, and reload leads for a failed chunk", () => {
  const chunk = renderToStaticMarkup(React.createElement(ErrorBanner, { scope: "对话区", error: chunkError(), onRetry() {} }));
  assert.match(chunk, /role="alert"/);
  assert.match(chunk, /对话区显示出错/);
  assert.match(chunk, /刷新页面即可恢复/);
  assert.match(chunk, /<button type="button" class="pw-btn">重试<\/button>/);
  assert.match(chunk, /<button type="button" class="pw-btn pw-btn--primary">刷新页面<\/button>/);
  const other = renderToStaticMarkup(React.createElement(ErrorBanner, { scope: "对话区", error: new Error("boom <b>"), onRetry() {} }));
  assert.match(other, /boom &lt;b&gt;/);
  assert.doesNotMatch(other, /刷新页面即可恢复/);
  assert.match(other, /<button type="button" class="pw-btn">刷新页面<\/button>/);
});

test("the boundary keeps the failure local: logs the scope, shows the banner or a fallback, resets on a new key", () => {
  const state = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
  assert.equal(state.error.message, "boom");
  assert.equal(ErrorBoundary.getDerivedStateFromError("plain string").error.message, "plain string");

  const make = (props) => {
    const boundary = new ErrorBoundary({ scope: "对话区", children: "kids", ...props });
    boundary.setState = (next) => { boundary.state = { ...boundary.state, ...next }; };
    return boundary;
  };
  const healthy = make({});
  assert.equal(healthy.render(), "kids");

  const failed = make({ fill: true });
  failed.state = state;
  const region = failed.render();
  assert.equal(region.type, "div");
  assert.equal(region.props.className, "pw-error-region");
  assert.equal(region.props.children.type, ErrorBanner);
  assert.equal(region.props.children.props.scope, "对话区");

  const plain = make({});
  plain.state = state;
  assert.equal(plain.render().type, ErrorBanner, "without fill the banner is returned directly");

  const fallbackNode = React.createElement("span", null, "plain");
  const quiet = make({ fallback: fallbackNode });
  quiet.state = state;
  assert.equal(quiet.render(), fallbackNode);

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try { failed.componentDidCatch(state.error, { componentStack: "\n at X" }); } finally { console.error = original; }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /\[pi-web\] 对话区渲染失败/);
  assert.equal(logged[0][1], state.error);

  const keyed = make({ resetKey: "s2" });
  keyed.state = state;
  keyed.componentDidUpdate({ resetKey: "s2" });
  assert.equal(keyed.state.error, state.error, "same key keeps the banner");
  keyed.componentDidUpdate({ resetKey: "s1" });
  assert.equal(keyed.state.error, null, "another session clears it");
  failed.reset();
  assert.equal(failed.state.error, null, "retry clears it");
});

// ───────── fixw2：面板级边界（lazy-panels）和根错误页（global-error）用到的扩展 ─────────
const { claimChunkReload, CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS } = await jiti.import("./ErrorBoundary.tsx");

test("a render-function fallback gets the error and a reset, and onReset lets the owner rebuild its children before the retry", () => {
  const error = new Error("Loading chunk 9 failed.");
  const calls = [];
  const boundary = new ErrorBoundary({
    scope: "设置",
    children: "kids",
    onReset: () => calls.push("owner"),
    fallback: ({ error: caught, reset }) => React.createElement("button", { "data-msg": caught.message, onClick: reset }, "x"),
  });
  boundary.setState = (next) => { boundary.state = { ...boundary.state, ...next }; calls.push("state"); };
  boundary.state = { error };
  const node = boundary.render();
  assert.equal(node.type, "button");
  assert.equal(node.props["data-msg"], "Loading chunk 9 failed.");
  node.props.onClick();
  assert.equal(boundary.state.error, null, "reset clears the error");
  assert.deepEqual(calls, ["state", "owner"], "the owner is told after the error is cleared, so a retry re-renders with fresh children");
  // a resetKey change clears the error the same way and also tells the owner
  const keyed = new ErrorBoundary({ scope: "设置", resetKey: "b", onReset: () => calls.push("owner2") });
  keyed.setState = (next) => { keyed.state = { ...keyed.state, ...next }; };
  keyed.state = { error };
  keyed.componentDidUpdate({ resetKey: "a" });
  assert.equal(keyed.state.error, null);
  assert.equal(calls.at(-1), "owner2");
});

test("the banner shows 关闭 only when the owner can dismiss it (dialog panels), next to 重试 and 刷新页面", () => {
  const withDismiss = renderToStaticMarkup(React.createElement(ErrorBanner, { scope: "设置", error: chunkError(), onRetry() {}, onDismiss() {} }));
  assert.match(withDismiss, /<button type="button" class="pw-btn">关闭<\/button>/);
  assert.match(withDismiss, /设置显示出错/);
  const without = renderToStaticMarkup(React.createElement(ErrorBanner, { scope: "设置", error: chunkError(), onRetry() {} }));
  assert.doesNotMatch(without, /关闭/);
});

test("a failed chunk triggers at most one automatic reload per minute, tracked in sessionStorage, and never loops without storage", () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  assert.equal(CHUNK_RELOAD_WINDOW_MS, 60_000);
  assert.equal(claimChunkReload(storage, 1_000_000), true, "first failure: reload");
  assert.equal(data.get(CHUNK_RELOAD_KEY), "1000000");
  assert.equal(claimChunkReload(storage, 1_000_000 + 59_999), false, "the reload did not fix it: stop, show the manual button");
  assert.equal(claimChunkReload(storage, 1_000_000 + 60_000), true, "a later release days afterwards may reload again");
  assert.equal(claimChunkReload(null, 5), false, "no sessionStorage: cannot guard against a loop, so do not reload automatically");
  assert.equal(claimChunkReload({ getItem() { throw new Error("blocked"); }, setItem() {} }, 5), false);
  data.set(CHUNK_RELOAD_KEY, "not a number");
  assert.equal(claimChunkReload(storage, 7), true, "a corrupt marker does not block the reload");
});
