import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ClineToolSpec } from "./cline-bridge";

export const OPENCODE_PREAMBLE = "Call tools only when needed. Read the relevant on-demand rules with oc_read.";

const descriptions = {
  read: "Read a file or directory by absolute path.",
  glob: "Find paths by glob.",
  grep: "Search text by regex.",
  shell: "Run a shell command.",
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
const boolean = { type: "boolean" };
const int = { type: "integer" };
const nonNegative = { ...int, minimum: 0 };
const positive = { ...int, exclusiveMinimum: 0 };
const schema = (properties: Record<string, unknown>, ...required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
export const OPENCODE_VERSION = "2.4.2";
export const OPENCODE_TOOLS = openCodeTools([
  { name: "edit", parameters: schema({ path: string, oldString: string, newString: string, replaceAll: boolean }, "path", "oldString", "newString") },
  { name: "glob", parameters: schema({ pattern: string, path: string, hidden: boolean, limit: positive }, "pattern") },
  { name: "grep", parameters: schema({ pattern: { ...string, minLength: 1 }, path: string, include: string, literal: boolean, caseSensitive: boolean, limit: positive }, "pattern") },
  { name: "read", parameters: schema({ path: string, offset: int, limit: nonNegative }, "path") },
  { name: "shell", parameters: schema({ command: string, workdir: string, timeout: nonNegative }, "command") },
  { name: "webfetch", parameters: schema({ url: string, format: { type: "string", enum: ["text", "markdown", "html"] }, timeout: { type: "number", exclusiveMinimum: 0, maximum: 120 } }, "url") },
  { name: "write", parameters: schema({ path: string, content: string }, "path", "content") },
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
  const bin = override || join(root, `cli-${OPENCODE_VERSION}`, process.platform === "win32" ? "opencode.exe" : "opencode");
  return isAbsolute(bin) && existsSync(bin) ? bin : undefined;
}

export function launchOpenCode(home: string, port: number, token: string) {
  // OpenCode only receives a synthetic tool relay turn; Pi owns the selected model and its prompt.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^OPENCODE_/i.test(key)) delete env[key];
  const provider = "pi-web";
  const config = {
    model: `${provider}/${token}`,
    plugins: ["-opencode.provider.*"],
    providers: { [provider]: { package: "@opencode/ai/providers/openai-compatible", name: "Pi Web", env: ["PI_WEB_OC_RELAY_KEY"], settings: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { [token]: { name: "Pi Web", limit: { context: 100_000, output: 10_000 } } } } },
    default_agent: "pi-web",
    agents: { "pi-web": { mode: "primary", system: OPENCODE_PREAMBLE } },
    permissions: [{ action: "external_directory", resource: "*", effect: "allow" }],
    autoupdate: false, share: "disabled", snapshot: false, formatter: false, lsp: false, warming: false,
  };
  return {
    args: ["run", "--standalone", "--agent", "pi-web", "--title", "Pi Web tool relay", "--format", "json", "Continue the Pi Web conversation."],
    env: {
      ...env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
      OPENCODE_TEST_HOME: home, OPENCODE_DB: ":memory:", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_FILEWATCHER_DISABLE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      PI_WEB_OC_RELAY_KEY: token, DO_NOT_TRACK: "1",
    },
  };
}
