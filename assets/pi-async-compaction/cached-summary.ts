// Full-transcript background summaries. The original provider payload is only held in memory.
// Never execute returned tools, persist prompts, change cache retention, or share a main-run WS.
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import { buildSessionProjection, convertToLlm, type CompactionResult, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LocalCompactionPreparation } from "./upstream/src/types";
import { withReasoningContextPolicy } from "./reasoning-context";
import { getThinkingLevel } from "./upstream/src/utils";

export const CACHED_SUMMARY_VERSION = "full-prefix-v2";
const MAX_COMPLETED_RESPONSE_AGE_MS = 60_000; // local freshness since completion, NOT a provider TTL claim
const SUPPORTED_APIS = new Set(["openai-codex-responses", "openai-responses", "openai-completions", "anthropic-messages"]);
type Payload = Record<string, unknown>;
type Log = (record: Record<string, unknown>) => void;
const object = (v: unknown): v is Payload => !!v && typeof v === "object" && !Array.isArray(v);
const canonical = (v: unknown) => JSON.stringify(v, (key, value) => key === "cache_control" ? undefined : value);
const messagesKey = (p: Payload) => Array.isArray(p.input) ? "input" : Array.isArray(p.messages) ? "messages" : undefined;
const outputKeys = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"]);

/** No exception for reasoning/effort: changing it really invalidates Codex's cache.
 * Missing extension-added fields may be inherited, but an explicitly different field cannot. */
export function checkedSummaryPayload(captured: Payload, rebuilt: unknown): Payload {
  if (!object(rebuilt)) throw Error("payload_not_object");
  const key = messagesKey(captured);
  if (!key || !Array.isArray(rebuilt[key])) throw Error("unsupported_payload");
  const payload = { ...captured, ...rebuilt };
  for (const field of new Set([...Object.keys(captured), ...Object.keys(payload)])) {
    if (field === key || outputKeys.has(field)) continue;
    if (canonical(captured[field]) !== canonical(payload[field])) throw Error(`prefix_field_changed:${field}`);
  }
  const before = captured[key] as unknown[], after = payload[key] as unknown[];
  if (after.length <= before.length) throw Error("prefix_not_extended");
  for (let i = 0; i < before.length; i++) {
    if (canonical(before[i]) !== canonical(after[i])) throw Error(`prefix_message_changed:${i}`);
  }
  return payload;
}

function projected(entries: SessionEntry[]) {
  return buildSessionProjection(entries).entries.map(e => ({ id: e.sourceEntry.id, messages: convertToLlm(e.messages) })).filter(e => e.messages.length > 0);
}
function preview(message: ReturnType<typeof convertToLlm>[number]): string | undefined {
  const text = message.role === "user" ? contentText(message.content)
    : message.role === "assistant" ? message.content.map(b => b.type === "text" ? b.text : b.type === "toolCall" ? `[tool call: ${b.name} ${JSON.stringify(b.arguments)}]` : "").filter(Boolean).join("\n") : "";
  return text.trim().slice(0, 400) || undefined;
}
export function cachedSummaryInstruction(kept: string, occurrenceFromEnd: number, keptCount: number, policy: string): string {
  return `Stop working on the task. Do not call any tools. Return ONLY a structured context checkpoint for another LLM to continue the work.
Summarize ONLY the earlier conversation BEFORE the first kept message identified below. The last ${keptCount} messages remain verbatim after your summary. Treat everything from that kept message onwards as not yet happened: do not report its work as completed. If the excerpt occurs more than once, choose occurrence ${occurrenceFromEnd} counting backwards from the end.
<kept-start>
${kept}
</kept-start>
Fold any previous checkpoint into the new one. Preserve its still-relevant facts, constraints, unresolved work, and exact identifiers. Use these headings:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

${policy}

Return the checkpoint only. Do not include file-list XML; the host appends the exact tracked lists. Do not continue the task or call tools.`;
}

interface Capture {
  session: string;
  model: Model<Api>;
  at: number;
  completedAt?: number;
  transcript: AgentMessage[];
  sources: ReturnType<typeof projected>;
  payload: Payload;
  warm: boolean;
}
interface Candidate {
  capture: Capture;
  messages: AgentMessage[];
  instruction: string;
}

