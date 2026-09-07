// Atomic admission/idle shutdown. Never terminate a response that was admitted.
export function createRequestLifecycle({ log, stop }) {
  let active = 0;
  let draining = false;
  return {
    snapshot: () => ({ version: "idle-shutdown-v1", activeRequests: active, draining }),
    admit(res) {
      if (draining) {
        log("bridge request rejected reason=draining status=503");
        res.writeHead(503, { "content-type": "application/json", "retry-after": "2" });
        res.end(JSON.stringify({ error: { code: "BRIDGE_DRAINING", message: "HTTP 503 bridge draining; retry request" } }));
        return false;
      }
      active++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
      };
      res.once("finish", release);
      res.once("close", release);
      return true;
    },
    shutdownIfIdle(req, res) {
      if (req.headers.origin || !/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
        log("bridge shutdown rejected reason=non-local-control-request");
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "JSON control request without Origin required" }));
        return;
      }
      if (active || draining) {
        log(`bridge shutdown refused reason=${draining ? "already-draining" : "active-requests"} active=${active}`);
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, ...this.snapshot() }));
        return;
      }
      draining = true; // synchronous check+gate: a new request cannot race a kill.
      log("bridge shutdown accepted reason=idle active=0");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...this.snapshot() }));
      stop();
    },
  };
}
