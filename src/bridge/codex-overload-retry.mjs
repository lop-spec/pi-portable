import { StringDecoder } from "node:string_decoder";

export const OVERLOAD_CODE = "server_is_overloaded";
export const OVERLOAD_MESSAGE = "Our servers are currently overloaded. Please try again later.";

const HOLD_EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
]);

/** Build byte payloads for bounded, explicit model-pool fallback attempts. */
export function createModelFallbackPlan(body, options = {}) {
  const original = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const configuredPrimary = String(options.primaryModel || "");
  let payload;
  try { payload = JSON.parse(original.toString("utf8")); }
  catch {
    return {
      primaryModel: "",
      models: [],
      payloadForAttempt: () => ({ model: "", body: original, fallback: false }),
    };
  }
  const requestedModel = String(payload?.model || "");
  const fallbacks = Array.isArray(options.fallbackModels)
    ? options.fallbackModels.map((model) => String(model).trim()).filter(Boolean)
    : [];
  const models = requestedModel === configuredPrimary
    ? [requestedModel, ...fallbacks.filter((model, index) => model !== requestedModel && fallbacks.indexOf(model) === index)]
    : (requestedModel ? [requestedModel] : []);
  const cache = new Map();
  if (requestedModel) cache.set(requestedModel, original);
  return {
    primaryModel: requestedModel,
    models,
    payloadForAttempt(attempt) {
      if (models.length === 0) return { model: "", body: original, fallback: false };
      const index = Math.max(0, Math.min(models.length - 1, Math.trunc(Number(attempt) || 0)));
      const model = models[index];
      if (!cache.has(model)) cache.set(model, Buffer.from(JSON.stringify({ ...payload, model })));
      return { model, body: cache.get(model), fallback: model !== requestedModel };
    },
  };
}

