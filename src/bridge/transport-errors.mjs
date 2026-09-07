// Preserve a machine-recognizable status in message: Codex's adapter retains
// error.message but can discard HTTP status and error.code before Pi classifies it.
export const TRANSPORT_ERROR_VERSION = "http-status-v1";
export function upstreamConnectionError(cause) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(cause?.code || ""))
    ? String(cause.code) : "UPSTREAM_CONNECT_FAILED";
  const attempts = Number.isInteger(cause?.connectAttempts) && cause.connectAttempts > 0
    ? cause.connectAttempts : undefined;
  // Do not reflect arbitrary upstream bodies, URLs or credentials to clients.
  return { error: {
    type: "upstream_connect_error", code,
    message: `HTTP 502 upstream connect failed (${code}): 上游连接失败`,
    ...(attempts === undefined ? {} : { attempts }),
  } };
}
