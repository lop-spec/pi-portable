// Cline as a second agent inside a Pi session.
//
// The session, model, transcript, compaction and every Pi extension tool stay Pi's. A
// Cline run swaps two things for its duration: the system prompt becomes Cline's own
// (followed by Pi's project context, skills and extension sections), and Pi's file and
// shell tools give way to Cline's, each one a proxy that the Cline process executes.
// Because nothing else changes, the agent can be chosen again for every run.
import { getAgentDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { ClineTurn, resolveClineBinary, type ClineToolSpec } from "./cline-bridge";

export const CLINE_AGENT_EXTENSION_NAME = "pi-web-cline-agent";

export type ClineAgent = {
  extension: InlineExtension;
  /** Applies from the next run; a run in progress keeps the agent it started with. */
  setAgent(agent: unknown): void;
};

const LOADOUT_ENTRY = "pi-web-cline-agent";
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

export function createClineAgent(cwd: string): ClineAgent {
  let agent: "pi" | "cline" = "pi";
  let turn: ClineTurn | null = null;
  let running = false;
  let piLoadout: string[] | null = null;
  let savedLoadout = "";
  const proxies = new Map<string, string>();

  const startTurn = async (): Promise<ClineTurn> => {
    const bin = resolveClineBinary(clineDir());
    if (!bin) throw new Error("未安装 Cline CLI");
    turn?.dispose();
    turn = await ClineTurn.start({ bin, cwd, homeDir: join(clineDir(), "home"), requestTimeoutMs: REQUEST_TIMEOUT_MS });
    return turn;
  };

  return {
    setAgent(value) {
      agent = value === "cline" && isClineAgentInstalled() ? "cline" : "pi";
    },
    extension: {
      name: CLINE_AGENT_EXTENSION_NAME,
      hidden: true,
      factory: (pi) => {
        const registerProxies = (tools: ClineToolSpec[]) => {
          const taken = new Set(pi.getAllTools().map((tool) => tool.name).filter((name) => !proxies.has(name)));
          for (const spec of tools) {
            if (CLINE_TERMINAL_TOOLS.test(spec.name) || taken.has(spec.name)) continue;
            const declaration = JSON.stringify(spec);
            if (proxies.get(spec.name) === declaration) continue;
            proxies.set(spec.name, declaration);
            pi.registerTool({
              name: spec.name,
              label: spec.name,
              description: spec.description,
              parameters: spec.parameters as never,
              async execute(toolCallId, params, signal) {
                if (!turn) throw new Error("Cline 未在运行");
                const text = await turn.callTool(toolCallId, spec.name, params, signal);
                return { content: [{ type: "text", text }], details: undefined };
              },
            });
          }
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
          if (agent !== "cline") {
            const active = pi.getActiveTools();
            const own = active.filter((name) => !proxies.has(name));
            if (own.length !== active.length) pi.setActiveTools(own);
            return undefined;
          }
          let started: ClineTurn;
          try {
            started = await startTurn();
          } catch (error) {
            ctx.ui.notify(`Cline 启动失败，本轮改用 Pi：${error instanceof Error ? error.message : String(error)}`, "error");
            return undefined;
          }
          registerProxies(started.tools);
          piLoadout = pi.getActiveTools().filter((name) => !proxies.has(name));
          const loadout = JSON.stringify(piLoadout);
          if (loadout !== savedLoadout) {
            pi.appendEntry(LOADOUT_ENTRY, { piTools: piLoadout });
            savedLoadout = loadout;
          }
          pi.setActiveTools([...piLoadout.filter((name) => !PI_CODING_TOOLS.has(name)), ...proxies.keys()]);
          running = true;

          // Render with Pi's own builder: Cline's prompt takes the preamble, Pi's harness
          // sections drop out, and context files, skills and extension sections follow.
          // The options are put back so the transcript keeps recording Pi's prompt.
          const options = event.systemPromptOptions;
          const { customPrompt, selectedTools, forceSystemPrompt } = options;
          options.customPrompt = started.system;
          options.selectedTools = ["read"];
          options.forceSystemPrompt = undefined;
          const systemPrompt = event.systemPrompt;
          Object.assign(options, { customPrompt, selectedTools, forceSystemPrompt });
          return { systemPrompt };
        });

        // Before every model call Cline must have a request waiting for the answer. It
        // already has one except after a retry or a follow-up, when the previous process
        // has its final answer; the transcript holds all state, so a new process carries on.
        pi.on("context", async (_event, ctx) => {
          const signal = ctx.signal;
          if (!running || signal?.aborted) return undefined;
          try {
            if (turn?.alive) {
              try {
                await turn.whenOpen(REQUEST_TIMEOUT_MS, signal);
                return undefined;
              } catch {
                // Fall through to a fresh process.
              }
            }
            if (signal?.aborted) return undefined;
            await startTurn();
          } catch (error) {
            ctx.ui.notify(`Cline 无法继续：${error instanceof Error ? error.message : String(error)}`, "error");
            ctx.abort();
          }
          return undefined;
        });

        pi.on("message_update", (event) => {
          if (running && event.assistantMessageEvent.type === "text_delta") turn?.text(event.assistantMessageEvent.delta);
        });

        pi.on("agent_end", () => {
          if (running) turn?.finish();
        });

        pi.on("agent_settled", () => {
          if (!running) return;
          running = false;
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