export class CachedSummary {
  private pending?: Omit<Capture, "payload" | "warm">;
  private captured?: Capture;
  private requestThinking?: { session: string; provider: string; model: string; level: ThinkingLevel };
  private candidates = new WeakMap<LocalCompactionPreparation, Candidate | string>();
  constructor(pi: ExtensionAPI, private policy: string, private log: Log, private enabled = true) {
    pi.on("context_with_system", (event, ctx) => {
      this.pending = undefined;
      this.requestThinking = ctx.model ? { session: ctx.sessionManager.getSessionId(), provider: ctx.model.provider, model: ctx.model.id,
        level: ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? getThinkingLevel(ctx.sessionManager.getBranch()) } : undefined;
      if (!this.enabled || !ctx.model || !SUPPORTED_APIS.has(ctx.model.api)) return;
      // Snapshot before any await: later tools/main turns must not move this job's boundary.
      this.pending = { session: ctx.sessionManager.getSessionId(), model: ctx.model, at: Date.now(),
        transcript: structuredClone(event.messages), sources: structuredClone(projected(ctx.sessionManager.getBranch())) };
    });
    pi.on("before_provider_request", event => {
      const pending = this.pending;
      this.pending = undefined;
      this.captured = pending && object(event.payload) && messagesKey(event.payload)
        ? { ...pending, payload: structuredClone(event.payload), warm: false } : undefined;
    });
    pi.on("message_end", event => {
      const capture = this.captured, message = event.message;
      if (!capture || message.role !== "assistant" || message.provider !== capture.model.provider || message.model !== capture.model.id) return;
      capture.warm = message.stopReason !== "error" && message.stopReason !== "aborted" && (message.usage.cacheRead + message.usage.cacheWrite > 0);
      capture.completedAt = capture.warm ? Date.now() : undefined;
    });
    const forget = () => { this.pending = this.captured = this.requestThinking = undefined; this.candidates = new WeakMap(); };
    for (const event of ["session_start", "session_compact", "model_select", "session_tree", "session_shutdown"] as const) pi.on(event, forget);
  }
  /** Request-time selection, not a later main-session selection; available even without a warm cache. */
  thinkingLevel(ctx: ExtensionContext): ThinkingLevel | undefined {
    const request = this.requestThinking;
    return request && request.session === ctx.sessionManager.getSessionId() && request.provider === ctx.model?.provider && request.model === ctx.model?.id
      ? request.level : undefined;
  }
  prepare(preparation: LocalCompactionPreparation, entries: SessionEntry[], ctx: ExtensionContext): void {
    let result: Candidate | string;
    try {
      const capture = this.captured;
      if (!this.enabled) throw Error("disabled");
      if (!capture) throw Error("no_captured_request");
      if (capture.session !== ctx.sessionManager.getSessionId() || capture.model.provider !== ctx.model?.provider || capture.model.id !== ctx.model?.id) throw Error("session_or_model_changed");
      if (!capture.warm) throw Error("last_request_not_cached");
      if (capture.completedAt === undefined || Date.now() - capture.completedAt > MAX_COMPLETED_RESPONSE_AGE_MS) throw Error("capture_too_old");
      // Provider-declared TTL remains measured conservatively from request capture.
      const ttl = capture.model.promptCache?.[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
      if (ttl !== undefined && Date.now() - capture.at >= ttl * 1000) throw Error("declared_cache_expired");
      const sources = projected(entries), before = capture.sources;
      if (sources.length < before.length || before.some((s, i) => canonical(s) !== canonical(sources[i]))) throw Error("source_projection_changed");
      // A context extension that omitted/rewrote old source messages cannot summarize them reliably.
      const actual = convertToLlm(capture.transcript).filter(m => m.role !== "system");
      if (canonical(actual) !== canonical(before.flatMap(s => s.messages).filter(m => m.role !== "system"))) throw Error("context_projection_differs");
      const messages: AgentMessage[] = [...capture.transcript, ...sources.slice(before.length).flatMap(s => s.messages)];
      const cut = sources.findIndex(s => s.id === preparation.firstKeptEntryId);
      if (cut < 0) throw Error("kept_boundary_missing");
      const kept = sources.slice(cut).flatMap(s => s.messages), text = preview(kept[0]);
      if (!text) throw Error("kept_boundary_not_textual");
      const repeats = kept.filter(m => preview(m) === text).length;
      result = { capture, messages, instruction: cachedSummaryInstruction(text, repeats, kept.length, this.policy) };
    } catch (error) { result = error instanceof Error ? error.message : "capture_validation_failed"; }
    this.candidates.set(preparation, result);
  }
  async run(preparation: LocalCompactionPreparation, model: Model<Api>, ctx: ExtensionContext, level: ThinkingLevel, signal: AbortSignal): Promise<CompactionResult | undefined> {
    const candidate = this.candidates.get(preparation);
    this.candidates.delete(preparation);
    const skip = (reason: string) => { this.log({ event: "cached-summary-fallback", version: CACHED_SUMMARY_VERSION, reason, thinkingLevel: level }); return undefined; };
    if (!candidate || typeof candidate === "string") return skip(candidate ?? "not_prepared");
    if (model.provider !== candidate.capture.model.provider || model.id !== candidate.capture.model.id) return skip("summary_model_differs");
    if (signal.aborted) return undefined;
    const room = model.contextWindow > 0
      ? model.contextWindow - Math.max(preparation.tokensBefore, 0) - 4096
      : Number.POSITIVE_INFINITY;
    if (room < 4096) return skip("insufficient_summary_headroom");
    const maxTokens = Math.min(model.maxTokens > 0 ? model.maxTokens : 16384, room);
    let verified = false, rejected: string | undefined;
    const started = Date.now();
    try {
      const response = await ctx.modelRegistry.streamSimple(model, { messages: convertToLlm([...candidate.messages, {
        role: "user", content: candidate.instruction, timestamp: Date.now(),
      }]) }, {
        reasoning: level === "off" ? undefined : level, signal,
        sessionId: model.provider === "openai-codex" ? `${candidate.capture.session}:summary` : candidate.capture.session,
        // Separate WS lane cannot mutate the main run's continuation/response id.
        transport: model.provider === "openai-codex" ? "auto" : "sse", maxTokens, maxRetries: 0,
        onPayload: withReasoningContextPolicy(model, payload => {
          try {
            // WS connection identity is separate; the server-side prefix cache key stays exactly the captured key.
            const rebuilt = model.provider === "openai-codex" && object(payload)
              ? { ...payload, prompt_cache_key: candidate.capture.payload.prompt_cache_key } : payload;
            const checked = checkedSummaryPayload(candidate.capture.payload, rebuilt); verified = true; return checked;
          }
          catch (error) { rejected = error instanceof Error ? error.message : "prefix_validation_failed"; throw Error("cached-summary prefix rejected"); }
        }),
      }).result();
      if (signal.aborted || response.stopReason === "aborted") return undefined;
      if (rejected) return skip(rejected);
      if (!verified) return skip("provider_did_not_validate_payload");
      if (response.stopReason !== "stop" || response.content.some(b => b.type === "toolCall")) return skip(`summary_${response.stopReason}`);
      const text = contentText(response.content).trim();
      if (!text) return skip("empty_summary");
      const readFiles = [...preparation.fileOps.read].filter(p => !preparation.fileOps.written.has(p) && !preparation.fileOps.edited.has(p)).sort();
      const modifiedFiles = [...new Set([...preparation.fileOps.written, ...preparation.fileOps.edited])].sort();
      const summary = [text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim(),
        readFiles.length ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
        modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : ""].filter(Boolean).join("\n\n");
      const total = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
      this.log({ event: "cached-summary-result", version: CACHED_SUMMARY_VERSION, thinkingLevel: level, durationMs: Date.now() - started,
        prefixVerified: true, cacheHit: response.usage.cacheRead > 0, cacheReadRatio: total ? response.usage.cacheRead / total : 0, usage: response.usage });
      return { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
        usage: response.usage, details: { readFiles, modifiedFiles, cachedSummary: { version: CACHED_SUMMARY_VERSION, prefixVerified: true, thinkingLevel: level, cacheRead: response.usage.cacheRead } } };
    } catch {
      if (signal.aborted) return undefined;
      return skip(rejected ?? "summary_request_failed"); // no raw exception/prompt fragments in logs
    }
  }
}
