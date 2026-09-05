// Helpers for the ChatGPT Codex model-catalog pass-through.
export const DEFAULT_CODEX_MODELS_CLIENT_VERSION = "999.999.999";

/**
 * The upstream requires client_version and uses it as a minimum-capability gate.
 * A caller-supplied value is preserved; generic OpenAI /models clients receive a
 * forward-capable value so newly rolled-out models are not hidden by an old CLI.
 */
export function codexModelsUpstreamPath(requestUrl, options = {}) {
  const parsed = new URL(String(requestUrl || "/v1/models"), "http://127.0.0.1");
  if (!parsed.searchParams.has("client_version")) {
    parsed.searchParams.set(
      "client_version",
      options.clientVersion || process.env.CODEX_MODELS_CLIENT_VERSION || DEFAULT_CODEX_MODELS_CLIENT_VERSION,
    );
  }
  const query = parsed.searchParams.toString();
  return `/backend-api/codex/models${query ? `?${query}` : ""}`;
}

/** Keep the encoding header whenever the compressed bytes are streamed intact. */
export function modelCatalogResponseHeaders(headers = {}) {
  const out = { ...headers };
  delete out["transfer-encoding"];
  delete out.connection;
  return out;
}
