import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { upstreamConnectionError } from "../src/bridge/transport-errors.mjs";
import { createRequestLifecycle } from "../src/bridge/request-lifecycle.mjs";
function response() {
  const res = new EventEmitter();
  res.writeHead = (status, headers) => Object.assign(res, { status, headers });
  res.end = (body) => { res.body = JSON.parse(body); res.emit("finish"); };
  return res;
}
const req = { headers: { "content-type": "application/json" } };
test("connection errors preserve HTTP status, code and attempts without reflecting secrets", () => {
  const error = upstreamConnectionError({ code: "ECONNECT_TIMEOUT", connectAttempts: 3, message: "secret credential" }).error;
  assert.match(error.message, /HTTP 502 upstream connect failed \(ECONNECT_TIMEOUT\)/);
  assert.equal(error.attempts, 3);
  assert.equal(error.type, "upstream_connect_error");
  assert.doesNotMatch(JSON.stringify(error), /secret/);
  assert.equal(upstreamConnectionError({ code: "https://secret" }).error.code, "UPSTREAM_CONNECT_FAILED");
});
test("idle shutdown refuses active SSE, releases exactly once, atomically blocks new work", () => {
  const logs = []; let stopped = 0;
  const gate = createRequestLifecycle({ log: (s) => logs.push(s), stop: () => stopped++ });
  const stream = response();
  assert.equal(gate.admit(stream), true);
  const busy = response(); gate.shutdownIfIdle(req, busy);
  assert.equal(busy.status, 409); assert.equal(stopped, 0);
  assert.equal(gate.snapshot().draining, false);
  stream.emit("finish"); stream.emit("close");
  assert.equal(gate.snapshot().activeRequests, 0);
  const idle = response(); gate.shutdownIfIdle(req, idle);
  assert.equal(idle.status, 200); assert.equal(stopped, 1);
  const late = response(); assert.equal(gate.admit(late), false);
  assert.equal(late.status, 503); assert.match(late.body.error.message, /HTTP 503/);
  const again = response(); gate.shutdownIfIdle(req, again);
  assert.equal(again.status, 409); assert.equal(stopped, 1);
  assert.ok(logs.some(s => s.includes("active-requests")));
  assert.ok(logs.some(s => s.includes("reason=draining")));
});
test("cancelled clients release the slot; browser-origin shutdown is rejected", () => {
  let stopped = 0;
  const gate = createRequestLifecycle({ log() {}, stop: () => stopped++ });
  const stream = response(); gate.admit(stream); stream.emit("close");
  assert.equal(gate.snapshot().activeRequests, 0);
  for (const headers of [{}, { ...req.headers, origin: "https://untrusted.example" }]) {
    const res = response(); gate.shutdownIfIdle({ headers }, res);
    assert.equal(res.status, 403); assert.equal(stopped, 0);
  }
});
