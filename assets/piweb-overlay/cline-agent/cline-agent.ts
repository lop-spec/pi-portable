// Cline as a second agent inside a Pi session.
//
// The session, model, transcript, compaction and every Pi extension tool stay Pi's. A
// Cline run swaps two things for its duration: the system prompt becomes Cline's own
// (followed by Pi's project context, skills and extension sections), and Pi's file and
// shell tools give way to Cline's, each one a proxy that the Cline process executes.
// Because nothing else changes, the agent can be chosen again for every run.
import { getAgentDir, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { CLINE_STOPPED, ClineTurn, resolveClineBinary, type ClineToolSpec } from "./cline-bridge";
import { promptCacheKey, readPrompt, writePrompt, type ClinePrompt } from "./cline-prompt-cache";
import { launchOpenCode, OPENCODE_PREAMBLE, OPENCODE_TOOLS, resolveOpenCodeBinary } from "./opencode-launch";

export const CLINE_AGENT_EXTENSION_NAME = "pi-web-cline-agent";

export type ClineAgent = {
  extension: InlineExtension;
  /** Applies from the next run; a run in progress keeps the agent it started with. */
  setAgent(agent: unknown): void;
};

const LOADOUT_ENTRY = "pi-web-cline-agent";
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
// Cline's prompt is written for its own file and shell tools, so Pi's stand down.
const PI_CODING_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
// These need Cline's terminal or start agents Pi cannot see; Pi's own ask and
// subagent tools stay available instead.
const CLINE_TERMINAL_TOOLS = /^(ask_question|spawn_agent|submit_and_exit|team_.+)$/;

function clineDir(): string {
  return join(getAgentDir(), "cline-agent");
}

export function isClineAgentInstalled(): boolean {
  return resolveClineBinary(clineDir()) !== undefined;
}

function openCodeDir(): string {
  return join(getAgentDir(), "opencode-agent");
}

export function isOpenCodeAgentInstalled(): boolean {
  return resolveOpenCodeBinary(openCodeDir()) !== undefined;
}

type DelegatedAgent = "cline" | "opencode";

export function createClineAgent(cwd: string): ClineAgent {
  let agent: "pi" | DelegatedAgent = "pi";
  let turn: ClineTurn | null = null;
  let running: DelegatedAgent | null = null;
  let piLoadout: string[] | null = null;
  let savedLoadout = "";
  const proxies = new Map<string, string>();

  const binary = (mode: DelegatedAgent): string => {
    const bin = mode === "opencode" ? resolveOpenCodeBinary(openCodeDir()) : resolveClineBinary(clineDir());
    if (!bin) throw new Error(`未安装 ${mode === "opencode" ? "OpenCode" : "Cline"} CLI`);
    return bin;
  };
  // Returns at once; the process can start while the model is already working.
  const launch = (mode: DelegatedAgent): ClineTurn => {
    turn?.dispose();
    const opts = { bin: binary(mode), cwd, startTimeoutMs: START_TIMEOUT_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS };
    if (mode === "opencode") {
      const homeDir = join(openCodeDir(), "home");
      return (turn = ClineTurn.create({ ...opts, homeDir, label: "OpenCode", systemMarker: OPENCODE_PREAMBLE,
        worker: (port, token) => launchOpenCode(homeDir, port, token) }));
    }
    return (turn = ClineTurn.create({ ...opts, homeDir: join(clineDir(), "home") }));
  };
  const ensureTurn = (): ClineTurn => {
    if (!running) throw new Error("Agent turn inactive");
    return turn?.alive ? turn : launch(running);
  };

  // Cline's prompt and tools for this run, starting its process on the way. A saved copy
  // lets the model call begin at once; without one (first use in this directory, or a new
  // Cline build) the run waits for the process to say what they are.
  const promptForRun = async (ctx: ExtensionContext): Promise<ClinePrompt | undefined> => {
    const dir = join(clineDir(), "prompt-cache");
    try {
      const key = promptCacheKey(binary("cline"), cwd);
      const started = launch("cline");
      const saved = readPrompt(dir, key);
      if (saved) {
        // What the process reports replaces the saved copy for the next run.
        void started.whenOpen(START_TIMEOUT_MS).then(
          () => writePrompt(dir, key, { system: started.system, tools: started.tools }),
          (error: Error) => {
            // A process we stopped ourselves (the run needed no tool, or was stopped) is not a failure.
            if (error.message === CLINE_STOPPED || !running || turn !== started) return;
            try {
              ctx.ui.notify(`Cline 启动失败：${error.message}`, "error");
            } catch (cause) {
              console.error("[pi-web] Cline start failure not reported:", cause);
            }
          },
        );
        return saved;
      }
      await started.whenOpen(START_TIMEOUT_MS);
      const fresh = { system: started.system, tools: started.tools };
      writePrompt(dir, key, fresh);
      return fresh;
    } catch (error) {
      turn?.dispose();
      ctx.ui.notify(`Cline 启动失败，本轮改用 Pi：${error instanceof Error ? error.message : String(error)}`, "error");
      return undefined;
    }
  };

  return {
    setAgent(value) {
      if (value === "opencode" && !isOpenCodeAgentInstalled()) throw new Error("未安装 OpenCode CLI，请切换 Agent 或安装后重试。");
      agent = value === "opencode" ? "opencode" : value === "cline" && isClineAgentInstalled() ? "cline" : "pi";
    },
    extension: {
      name: CLINE_AGENT_EXTENSION_NAME,
      hidden: true,
      factory: (pi) => {
        const registerProxies = (mode: DelegatedAgent, tools: ClineToolSpec[]) => {
          const taken = new Set(pi.getAllTools().map((tool) => tool.name).filter((name) => !proxies.has(name)));
          const active: string[] = [];
          for (const spec of tools) {
            const name = mode === "opencode" ? `oc_${spec.name}` : spec.name;
            if (CLINE_TERMINAL_TOOLS.test(name) || taken.has(name)) continue;
            active.push(name);
            const declaration = JSON.stringify(spec);
            if (proxies.get(name) === declaration) continue;
            proxies.set(name, declaration);
            pi.registerTool({
              name,
              label: name,
              description: ({
                read_files: "Read absolute paths together; optional inclusive line ranges.",
                search_codebase: "Search workspace by regex; batch independent queries.",
                run_commands: "Run noninteractive PowerShell commands from the workspace. Quote literal paths; confirm exact targets before recursive or forced deletion.",
                fetch_web_content: "Fetch URLs with extraction prompts; batch independent requests.",
                editor: "Create, replace one exact match, or insert before a 1-based line. Use absolute paths.",
              } as Record<string, string>)[spec.name] ?? spec.description,
              parameters: spec.parameters as never,
              async execute(toolCallId, params, signal) {
                if (running !== mode) throw new Error("Agent tool inactive");
                const text = await ensureTurn().callTool(toolCallId, spec.name, params, signal);
                return { content: [{ type: "text", text }], details: undefined };
              },
            });
          }
          return active;
        };

        // A session restored after a Cline run comes back with the tools its transcript
        // last declared, which no longer include Pi's own. Put the saved ones back.
        pi.on("session_start", (_event, ctx) => {
          const saved = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === LOADOUT_ENTRY);
          const tools = saved?.type === "custom" ? (saved.data as { piTools?: string[] } | undefined)?.piTools : undefined;
          if (!Array.isArray(tools)) return;
          savedLoadout = JSON.stringify(tools);
          const lostPiTools = !pi.getActiveTools().some((name) => PI_CODING_TOOLS.has(name)) && tools.some((name) => PI_CODING_TOOLS.has(name));
          if (lostPiTools) pi.setActiveTools(tools);
        });

        pi.on("before_agent_start", async (event, ctx) => {
          const mode = agent;
          if (mode === "pi") {
            const active = pi.getActiveTools();
            const own = active.filter((name) => !proxies.has(name) && !name.startsWith("oc_"));
            if (own.length !== active.length) pi.setActiveTools(own);
            return undefined;
          }
          const tools = mode === "opencode" ? OPENCODE_TOOLS : (await promptForRun(ctx))?.tools;
          if (!tools) return undefined;
          const activeProxies = registerProxies(mode, tools);
          piLoadout = pi.getActiveTools().filter((name) => !proxies.has(name) && !name.startsWith("oc_"));
          const loadout = JSON.stringify(piLoadout);
          if (loadout !== savedLoadout) {
            pi.appendEntry(LOADOUT_ENTRY, { piTools: piLoadout });
            savedLoadout = loadout;
          }
          pi.setActiveTools([...piLoadout.filter((name) => !PI_CODING_TOOLS.has(name)), ...activeProxies]);
          if (mode === "opencode") {
            turn?.dispose();
            turn = null;
          }
          running = mode;

          // Replace only the harness preamble; retain project rules, skills and extension sections.
          const options = event.systemPromptOptions;
          const { customPrompt, selectedTools, forceSystemPrompt } = options;
          options.customPrompt = mode === "opencode" ? OPENCODE_PREAMBLE : "Run independent tool calls in parallel.";
          options.selectedTools = ["read"];
          options.forceSystemPrompt = undefined;
          const rendered = event.systemPrompt;
          Object.assign(options, { customPrompt, selectedTools, forceSystemPrompt });
          const systemPrompt = mode === "opencode" ? rendered.replace("Use the read tool to load a skill's file", "Use oc_read to load a skill's file") : rendered;
          return { systemPrompt };
        });

        // A retry or a follow-up arrives after the previous process was given its final
        // answer. The transcript holds all state, so a new process carries on; it starts
        // here, behind the model call that is about to be made.
        pi.on("context", (_event, ctx) => {
          if (running !== "cline" || ctx.signal?.aborted) return undefined;
          try {
            ensureTurn();
          } catch (error) {
            ctx.ui.notify(`Cline 无法继续：${error instanceof Error ? error.message : String(error)}`, "error");
            ctx.abort();
          }
          return undefined;
        });

        pi.on("message_update", (event) => {
          if (running === "cline" && event.assistantMessageEvent.type === "text_delta") turn?.text(event.assistantMessageEvent.delta);
        });

        pi.on("agent_end", () => {
          if (running) turn?.finish();
        });

        pi.on("agent_settled", () => {
          if (!running) return;
          running = null;
          turn?.finish();
          if (piLoadout) pi.setActiveTools(piLoadout);
          piLoadout = null;
        });

        pi.on("session_shutdown", () => {
          turn?.dispose();
          turn = null;
        });
      },
    },
  };
}