function eventPayload(frame) {
  let eventName = "";
  const data = [];
  for (const rawLine of String(frame).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return { eventName, payload: null, empty: true };
  const rawData = data.join("\n");
  if (rawData === "[DONE]") return { eventName, payload: { type: "done" }, empty: false };
  try { return { eventName, payload: JSON.parse(rawData), empty: false }; }
  catch { return { eventName, payload: null, empty: false, malformed: true }; }
}

/**
 * Classify one complete SSE frame. Only the captured structured overload code,
 * or its exact legacy message on a terminal error event, is retryable.
 */
export function classifySseFrame(frame) {
  const { eventName, payload, empty, malformed } = eventPayload(frame);
  if (empty) return { action: "hold", type: eventName || "comment" };
  if (malformed || !payload || typeof payload !== "object") {
    return { action: "forward", type: eventName || "unknown", reason: "malformed-or-unknown" };
  }

  const type = String(payload.type || eventName || "");
  const error = payload.error || payload.response?.error || null;
  const code = String(error?.code || payload.code || "");
  const message = String(error?.message || payload.message || "");
  const terminalError = type === "error" || type === "response.failed";
  if (code === OVERLOAD_CODE || (terminalError && message === OVERLOAD_MESSAGE)) {
    return { action: "retry", type, code: code || OVERLOAD_CODE, message };
  }
  if (HOLD_EVENT_TYPES.has(type)) return { action: "hold", type };
  return { action: "forward", type, reason: "meaningful-event" };
}

function takeFrame(text) {
  const boundary = /\r?\n\r?\n/.exec(text);
  if (!boundary) return null;
  return {
    frame: text.slice(0, boundary.index),
    rest: text.slice(boundary.index + boundary[0].length),
  };
}

/**
 * Hold only the neutral Responses prefix. The first meaningful event commits
 * the stream byte-for-byte; an overload before that point is safe to retry.
 */
export function gateSsePrefix(stream, { maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const chunks = [];
    let scan = "";
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!stream.readableEnded) stream.pause();
      resolve({ ...result, chunks, bytes });
    };
    const processFrames = (flushTrailing = false) => {
      for (;;) {
        const next = takeFrame(scan);
        if (!next) break;
        scan = next.rest;
        const classified = classifySseFrame(next.frame);
        if (classified.action === "retry") {
          finish({ decision: "retry", reason: "upstream-overload", error: classified });
          return true;
        }
        if (classified.action === "forward") {
          finish({ decision: "forward", reason: classified.reason || "meaningful-event" });
          return true;
        }
      }
      if (flushTrailing && scan.trim()) {
        const classified = classifySseFrame(scan);
        if (classified.action === "retry") {
          finish({ decision: "retry", reason: "upstream-overload", error: classified });
          return true;
        }
        if (classified.action === "forward") {
          finish({ decision: "forward", reason: classified.reason || "meaningful-event" });
          return true;
        }
      }
      return false;
    };
    function onData(chunk) {
      const data = Buffer.from(chunk);
      chunks.push(data);
      bytes += data.length;
      scan += decoder.write(data);
      if (processFrames()) return;
      if (bytes > maxBytes) finish({ decision: "forward", reason: "prefix-limit" });
    }
    function onEnd() {
      scan += decoder.end();
      if (!processFrames(true)) finish({ decision: "forward", reason: "stream-end" });
    }
    function onError(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function isSseResponse(response) {
  const contentType = String(response?.headers?.["content-type"] || "").toLowerCase();
  // ChatGPT Codex 的真实 200 SSE 不带 Content-Type；明确的其它类型仍快速旁路。
  return response?.statusCode === 200 && (!contentType || contentType.includes("text/event-stream"));
}

function retryDelay(retryNumber, { baseDelayMs, maxDelayMs, random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (retryNumber - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, Number(random()))) * 0.4;
  return Math.max(0, Math.round(exponential * jitter));
}

/**
 * Request until a stream commits meaningful output or the overload bound is
 * exhausted. The caller forwards prefixChunks before resuming response.
 */
export async function requestWithOverloadRetry(makeRequest, options = {}) {
  const maxRetries = Math.max(0, Math.trunc(Number(options.maxRetries ?? 3)));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? 1200));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs ?? 8000));
  const maxPrefixBytes = Math.max(1024, Number(options.maxPrefixBytes ?? 256 * 1024));
  const random = typeof options.random === "function" ? options.random : Math.random;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : () => {};
  const onExhausted = typeof options.onExhausted === "function" ? options.onExhausted : () => {};
  const shouldAbort = typeof options.shouldAbort === "function" ? options.shouldAbort : () => false;

  let attempts = 0;
  let overloadRetries = 0;
  for (;;) {
    if (shouldAbort()) throw Object.assign(new Error("client closed"), { code: "CLIENT_CLOSED" });
    const response = await makeRequest(attempts);
    attempts += 1;
    if (!isSseResponse(response)) {
      return { response, prefixChunks: [], attempts, overloadRetries, exhausted: false, bypassed: true };
    }

    const gate = await gateSsePrefix(response, { maxBytes: maxPrefixBytes });
    if (gate.decision !== "retry") {
      return {
        response,
        prefixChunks: gate.chunks,
        attempts,
        overloadRetries,
        exhausted: false,
        bypassed: false,
        gateReason: gate.reason,
      };
    }
    if (overloadRetries >= maxRetries) {
      const result = {
        response,
        prefixChunks: gate.chunks,
        attempts,
        overloadRetries,
        exhausted: true,
        bypassed: false,
        gateReason: gate.reason,
        error: gate.error,
      };
      onExhausted(result);
      return result;
    }

    const retryNumber = overloadRetries + 1;
    const delayMs = retryDelay(retryNumber, { baseDelayMs, maxDelayMs, random });
    onRetry({ retryNumber, maxRetries, delayMs, attempts, error: gate.error, response });
    // Drain the tiny terminal failure so a keep-alive socket can be reused.
    response.once("error", () => {});
    response.resume();
    overloadRetries += 1;
    await sleep(delayMs);
  }
}
