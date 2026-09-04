import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import {
  classifySseFrame,
  createModelFallbackPlan,
  gateSsePrefix,
  requestWithOverloadRetry,
} from "../src/bridge/codex-overload-retry.mjs";

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const CREATED = frame("response.created", { type: "response.created", response: { status: "in_progress" } });
const IN_PROGRESS = frame("response.in_progress", { type: "response.in_progress", response: { status: "in_progress" } });
const OVERLOAD_ERROR = frame("error", {
  type: "error",
  error: {
    type: "service_unavailable_error",
    code: "server_is_overloaded",
    message: "Our servers are currently overloaded. Please try again later.",
  },
});
const FAILED = frame("response.failed", {
  type: "response.failed",
  response: {
    status: "failed",
    error: {
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
    },
  },
});
const OUTPUT = frame("response.output_item.added", {
  type: "response.output_item.added",
  item: { type: "message" },
});
const COMPLETED = frame("response.completed", {
  type: "response.completed",
  response: { status: "completed" },
});

function responseFrom(parts, { contentType = "text/event-stream; charset=utf-8", statusCode = 200 } = {}) {
  const response = Readable.from(parts.map((part) => Buffer.from(part)));
  response.statusCode = statusCode;
  response.headers = { "content-type": contentType };
  return response;
}

