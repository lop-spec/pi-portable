import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

import { BrowserRuntime, RESIDENT, formatSnapshot } from "./runtime.mjs";

const ACTIONS = [
  "open",
  "goto",
  "snapshot",
  "text",
  "eval",
  "click",
  "type",
  "press",
  "wait",
  "screenshot",
  "tabs",
  "select_tab",
  "new_tab",
  "close_tab",
  "close",
] as const;

const BrowserParameters = Type.Object({
  action: StringEnum(ACTIONS, { description: "Browser operation" }),
  url: Type.Optional(Type.String({ maxLength: 4096, description: "Absolute http(s) URL; required by goto and optional for open/new_tab" })),
  ref: Type.Optional(Type.String({ maxLength: 32, description: "Element ref from the latest snapshot, for example e4" })),
  selector: Type.Optional(Type.String({ maxLength: 2000, description: "CSS selector when no snapshot ref is available" })),
  role: Type.Optional(Type.String({ maxLength: 80, description: "Accessible role such as button or textbox" })),
  name: Type.Optional(Type.String({ maxLength: 500, description: "Accessible name used with role" })),
  targetText: Type.Optional(Type.String({ maxLength: 1000, description: "Visible target text, or text filter used with selector" })),
  exact: Type.Optional(Type.Boolean({ description: "Use exact role/name/text matching; defaults to true" })),
  value: Type.Optional(Type.String({ maxLength: 100_000, description: "Replacement text for action=type" })),
  expression: Type.Optional(Type.String({ maxLength: 20_000, description: "JavaScript expression evaluated in the page for action=eval; result must be JSON-serializable" })),
  maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 200_000, description: "Character cap for action=text; defaults to 60000" })),
  submit: Type.Optional(Type.Boolean({ description: "Press Enter after action=type" })),
  key: Type.Optional(Type.String({ maxLength: 100, description: "Playwright key chord for action=press, for example Enter or Control+A" })),
  milliseconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Delay for action=wait when no target is supplied" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000, description: "Operation timeout; defaults to 30000" })),
  fullPage: Type.Optional(Type.Boolean({ description: "Capture the entire scrollable page for action=screenshot" })),
  tabIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, description: "Zero-based tab index for action=select_tab" })),
}, { additionalProperties: false });

function extensionDataRoot() {
  if (process.env.PI_PORTABLE_DATA) return path.resolve(process.env.PI_PORTABLE_DATA);
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(extensionDir, "..", "..", "..", "..");
}

function targetFrom(params: any) {
  return {
    ref: params.ref,
    selector: params.selector,
    role: params.role,
    name: params.name,
    targetText: params.targetText,
    exact: params.exact,
  };
}

async function boundedText(runtime: BrowserRuntime, text: string) {
  const truncation = truncateHead(text, { maxLines: 1800, maxBytes: 45_000 });
  if (!truncation.truncated) return { text: truncation.content, fullOutputPath: undefined };
  const fullOutputPath = await runtime.saveTextArtifact("snapshot", text);
  const notice = `\n\n[Snapshot truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${truncation.outputBytes}/${truncation.totalBytes} bytes. Full output: ${fullOutputPath}]`;
  return { text: truncation.content + notice, fullOutputPath };
}

