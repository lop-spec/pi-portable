import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerAsyncCompaction } from "./upstream/src/core";
import { createBuiltinPiCompactionAdapter } from "./upstream/src/adapter";
import { applyReadyCompaction, buildAsyncCompactionResult, startAsyncJobWithDeps } from "./upstream/src/job";
import { prepareAsyncCompaction } from "./upstream/src/preparation";
import { getCompactionSettings, getThinkingLevel } from "./upstream/src/utils";
import { markStale } from "./upstream/src/runtime-state";
import { InvalidationReason } from "./upstream/src/constants";
import type { RuntimeState } from "./upstream/src/types";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIRST_JOB_MARKER = "lop-async-compaction-first-job-v1";
export interface Config {
  enabled: boolean;
  startTokens: number;
  thinkingLevel: "low";
  timeoutMs: number;
  firstToolCompaction: boolean;
}
export function parseConfig(value: unknown): Config {
  const x = value as Config;
  if (!x || typeof x.enabled !== "boolean" || !Number.isSafeInteger(x.startTokens) || x.startTokens <= 0 ||
      x.thinkingLevel !== "low" || !Number.isSafeInteger(x.timeoutMs) || x.timeoutMs <= 0 ||
      typeof x.firstToolCompaction !== "boolean") throw new Error("Invalid async compaction config; disabled rather than silently defaulting");
  return x;
}
export function readConfig(): Config {
  return parseConfig(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")));
}
export function startBlocker(usage: { tokens: number | null; contextWindow: number } | undefined,
    settings: { reserveTokens: number }, config: Config, first = false): string | undefined {
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return "context_unknown";
  if (!first && usage.tokens < config.startTokens) return "below_threshold";
  if (usage.tokens > usage.contextWindow - settings.reserveTokens) return "above_force_threshold";
  return undefined;
}
/** The active assistant tool-call message and everything after it must remain verbatim. */
export function completedPrefix(entries: SessionEntry[], toolCallId: string): SessionEntry[] {
  const index = entries.findIndex(e => e.type === "message" && e.message.role === "assistant" &&
    e.message.content.some(b => b.type === "toolCall" && b.id === toolCallId));
  if (index < 0) throw new Error("Active tool-call entry not persisted yet; cannot snapshot completed history");
  return entries.slice(0, index);
}
function writeLog(record: Record<string, unknown>): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record });
  try {
    const dir = path.resolve(ROOT, "../../data");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "lop-async-compaction.jsonl"), line + "\n");
  } catch (error) {
    console.warn("[lop-async-compaction] log-write-failed", String(error));
    console.warn(line);
  }
}

