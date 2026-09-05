// 桥守护决策（纯函数，launcher 调用）。
// 2026-09-05 实录：桥被外部脚本 Stop-Process 替换后，launcher 连拉 5 次都撞 EADDRINUSE 而熔断，
// 之后 8794 上的桥就永久脱离守护。这里把"退出后怎么办"独立成可测试的决策：
//   已有健康桥在监听 → adopt（外部替换，不算崩溃、不重拉）
//   60s 内退出超过 5 次 → break（熔断，但 rearmMs 后重新探测，不再永久放弃）
//   其余 → restart
export const BRIDGE_CRASH_WINDOW_MS = 60_000;
export const BRIDGE_CRASH_LIMIT = 5;
export const BRIDGE_REARM_MS = 120_000;
export const BRIDGE_RESTART_DELAY_MS = 1000;

/** Windows 上被 Stop-Process/taskkill 结束的进程退出码是 0xFFFFFFFF；这不是崩溃。 */
export function describeBridgeExit(code, signal) {
  const base = `code=${code ?? "-"} signal=${signal ?? "-"}`;
  if (code === 4294967295 || code === -1) return `${base}(0xFFFFFFFF：通常是被外部 Stop-Process/taskkill 结束，不是崩溃)`;
  return base;
}

export function createBridgeGuard({ now = Date.now, windowMs = BRIDGE_CRASH_WINDOW_MS, limit = BRIDGE_CRASH_LIMIT, rearmMs = BRIDGE_REARM_MS } = {}) {
  const exits = [];
  let broken = false;

  function decide({ healthy }) {
    if (healthy) { exits.length = 0; broken = false; return { action: "adopt", watchInMs: rearmMs }; }
    const t = now();
    exits.push(t);
    while (exits.length && t - exits[0] > windowMs) exits.shift();
    if (exits.length > limit) { broken = true; return { action: "break", retryInMs: rearmMs }; }
    return { action: "restart", delayMs: BRIDGE_RESTART_DELAY_MS };
  }

  // 熔断或接管后的定期探测：无人监听才重拉；有健康桥继续接管；有监听但不健康就再等。
  function rearm({ listening, healthy }) {
    exits.length = 0;
    broken = false;
    if (healthy) return { action: "adopt", watchInMs: rearmMs };
    if (listening) return { action: "wait", retryInMs: rearmMs };
    return { action: "restart", delayMs: 0 };
  }

  return { decide, rearm, isBroken: () => broken, exitCount: () => exits.length };
}
