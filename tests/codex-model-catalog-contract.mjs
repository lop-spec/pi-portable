import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  codexModelsUpstreamPath,
  DEFAULT_CODEX_MODELS_CLIENT_VERSION,
  modelCatalogResponseHeaders,
} from "../src/bridge/codex-model-catalog.mjs";
import { rewriteCodexRequestBody } from "../src/bridge/codex-cache-policy.mjs";
import { createModelFallbackPlan } from "../src/bridge/codex-overload-retry.mjs";

const nativePayload = (model) => ({
  model,
  input: [{ role: "developer", content: "stable" }, { role: "user", content: "ping" }],
  tools: [],
  reasoning: { effort: "max" },
  max_output_tokens: 128000,
});

test("model catalogue adds a forward-capable client version but preserves explicit callers", () => {
  assert.equal(
    codexModelsUpstreamPath("/v1/models"),
    `/backend-api/codex/models?client_version=${DEFAULT_CODEX_MODELS_CLIENT_VERSION}`,
  );
  assert.equal(
    codexModelsUpstreamPath("/v1/models?client_version=0.153.4&extra=1"),
    "/backend-api/codex/models?client_version=0.153.4&extra=1",
  );
});

test("compressed catalogue bytes retain content-encoding downstream", () => {
  const headers = modelCatalogResponseHeaders({
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": "123",
    "transfer-encoding": "chunked",
    connection: "keep-alive",
    etag: "catalog-v1",
  });
  assert.equal(headers["content-encoding"], "gzip");
  assert.equal(headers["content-length"], "123");
  assert.equal(headers.etag, "catalog-v1");
  assert.equal(headers["transfer-encoding"], undefined);
  assert.equal(headers.connection, undefined);
});

test("native Codex zstd requests are normalized for compatibility and fallback", () => {
  const payload = nativePayload("gpt-5.6-sol");
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  const rewritten = rewriteCodexRequestBody(compressed, {
    "content-type": "application/json",
    "content-encoding": "zstd",
  }, { explicitBreakpoint: false });

  assert.equal(rewritten.meta.parseFailed, false);
  assert.equal(rewritten.meta.decodedEncoding, "zstd");
  assert.equal(rewritten.headers["content-encoding"], undefined);
  const normalized = JSON.parse(rewritten.body.toString("utf8"));
  assert.equal(normalized.model, "gpt-5.6-sol");
  assert.ok(normalized.prompt_cache_key, "Sol keeps the bridge cache policy");

  const plan = createModelFallbackPlan(rewritten.body, {
    primaryModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-5.6-terra"],
  });
  assert.deepEqual(plan.models, ["gpt-5.6-sol", "gpt-5.6-terra"]);
});

test("a newly published major remains parseable even without a cache rewrite", () => {
  const payload = nativePayload("gpt-6-astra");
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  const rewritten = rewriteCodexRequestBody(compressed, { "content-encoding": "zstd" });
  assert.equal(rewritten.meta.parseFailed, false);
  assert.equal(rewritten.meta.cacheApplied, false);
  assert.equal(rewritten.meta.cache.reason, "unsupported-model");
  assert.equal(JSON.parse(rewritten.body.toString("utf8")).model, "gpt-6-astra");
  assert.equal(rewritten.headers["content-encoding"], undefined);
});