type Dependencies = Parameters<typeof startAsyncJobWithDeps>[2];
export function install(pi: ExtensionAPI, overrides: {
  config?: Config;
  log?: (record: Record<string, unknown>) => void;
  build?: typeof buildAsyncCompactionResult;
  settings?: typeof getCompactionSettings;
} = {}): void {
  const log = overrides.log ?? writeLog;
  let config: Config;
  try { config = overrides.config ? parseConfig(overrides.config) : readConfig(); }
  catch (error) { log({ event: "disabled", reason: String(error) }); return; }
  const settingsFor = overrides.settings ?? getCompactionSettings;
  const firstClaimed = new Map<string, boolean>();
  let toolCallId: string | undefined;
  let context: ExtensionContext | undefined;
  let state: RuntimeState | undefined;
  let previousSkip = "";
  const emit = (record: Record<string, unknown>) => log({ sessionId: context?.sessionManager.getSessionId(), ...record });
  const skip = (reason: string) => {
    const key = `${context?.sessionManager.getSessionId()}:${reason}`;
    if (key !== previousSkip) emit({ event: "skipped", reason });
    previousSkip = key;
  };
  function hasFirstClaim(ctx: ExtensionContext): boolean {
    const id = ctx.sessionManager.getSessionId();
    if (!firstClaimed.has(id)) firstClaimed.set(id, ctx.sessionManager.getEntries().some(e =>
      e.type === "custom" && e.customType === FIRST_JOB_MARKER));
    return firstClaimed.get(id)!;
  }
  const adapter = createBuiltinPiCompactionAdapter(async (preparation, model, ctx, _mainThinking, signal) => {
    if (!getSupportedThinkingLevels(model).includes("low")) throw new Error(`Model ${model.provider}/${model.id} does not support low; no fallback`);
    emit({ event: "request", model: `${model.provider}/${model.id}`, thinkingLevel: "low", tokensBefore: preparation.tokensBefore });
    const result = await (overrides.build ?? buildAsyncCompactionResult)(preparation, model, ctx, "low", signal);
    emit({ event: "summary", usage: result.usage });
    return result;
  });
  adapter.prepare = ({ ctx, settings }) => {
    if (!ctx.model) return undefined;
    const full = ctx.sessionManager.getBranch();
    let safe = full;
    if (toolCallId) {
      try { safe = completedPrefix(full, toolCallId); }
      catch (error) { skip(String(error)); return undefined; }
    }
    const preparation = prepareAsyncCompaction(safe, settings);
    const leaf = safe[safe.length - 1];
    if (!preparation || !leaf) return undefined;
    return { preparation, model: ctx.model, thinkingLevel: getThinkingLevel(full), snapshotLeafId: leaf.id };
  };
  function jobDeps(ctx: ExtensionContext): Dependencies {
    return {
      adapter,
      buildAsyncCompactionResult: overrides.build ?? buildAsyncCompactionResult,
      getCompactionSettings: settingsFor,
      getStartRatio: () => (config.startTokens - 1) / (ctx.model?.contextWindow || 1),
      getTimeoutMs: () => config.timeoutMs,
      isEnabled: () => config.enabled && process.env.PI_ASYNC_PREFIX_COMPACTION !== "0",
      setCliStatus: (c, key, text) => { if (c.hasUI) c.ui.setStatus(key, text); },
      setTimeout, clearTimeout,
      triggerCompaction: (c, onError) => c.compact({ onError }),
    };
  }
  // Pinned upstream owns all state, validation, native application and resume behavior.
  // Only its automatic start subscription is moved from turn_end to tool_execution_start.
  const facade = Object.create(pi) as ExtensionAPI;
  facade.on = ((event: string, handler: any) => {
    if (event !== "turn_end") return (pi.on as any)(event, handler);
    return pi.on("tool_execution_start", (event, ctx) => {
      context = ctx;
      toolCallId = event.toolCallId;
      try { return handler(event, ctx); }
      finally { toolCallId = undefined; }
    });
  }) as ExtensionAPI["on"];
  registerAsyncCompaction(facade, adapter, {
    commandName: "async-compact-now",
    onLifecycleEvent: event => emit({ ...event }),
  }, {
    startAsyncJob: (ctx, current, options = { force: false }) => {
      context = ctx;
      state = current;
      if (!config.enabled || process.env.PI_ASYNC_PREFIX_COMPACTION === "0") { skip("disabled"); return "disabled"; }
      const first = config.firstToolCompaction && !hasFirstClaim(ctx);
      if (!options.force) {
        const blocker = startBlocker(ctx.getContextUsage(), settingsFor(ctx), config, first);
        if (blocker) { skip(blocker); return blocker as any; }
      }
      const outcome = startAsyncJobWithDeps(ctx, current, jobDeps(ctx), { ...options, force: true });
      if (outcome === "started") {
        previousSkip = "";
        emit({ event: "trigger", reason: options.force ? "manual" : first ? "first-tool" : "128k-tool", startTokens: config.startTokens, contextTokens: ctx.getContextUsage()?.tokens });
        if (!hasFirstClaim(ctx)) {
          pi.appendEntry(FIRST_JOB_MARKER, { jobId: current.jobId, trigger: options.force ? "manual" : first ? "first-tool" : "128k-tool" });
          firstClaimed.set(ctx.sessionManager.getSessionId(), true);
        }
      } else if (outcome !== "ready_reused") skip(outcome);
      return outcome;
    },
    applyReadyCompaction: (ctx, current) => applyReadyCompaction(ctx, current, jobDeps(ctx)),
  });
  pi.on("session_start", (_event, ctx) => {
    if (state && (state.status === "pending" || state.status === "ready")) markStale(state, InvalidationReason.SESSION_CHANGED);
    context = ctx;
    emit({ event: "loaded", upstream: "0.1.8", ...config, nativeCompaction: settingsFor(ctx) });
  });
  pi.on("session_before_compact", (event, ctx) => {
    context = ctx;
    if (!state?.lastHandedOff) emit({ event: "native-fallback", reason: event.customInstructions?.trim() ? "custom-instructions" : "no-valid-ready-summary", nativeReason: event.reason });
  });
  pi.on("session_compact", (event, ctx) => {
    context = ctx;
    const details = event.compactionEntry.details;
    if (details && typeof details === "object" && "asyncPrefixCompaction" in details) emit({ event: "persisted", compactionId: event.compactionEntry.id, fromExtension: event.fromExtension });
  });
  pi.registerCommand("async-compact-status", {
    description: "Show tool-phase async compaction settings/state (no model request)",
    handler: async (_args, ctx) => {
      const text = JSON.stringify({ ...config, status: state?.status ?? "idle", firstJobStarted: hasFirstClaim(ctx), nativeCompaction: settingsFor(ctx) });
      if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
    },
  });
}
export default function extension(pi: ExtensionAPI): void { install(pi); }
