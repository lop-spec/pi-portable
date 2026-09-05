import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE_REARM_MS, createBridgeGuard, describeBridgeExit } from "../src/bridge-guard.mjs";

function clock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test("普通退出 → restart（1s 后重拉）", () => {
  const guard = createBridgeGuard({ now: clock().now });
  assert.deepEqual(guard.decide({ healthy: false }), { action: "restart", delayMs: 1000 });
  assert.equal(guard.isBroken(), false);
});

test("8794 已有健康桥（外部替换）→ adopt，不计崩溃、计数清零", () => {
  const c = clock();
  const guard = createBridgeGuard({ now: c.now });
  for (let i = 0; i < 4; i++) { guard.decide({ healthy: false }); c.tick(1000); }
  assert.equal(guard.exitCount(), 4);
  assert.deepEqual(guard.decide({ healthy: true }), { action: "adopt", watchInMs: BRIDGE_REARM_MS });
  assert.equal(guard.exitCount(), 0);
});

test("60s 内退出超过 5 次 → break，但带 retryInMs 而不是永久放弃", () => {
  const c = clock();
  const guard = createBridgeGuard({ now: c.now });
  let last;
  for (let i = 0; i < 6; i++) { last = guard.decide({ healthy: false }); c.tick(1000); }
  assert.deepEqual(last, { action: "break", retryInMs: BRIDGE_REARM_MS });
  assert.equal(guard.isBroken(), true);
});

test("窗口外的旧退出不计入：61s 前的 5 次退出后再退出一次仍是 restart", () => {
  const c = clock();
  const guard = createBridgeGuard({ now: c.now });
  for (let i = 0; i < 5; i++) guard.decide({ healthy: false });
  c.tick(61_000);
  assert.equal(guard.decide({ healthy: false }).action, "restart");
});

test("熔断复位探测：无人监听 → restart；健康 → adopt；有监听但不健康 → wait；三者都清熔断", () => {
  const guard = createBridgeGuard({ now: clock().now });
  for (let i = 0; i < 6; i++) guard.decide({ healthy: false });
  assert.equal(guard.isBroken(), true);
  assert.deepEqual(guard.rearm({ listening: false, healthy: false }), { action: "restart", delayMs: 0 });
  assert.equal(guard.isBroken(), false);
  assert.deepEqual(guard.rearm({ listening: true, healthy: true }), { action: "adopt", watchInMs: BRIDGE_REARM_MS });
  assert.deepEqual(guard.rearm({ listening: true, healthy: false }), { action: "wait", retryInMs: BRIDGE_REARM_MS });
});

test("退出码 0xFFFFFFFF 标注为外部结束而非崩溃", () => {
  assert.match(describeBridgeExit(4294967295, null), /Stop-Process\/taskkill/u);
  assert.match(describeBridgeExit(-1, null), /不是崩溃/u);
  assert.equal(describeBridgeExit(0, null), "code=0 signal=-");
  assert.equal(describeBridgeExit(null, "SIGTERM"), "code=- signal=SIGTERM");
});
