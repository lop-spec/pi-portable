// Request-local Codex policy. Never rewrite effort, drop transcript items, or add messages.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REASONING_CONTEXT_POLICY_VERSION = "codex-current-turn-v2-global";
// lop 2026-10-30：全局默认 current_turn。v1 只覆盖四个模型，默认模型 gpt-6.1-terra 因此每次请求都带回以前各轮推理。
export const REASONING_CONTEXT_MODELS = "all-codex-responses";
const APIS = new Set(["openai-codex-responses", "openai-responses"]);
const PROVIDERS = new Set(["openai-codex", "codex-bridge"]);
type ModelIdentity = { api: string; provider: string; id: string };
type Payload = Record<string, unknown>;
type PayloadHook = (payload: unknown, model?: any) => unknown | Promise<unknown>;
const object = (value: unknown): value is Payload => !!value && typeof value === "object" && !Array.isArray(value);

/** Fill only an unspecified/auto scope on every Codex Responses model.
 * Explicit current_turn/all_turns choices and every unrelated field stay untouched. */
export function applyReasoningContextPolicy(model: ModelIdentity | undefined, payload: unknown) {
  if (!model || !APIS.has(model.api) || !PROVIDERS.has(model.provider) || !object(payload)
      || typeof payload.model !== "string" || !object(payload.reasoning)) {
    return { payload, changed: false };
  }
  const previous = payload.reasoning.context;
  if (previous !== undefined && previous !== "auto") return { payload, changed: false };
  return {
    payload: { ...payload, reasoning: { ...payload.reasoning, context: "current_turn" } },
    changed: true,
    previous: previous ?? "omitted",
  };
}

/** Side-channel summaries bypass AgentSession's main-request hook. Apply the same
 * policy before prefix validation and preserve the caller's onPayload exactly once. */
export function withReasoningContextPolicy(model: ModelIdentity, previous?: PayloadHook): PayloadHook {
  return async (payload, requestModel) => {
    const identity = requestModel ?? model;
    const first = applyReasoningContextPolicy(identity, payload).payload;
    const changed = previous ? await previous(first, requestModel) : undefined;
    return applyReasoningContextPolicy(identity, changed === undefined ? first : changed).payload;
  };
}

export function installReasoningContextPolicy(pi: ExtensionAPI, log: (record: Record<string, unknown>) => void): void {
  pi.on("session_start", (_event, ctx) => log({
    event: "reasoning-context-policy-loaded", version: REASONING_CONTEXT_POLICY_VERSION,
    sessionId: ctx.sessionManager.getSessionId(), defaultContext: "current_turn", models: REASONING_CONTEXT_MODELS,
  }));
  pi.on("before_provider_request", (event, ctx) => {
    const result = applyReasoningContextPolicy(ctx.model, event.payload);
    if (!result.changed) return undefined;
    const payload = result.payload as Payload;
    const reasoning = payload.reasoning as Payload;
    log({ event: "reasoning-context-applied", version: REASONING_CONTEXT_POLICY_VERSION,
      sessionId: ctx.sessionManager.getSessionId(), model: payload.model,
      from: result.previous, to: "current_turn", effort: reasoning.effort });
    return result.payload;
  });
}
