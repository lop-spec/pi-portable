# Windows system proxy

Pi's launcher and Codex bridge default to the current user's Windows Internet Settings. The bridge polls every five seconds and keys its connection pools by proxy host and port, so new requests follow changes without a restart. Existing requests are not interrupted.

- Supports unified HTTP CONNECT endpoints and protocol-specific `https=` / `http=` entries, including IPv6 endpoints.
- When the system proxy is disabled, Pi uses direct connections. It does not silently select a historical port or fallback proxy.
- Set `CODEX_FOLLOW_SYSTEM_PROXY=0` to retain explicit/legacy Pi egress selection.
- PAC evaluation, proxy authentication and non-HTTP proxy transports are not supported. Registry/parse failures always log a reason; the last successfully read system endpoint is retained, or legacy selection is used if there has not been a valid system read.
- `/health` exposes `followSystemProxy`, `upstreamProxy`, `egress`, and the actually eligible `egressFallback.ports`. This feature does not write Windows proxy settings or Smart Proxy routes.

Regression checks: `node --test tests/system-proxy.test.mjs`, `node tests/bridge-connect-retry-e2e.mjs`, and `node tests/bridge-5xx-retry-e2e.mjs`.
