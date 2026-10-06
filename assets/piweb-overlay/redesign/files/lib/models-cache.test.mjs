import assert from "node:assert/strict";
import test from "node:test";

import {
  FORCED_REFRESH_MIN_INTERVAL_MS,
  invalidateModelsCache,
  loadModelsWithRefreshThrottle,
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
} from "./models-cache.ts";

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
  };
}

test("caches model data independently for each cwd", async () => {
  invalidateModelsCache();
  let firstLoads = 0;
  let secondLoads = 0;

  const first = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("first");
  });
  await loadModelsWithCache("/second", async () => {
    secondLoads += 1;
    return modelsData("second");
  });
  const firstAgain = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("replacement");
  });

  assert.deepEqual(firstAgain, first);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
});

test("shares one loader between concurrent requests for the same cwd", async () => {
  invalidateModelsCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = loadModelsWithCache("/shared", loader);
  const second = loadModelsWithCache("/shared", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  finishLoad(modelsData("shared"));
  assert.deepEqual(await second, await first);
});

test("does not cache a stale load that finishes after invalidation", async () => {
  invalidateModelsCache();
  let finishOldLoad;
  const oldLoad = loadModelsWithCache("/stale", () => new Promise((resolve) => { finishOldLoad = resolve; }));
  await Promise.resolve();

  invalidateModelsCache();
  let freshLoads = 0;
  const fresh = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("fresh");
  });
  finishOldLoad(modelsData("stale"));
  await oldLoad;

  const cached = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("unexpected");
  });
  assert.deepEqual(cached, fresh);
  assert.equal(freshLoads, 1);
});

test("retries after a model load fails", async () => {
  invalidateModelsCache();
  await assert.rejects(
    loadModelsWithCache("/failed", async () => { throw new Error("load failed"); }),
    /load failed/,
  );

  let retries = 0;
  const fresh = await loadModelsWithCache("/failed", async () => {
    retries += 1;
    return modelsData("fresh");
  });
  assert.deepEqual(fresh, modelsData("fresh"));
  assert.equal(retries, 1);
});

test("adds runtime errors without discarding available models", () => {
  const data = modelsData("builtin");
  const result = withModelRuntimeError(data, "Invalid models.json schema");

  assert.deepEqual(result, {
    ...data,
    modelError: "Invalid models.json schema",
  });
});

test("uses a safe error for unexpected model load failures", () => {
  const data = {
    ...modelsData("builtin"),
    modelError: "Failed to load /Users/example/.pi/agent/models.json with token secret",
  };
  const result = withSafeModelLoadFailure(data);

  assert.deepEqual(result, {
    ...data,
    modelError: "Model list is temporarily unavailable. Check your configuration and try again.",
  });
});

test("a forced refresh runs at most once per cwd per window and fills the cache", async (t) => {
  invalidateModelsCache();
  globalThis.__piModelsForcedRefresh = undefined;
  t.mock.method(console, "info", () => {});
  let forced = 0;
  let cached = 0;
  const loader = async () => { cached += 1; return modelsData("cached"); };
  const forcedLoader = async () => { forced += 1; return modelsData(`forced-${forced}`); };

  const [first, concurrent] = await Promise.all([
    loadModelsWithRefreshThrottle("/w", true, loader, forcedLoader),
    loadModelsWithRefreshThrottle("/w", true, loader, forcedLoader),
  ]);
  assert.equal(forced, 1, "concurrent refreshes share one network load");
  assert.deepEqual(concurrent, first);

  // Within the window ?refresh=1 is served from the cache the forced load filled.
  assert.deepEqual(await loadModelsWithRefreshThrottle("/w", true, loader, forcedLoader), modelsData("forced-1"));
  assert.deepEqual(await loadModelsWithRefreshThrottle("/w", false, loader, forcedLoader), modelsData("forced-1"));
  assert.equal(forced, 1);
  assert.equal(cached, 0);

  // Another cwd has its own window.
  await loadModelsWithRefreshThrottle("/other", true, loader, forcedLoader);
  assert.equal(forced, 2);

  // Invalidation (login, enabled models, trust) reopens the window.
  invalidateModelsCache();
  assert.deepEqual(await loadModelsWithRefreshThrottle("/w", true, loader, forcedLoader), modelsData("forced-3"));

  // After the window a refresh goes to the network again.
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + FORCED_REFRESH_MIN_INTERVAL_MS + 1);
  await loadModelsWithRefreshThrottle("/w", true, loader, forcedLoader);
  assert.equal(forced, 4);
});

test("a failed forced refresh is throttled too and falls back to the cached path", async (t) => {
  invalidateModelsCache();
  globalThis.__piModelsForcedRefresh = undefined;
  t.mock.method(console, "info", () => {});
  let forced = 0;
  const forcedLoader = async () => { forced += 1; throw new Error("network down"); };
  await assert.rejects(loadModelsWithRefreshThrottle("/f", true, async () => modelsData("cached"), forcedLoader), /network down/);
  assert.deepEqual(await loadModelsWithRefreshThrottle("/f", true, async () => modelsData("cached"), forcedLoader), modelsData("cached"));
  assert.equal(forced, 1);
});