test("builds a transparent Sol to Terra/Luna/Reserve fallback plan", () => {
  const source = Buffer.from(JSON.stringify({
    model: "gpt-5.6-sol",
    input: [{ role: "user", metadata: { model: "must-not-change" } }],
  }));
  const plan = createModelFallbackPlan(source, {
    primaryModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-reserve"],
  });
  assert.equal(plan.primaryModel, "gpt-5.6-sol");
  assert.deepEqual(plan.models, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-reserve"]);
  assert.equal(plan.payloadForAttempt(0).body, source);
  assert.equal(JSON.parse(plan.payloadForAttempt(1).body).model, "gpt-5.6-terra");
  assert.equal(JSON.parse(plan.payloadForAttempt(2).body).model, "gpt-5.6-luna");
  assert.equal(JSON.parse(plan.payloadForAttempt(99).body).model, "gpt-reserve");
  assert.equal(JSON.parse(plan.payloadForAttempt(1).body).input[0].metadata.model, "must-not-change");
});

test("does not silently switch an explicitly selected non-Sol model", () => {
  const source = Buffer.from(JSON.stringify({ model: "gpt-5.6-terra", input: [] }));
  const plan = createModelFallbackPlan(source, {
    primaryModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-5.6-luna"],
  });
  assert.deepEqual(plan.models, ["gpt-5.6-terra"]);
  assert.equal(plan.payloadForAttempt(3).body, source);
});

test("malformed request bodies fail closed without model rewriting", () => {
  const source = Buffer.from("not-json");
  const plan = createModelFallbackPlan(source, {
    primaryModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-5.6-terra"],
  });
  assert.deepEqual(plan.models, []);
  assert.equal(plan.payloadForAttempt(1).body, source);
});

test("classifies the captured structured overload code as retryable", () => {
  const result = classifySseFrame(OVERLOAD_ERROR.trimEnd());
  assert.equal(result.action, "retry");
  assert.equal(result.code, "server_is_overloaded");
});

test("keeps the exact upstream message as a compatibility fallback", () => {
  const result = classifySseFrame(frame("error", {
    type: "error",
    error: { code: "unknown", message: "Our servers are currently overloaded. Please try again later." },
  }).trimEnd());
  assert.equal(result.action, "retry");
});

test("does not broaden retry to unrelated response failures", () => {
  const result = classifySseFrame(frame("response.failed", {
    type: "response.failed",
    response: { status: "failed", error: { code: "invalid_request", message: "bad input" } },
  }).trimEnd());
  assert.equal(result.action, "forward");
});

test("holds created/in_progress and catches overload across arbitrary chunk boundaries", async () => {
  const raw = CREATED + IN_PROGRESS + OVERLOAD_ERROR + FAILED;
  const response = responseFrom([raw.slice(0, 17), raw.slice(17, 91), raw.slice(91)]);
  const result = await gateSsePrefix(response);
  assert.equal(result.decision, "retry");
  assert.equal(result.error.code, "server_is_overloaded");
  assert.equal(Buffer.concat(result.chunks).toString("utf8"), raw);
});

test("commits byte-exactly at the first meaningful output and never retries a later failure", async () => {
  const raw = CREATED + IN_PROGRESS + OUTPUT + OVERLOAD_ERROR + FAILED;
  const response = responseFrom([raw]);
  const result = await gateSsePrefix(response);
  assert.equal(result.decision, "forward");
  assert.equal(result.reason, "meaningful-event");
  assert.equal(Buffer.concat(result.chunks).toString("utf8"), raw);
});

test("fails open when the held prefix exceeds the memory ceiling", async () => {
  const response = responseFrom([":" + "x".repeat(80)]);
  const result = await gateSsePrefix(response, { maxBytes: 32 });
  assert.equal(result.decision, "forward");
  assert.equal(result.reason, "prefix-limit");
});

test("a captured Sol overload switches the composed retry request to Terra", async () => {
  const source = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", input: [] }));
  const plan = createModelFallbackPlan(source, {
    primaryModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-reserve"],
  });
  const responses = [
    responseFrom([CREATED + IN_PROGRESS + OVERLOAD_ERROR + FAILED]),
    responseFrom([CREATED + IN_PROGRESS + OUTPUT + COMPLETED]),
  ];
  const attemptedModels = [];
  const result = await requestWithOverloadRetry(async (attempt) => {
    attemptedModels.push(JSON.parse(plan.payloadForAttempt(attempt).body).model);
    return responses.shift();
  }, {
    maxRetries: 3,
    sleep: async () => {},
  });
  assert.deepEqual(attemptedModels, ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.equal(result.exhausted, false);
  assert.equal(result.attempts, 2);
});

test("retries an immediate overload then returns the successful stream", async () => {
  const responses = [
    responseFrom([CREATED + IN_PROGRESS + OVERLOAD_ERROR + FAILED]),
    responseFrom([CREATED + IN_PROGRESS + OUTPUT + COMPLETED]),
  ];
  const delays = [];
  const retries = [];
  const result = await requestWithOverloadRetry(
    async () => responses.shift(),
    {
      maxRetries: 3,
      baseDelayMs: 1000,
      random: () => 0.5,
      sleep: async (ms) => delays.push(ms),
      onRetry: (event) => retries.push(event),
    },
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.overloadRetries, 1);
  assert.equal(result.exhausted, false);
  assert.deepEqual(delays, [1000]);
  assert.equal(retries[0].error.code, "server_is_overloaded");
  assert.match(Buffer.concat(result.prefixChunks).toString("utf8"), /response\.output_item\.added/);
});

test("after the bound is exhausted, forwards the final upstream failure unchanged", async () => {
  let calls = 0;
  const raw = CREATED + IN_PROGRESS + OVERLOAD_ERROR + FAILED;
  const result = await requestWithOverloadRetry(
    async () => {
      calls += 1;
      return responseFrom([raw]);
    },
    {
      maxRetries: 2,
      baseDelayMs: 10,
      random: () => 0.5,
      sleep: async () => {},
    },
  );
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.overloadRetries, 2);
  assert.equal(result.exhausted, true);
  assert.equal(Buffer.concat(result.prefixChunks).toString("utf8"), raw);
});

test("headerless SSE from the live Codex endpoint still enters the gate", async () => {
  const raw = CREATED + IN_PROGRESS + OVERLOAD_ERROR + FAILED;
  const result = await requestWithOverloadRetry(
    async () => responseFrom([raw], { contentType: "" }),
    { maxRetries: 0 },
  );
  assert.equal(result.exhausted, true);
  assert.equal(result.error.code, "server_is_overloaded");
});

test("non-SSE and non-retryable statuses bypass the gate", async () => {
  let calls = 0;
  const response = responseFrom(["plain"], { contentType: "application/json", statusCode: 400 });
  const result = await requestWithOverloadRetry(async () => {
    calls += 1;
    return response;
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.prefixChunks.length, 0);
  assert.equal(result.bypassed, true);
});

// 2026-09-04:上游 503 曾原样透传给 pi(24h POST 503 = 21/496),一次 503 放大成一整轮任务。
test("upstream 503 backs off and commits the first healthy stream", async () => {
  const delays = [];
  let calls = 0;
  const result = await requestWithOverloadRetry(
    async () => {
      calls += 1;
      if (calls <= 2) return responseFrom(["overloaded"], { contentType: "application/json", statusCode: 503 });
      return responseFrom([CREATED + OUTPUT + COMPLETED]);
    },
    {
      maxRetries: 3,
      baseDelayMs: 10,
      random: () => 0.5,
      sleep: async (ms) => { delays.push(ms); },
    },
  );
  assert.equal(calls, 3);
  assert.equal(result.overloadRetries, 2);
  assert.equal(result.exhausted, false);
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(delays, [10, 20]); // 指数退避,jitter 固定 1.0
});

test("upstream 5xx retry shares the overload budget and finally passes the response through", async () => {
  let calls = 0;
  const seen = [];
  const result = await requestWithOverloadRetry(
    async () => {
      calls += 1;
      return responseFrom(["down"], { contentType: "application/json", statusCode: 502 });
    },
    {
      maxRetries: 2,
      baseDelayMs: 5,
      random: () => 0.5,
      sleep: async () => {},
      onRetry: (event) => seen.push(event.kind),
    },
  );
  assert.equal(calls, 3);
  assert.equal(result.exhausted, true);
  assert.equal(result.statusRetry, true);
  assert.equal(result.upstreamStatus, 502);
  assert.equal(result.response.statusCode, 502);
  assert.deepEqual(seen, ["http-status", "http-status"]);
});

test("429 and bridge-synthetic terminals are left to the account pool layer", async () => {
  let rateLimited = 0;
  const rateLimitResult = await requestWithOverloadRetry(async () => {
    rateLimited += 1;
    return responseFrom(["rate"], { contentType: "application/json", statusCode: 429 });
  }, { sleep: async () => {} });
  assert.equal(rateLimited, 1);
  assert.equal(rateLimitResult.bypassed, true);

  let synthetic = 0;
  const syntheticResult = await requestWithOverloadRetry(async () => {
    synthetic += 1;
    const response = responseFrom(["synthetic"], { contentType: "application/json", statusCode: 503 });
    response.lopSynthetic = true;
    return response;
  }, { sleep: async () => {} });
  assert.equal(synthetic, 1);
  assert.equal(syntheticResult.bypassed, true);
});

test("statusRetry:false restores the passthrough behaviour", async () => {
  let calls = 0;
  const result = await requestWithOverloadRetry(async () => {
    calls += 1;
    return responseFrom(["down"], { contentType: "application/json", statusCode: 503 });
  }, { statusRetry: false, sleep: async () => {} });
  assert.equal(calls, 1);
  assert.equal(result.bypassed, true);
  assert.equal(result.exhausted, false);
});
