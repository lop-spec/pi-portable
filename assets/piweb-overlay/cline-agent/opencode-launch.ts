import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ClineToolSpec } from "./cline-bridge";

export const OPENCODE_PREAMBLE = "Call tools only when needed. Read the relevant on-demand rules with oc_read.";

const descriptions = {
  read: "Read a file or directory by absolute path.",
  glob: "Find paths by glob.",
  grep: "Search text by regex.",
  bash: "Run a shell command.",
  edit: "Replace text in a file.",
  write: "Write a file.",
  webfetch: "Fetch a web page.",
};
export const openCodeTools = (specs: ClineToolSpec[]): ClineToolSpec[] => specs.flatMap((spec) => {
  if (!Object.hasOwn(descriptions, spec.name)) return [];
  return [{ name: spec.name, description: descriptions[spec.name as keyof typeof descriptions], parameters: minimalSchema(spec.parameters) as Record<string, unknown> }];
});

// These are the wire schemas emitted by the pinned Windows CLI. The protocol test
// checks them against the actual executable so a text-only turn never needs a worker.
const string = { type: "string" };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const schema = (properties: Record<string, unknown>, ...required: string[]) => ({ type: "object", properties, required });
export const OPENCODE_TOOLS = openCodeTools([
  { name: "bash", parameters: schema({ command: string, timeout: { minimum: Number.MIN_SAFE_INTEGER, exclusiveMinimum: 0, type: "integer", maximum: Number.MAX_SAFE_INTEGER }, workdir: string }, "command") },
  { name: "edit", parameters: schema({ filePath: string, oldString: string, newString: string, replaceAll: { type: "boolean" } }, "filePath", "oldString", "newString") },
  { name: "glob", parameters: schema({ pattern: string, path: string }, "pattern") },
  { name: "grep", parameters: schema({ pattern: string, path: string, include: string }, "pattern") },
  { name: "read", parameters: schema({ filePath: string, offset: integer, limit: integer }, "filePath") },
  { name: "webfetch", parameters: schema({ url: string, format: { type: "string", enum: ["text", "markdown", "html"], default: "markdown" }, timeout: { type: "number" } }, "url") },
  { name: "write", parameters: schema({ content: string, filePath: string }, "content", "filePath") },
].map((spec) => ({ ...spec, description: "" })));

function minimalSchema(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(minimalSchema);
  return Object.fromEntries(Object.entries(value).filter(([name]) => !["description", "examples", "$schema", "title"].includes(name)).map(([name, child]) => [name,
    name === "properties" && child && typeof child === "object" ? Object.fromEntries(Object.entries(child).map(([key, schema]) => [key, minimalSchema(schema)])) : minimalSchema(child),
  ]));
}

export function resolveOpenCodeBinary(root: string, env = process.env): string | undefined {
  const override = env.PI_WEB_OPENCODE_BIN?.trim();
  const bin = override || join(root, "cli", process.platform === "win32" ? "opencode.exe" : "opencode");
  return isAbsolute(bin) && existsSync(bin) ? bin : undefined;
}

export function launchOpenCode(home: string, port: number, token: string) {
  const plugins = join(home, "config", "opencode", "plugins");
  mkdirSync(plugins, { recursive: true });
  const plugin = `export const PiWeb = async () => ({
  "experimental.chat.system.transform": async (_input, output) => { output.system.splice(0, output.system.length, ${JSON.stringify(OPENCODE_PREAMBLE)}); },
  "tool.definition": async ({ toolID }, output) => { output.description = (${JSON.stringify(descriptions)})[toolID] ?? toolID; },
});\n`;
  writeFileSync(join(plugins, "piweb.js"), plugin);
  // Isolate OpenCode configuration; Pi alone owns the selected model and authentication.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^OPENCODE_/i.test(key)) delete env[key];
  const provider = "pi-web";
  const config = {
    model: `${provider}/${token}`,
    enabled_providers: [provider],
    provider: { [provider]: { npm: "@ai-sdk/openai-compatible", name: "Pi Web", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: token }, models: { [token]: { name: "Pi Web", tool_call: true, limit: { context: 100_000, output: 10_000 } } } } },
    default_agent: "pi-web",
    agent: { "pi-web": { mode: "primary", prompt: OPENCODE_PREAMBLE } },
    permission: { external_directory: "allow" },
    autoupdate: false, share: "disabled", snapshot: false, formatter: false, lsp: false,
  };
  return {
    args: ["run", "--agent", "pi-web", "--title", "Pi Web tool relay", "--format", "json", "Continue the Pi Web conversation."],
    env: {
      ...env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
      OPENCODE_TEST_HOME: home, OPENCODE_DB: ":memory:", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify(config), DO_NOT_TRACK: "1",
    },
  };
}
