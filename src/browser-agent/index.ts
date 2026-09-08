import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { importFreshModule } from "./fresh-module.mjs";

const ACTIONS = ["open", "goto", "snapshot", "text", "eval", "click", "type", "press", "wait", "screenshot", "tabs", "select_tab", "new_tab", "close_tab", "close"] as const;
const BrowserParameters = Type.Object({
  action: StringEnum(ACTIONS, { description: "Browser operation" }),
  url: Type.Optional(Type.String({ maxLength: 4096, description: "Absolute http(s) URL; required by goto and optional for open/new_tab" })),
  ref: Type.Optional(Type.String({ maxLength: 32, description: "Element ref from the latest snapshot, for example f1e4" })),
  selector: Type.Optional(Type.String({ maxLength: 2000, description: "CSS selector when no snapshot ref is available" })),
  role: Type.Optional(Type.String({ maxLength: 80, description: "Accessible role such as button or textbox" })),
  name: Type.Optional(Type.String({ maxLength: 500, description: "Accessible name used with role" })),
  targetText: Type.Optional(Type.String({ maxLength: 1000, description: "Visible target text, or text filter used with selector" })),
  exact: Type.Optional(Type.Boolean({ description: "Use exact role/name/text matching; defaults to true" })),
  value: Type.Optional(Type.String({ maxLength: 100000, description: "Replacement text for action=type" })),
  expression: Type.Optional(Type.String({ maxLength: 20000, description: "JavaScript expression evaluated in the page; result must be JSON-serializable" })),
  maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 200000, description: "Character cap for action=text; defaults to 60000" })),
  submit: Type.Optional(Type.Boolean({ description: "Press Enter after action=type" })),
  key: Type.Optional(Type.String({ maxLength: 100, description: "Playwright key chord for action=press, for example Enter or Control+A" })),
  milliseconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "Delay for action=wait when no target is supplied" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: "Operation timeout; defaults to 30000" })),
  fullPage: Type.Optional(Type.Boolean({ description: "Capture the entire scrollable page for action=screenshot" })),
  tabIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, description: "Zero-based tab index for action=select_tab" })),
}, { additionalProperties: false });

function extensionDataRoot() {
  if (process.env.PI_PORTABLE_DATA) return path.resolve(process.env.PI_PORTABLE_DATA);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export default async function browserAgentExtension(pi: ExtensionAPI) {
  const { ExtensionBrowserRuntime } = await importFreshModule(new URL("./extension-runtime.mjs", import.meta.url));
  const runtime = new ExtensionBrowserRuntime({ dataRoot: extensionDataRoot() });
  pi.registerTool({
    name: "browser",
    label: "Thorium Background Browser",
    description: [
      "Operate the user's daily Thorium through a background-only fork of the official Playwright Extension CDP bridge. Reuse its login state without activating windows or tabs.",
      "Never connect to native remote-debugging ports, open an isolated browser, copy website login data, or silently fall back to another browser.",
      "Actions: open/goto/snapshot/text/eval/click/type/press/wait/screenshot/tabs/select_tab/new_tab/close_tab/close.",
      "Prefer text or eval for reading; snapshot supplies refs (such as f1e4); screenshot is a visual fallback only.",
      "Use snapshot refs for click/type, otherwise selectors or accessible role/name. A login redirect alone does not identify its cause.",
      "Only http(s) and about:blank navigation is accepted. close disconnects the extension worker, retaining Thorium and its login state.",
    ].join(" "),
    promptSnippet: "Read and operate logged-in webpages in daily Thorium through the background-only Playwright Extension",
    promptGuidelines: [
      "Use browser through the installed background-only Playwright Extension. Never activate a window/tab, use native remote-debugging windows, or launch an isolated browser.",
      "The browser extension token is machine-local; never print it, copy website credentials, or synchronize credentials to another machine.",
      "Prefer browser text/eval and snapshot refs. Do not infer login expiry from a redirect alone. Session shutdown only disconnects the MCP worker, never closes the user's Thorium process.",
    ],
    parameters: BrowserParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const abort = () => { void runtime.detach().catch(error => console.error('[browser] abort-detach-failed:', error.message)); };
      signal?.addEventListener('abort', abort, { once: true });
      try { return await runtime.execute(params); }
      finally { signal?.removeEventListener('abort', abort); }
    },
  });
  pi.registerCommand("browser-status", {
    description: "Show the official Playwright Extension connection status",
    handler: async (_args, ctx) => {
      const status = runtime.status();
      ctx.ui.notify(`browser active=${pi.getActiveTools().includes("browser")} running=${status.running} mode=${status.mode} pid=${status.pid ?? "-"} profile=${status.profileDir}`, "info");
    },
  });
  pi.registerCommand("browser-close", {
    description: "Disconnect the extension worker without closing Thorium",
    handler: async (_args, ctx) => {
      await runtime.detach();
      ctx.ui.notify("Extension disconnected; Thorium and its login state retained.", "info");
    },
  });
  pi.on("session_shutdown", async () => { await runtime.detach(); });
}