export default function browserAgentExtension(pi: ExtensionAPI) {
  const runtime = new BrowserRuntime({ dataRoot: extensionDataRoot() });

  pi.registerTool({
    name: "browser",
    label: "Headless Browser",
    description: [
      "Operate a dedicated-profile, headless Edge/Chrome instance over loopback CDP with Playwright.",
      "Actions: open/goto/snapshot/text/eval/click/type/press/wait/screenshot/tabs/select_tab/new_tab/close_tab/close.",
      "Prefer text (full innerText) or eval (JSON expression) for reading; snapshot lists interactive refs; screenshot is the visual fallback only.",
      "For click/type targets prefer a ref returned by snapshot; otherwise provide selector, role+name, or targetText.",
      "The browser never connects to the user's daily browser profile. Only absolute http(s) URLs and about:blank are accepted.",
    ].join(" "),
    promptSnippet: "Open and operate live webpages in an isolated, no-window headless browser",
    promptGuidelines: [
      "Use browser for live webpage interaction, DOM-state checks, and screenshots; prefer snapshot refs over guessed coordinates or selectors.",
      RESIDENT
        ? "The browser process stays resident across sessions (isolated profile, loopback CDP); sessions only disconnect at shutdown. Call browser action=close only when the user wants the process gone."
        : "The browser tool uses a persistent isolated profile and closes its process automatically at session shutdown; call browser action=close when it is no longer needed.",
    ],
    parameters: BrowserParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, onUpdate) {
      const timeoutMs = params.timeoutMs ?? 30_000;
      const target = targetFrom(params);
      const snapshotResult = async (snapshot: any, action: string) => {
        const bounded = await boundedText(runtime, formatSnapshot(snapshot));
        return {
          content: [{ type: "text" as const, text: bounded.text }],
          details: {
            action,
            url: snapshot.url,
            title: snapshot.title,
            controls: snapshot.controls.length,
            profileDir: runtime.profileDir,
            fullOutputPath: bounded.fullOutputPath,
          },
        };
      };

      switch (params.action) {
        case "open": {
          onUpdate?.({ content: [{ type: "text", text: "Starting isolated headless browser…" }], details: { action: params.action } });
          return snapshotResult(await runtime.open(params.url, { signal, timeoutMs }), params.action);
        }
        case "goto": {
          if (!params.url) throw new Error("url is required for browser action=goto");
          return snapshotResult(await runtime.navigate(params.url, { signal, timeoutMs }), params.action);
        }
        case "snapshot":
          return snapshotResult(await runtime.snapshot({ signal }), params.action);
        case "text": {
          const result = await runtime.text({ signal, maxText: params.maxChars ?? 60_000 });
          const bounded = await boundedText(runtime, `URL: ${result.url}\nTitle: ${result.title || "(untitled)"}\nChars: ${result.total}\n\n${result.text}`);
          return {
            content: [{ type: "text" as const, text: bounded.text }],
            details: { action: params.action, url: result.url, title: result.title, chars: result.total, fullOutputPath: bounded.fullOutputPath },
          };
        }
        case "eval": {
          if (!params.expression) throw new Error("expression is required for browser action=eval");
          const result = await runtime.evaluate(params.expression, { signal, timeoutMs });
          const serialized = result.value === undefined ? "undefined" : JSON.stringify(result.value, null, 1);
          const bounded = await boundedText(runtime, serialized);
          return {
            content: [{ type: "text" as const, text: bounded.text }],
            details: { action: params.action, url: result.url, fullOutputPath: bounded.fullOutputPath },
          };
        }
        case "click":
          return snapshotResult(await runtime.click(target, { signal, timeoutMs }), params.action);
        case "type": {
          if (params.value === undefined) throw new Error("value is required for browser action=type");
          return snapshotResult(await runtime.type(target, params.value, { signal, timeoutMs, submit: params.submit }), params.action);
        }
        case "press": {
          if (!params.key) throw new Error("key is required for browser action=press");
          return snapshotResult(await runtime.press(target, params.key, { signal, timeoutMs }), params.action);
        }
        case "wait":
          return snapshotResult(await runtime.wait(target, { signal, timeoutMs, milliseconds: params.milliseconds }), params.action);
        case "screenshot": {
          const shot = await runtime.screenshot({ signal, timeoutMs, fullPage: params.fullPage });
          return {
            content: [
              { type: "text" as const, text: `Screenshot captured: ${shot.file}\nURL: ${shot.url}\nTitle: ${shot.title || "(untitled)"}` },
              { type: "image" as const, data: shot.data.toString("base64"), mimeType: "image/png" },
            ],
            details: { action: params.action, file: shot.file, url: shot.url, title: shot.title, bytes: shot.data.length, fullPage: shot.fullPage },
          };
        }
        case "tabs": {
          const tabs = await runtime.tabs({ signal });
          const text = tabs.length
            ? tabs.map((tab) => `${tab.current ? "*" : " "} [${tab.index}] ${tab.title || "(untitled)"} — ${tab.url}`).join("\n")
            : "No open tabs";
          return { content: [{ type: "text", text }], details: { action: params.action, tabs } };
        }
        case "select_tab": {
          if (params.tabIndex === undefined) throw new Error("tabIndex is required for browser action=select_tab");
          return snapshotResult(await runtime.selectTab(params.tabIndex, { signal }), params.action);
        }
        case "new_tab":
          return snapshotResult(await runtime.newTab(params.url, { signal, timeoutMs }), params.action);
        case "close_tab":
          return snapshotResult(await runtime.closeTab({ signal }), params.action);
        case "close": {
          const result = await runtime.close();
          return {
            content: [{ type: "text", text: result.alreadyClosed ? "Headless browser was already closed." : "Headless browser closed; isolated profile retained." }],
            details: { action: params.action, ...result },
          };
        }
        default:
          throw new Error(`Unsupported browser action: ${String(params.action)}`);
      }
    },
  });

  pi.registerCommand("browser-status", {
    description: "Show isolated headless browser tool and process status",
    handler: async (_args, ctx) => {
      const status = runtime.status();
      const active = pi.getActiveTools().includes("browser");
      ctx.ui.notify(
        `browser active=${active} running=${status.running} resident=${status.resident} pid=${status.pid ?? "-"} port=${status.port ?? "-"} headless=true profile=${status.profileDir}`,
        active ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("browser-close", {
    description: "Close the isolated headless browser process and retain its profile",
    handler: async (_args, ctx) => {
      await runtime.close();
      ctx.ui.notify("Isolated headless browser closed; profile retained.", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    if (RESIDENT) await runtime.detach();
    else await runtime.close();
  });
}
