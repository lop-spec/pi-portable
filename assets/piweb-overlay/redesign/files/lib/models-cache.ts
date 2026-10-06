export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; input?: string[] }[];
  defaultModel: { provider: string; modelId: string } | null;
  /** Resolved thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: string[];
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

/** Current cache generation; bumped by invalidateModelsCache(). */
export function getModelsCacheGeneration(): number {
  return getModelsCacheState().generation;
}

function setCacheEntry(state: ModelsCacheState, cwd: string, data: ModelsData): void {
  const now = Date.now();
  for (const [key, entry] of state.entries) {
    if (entry.expiresAt <= now) state.entries.delete(key);
  }
  state.entries.delete(cwd);
  while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
    const oldestKey = state.entries.keys().next().value;
    if (oldestKey === undefined) break;
    state.entries.delete(oldestKey);
  }
  state.entries.set(cwd, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
}

/**
 * Store data loaded outside loadModelsWithCache (a forced network refresh) so
 * the next ordinary read serves it. Dropped when the cache was invalidated
 * after `generation` was read, like a stale loadModelsWithCache result.
 */
export function storeModelsCache(cwd: string, data: ModelsData, generation: number): void {
  const state = getModelsCacheState();
  if (state.generation !== generation) return;
  setCacheEntry(state, cwd, data);
}

// The model menu asks for ?refresh=1 every time it opens, and each forced
// refresh rebuilds the agent services (loading extensions) and fetches the
// remote catalog (~200ms). One network refresh per cwd per window is plenty;
// within it a refresh request is answered from the regular cache, which the
// forced refresh also fills. invalidateModelsCache() (login, enabled models,
// project trust, a catalog refresh that changed something) reopens the window.
export const FORCED_REFRESH_MIN_INTERVAL_MS = 10 * 60_000;

interface ForcedRefreshState {
  at: number;
  generation: number;
  inFlight?: Promise<ModelsData>;
}

declare global {
  var __piModelsForcedRefresh: Map<string, ForcedRefreshState> | undefined;
}

export async function loadModelsWithRefreshThrottle(
  cwd: string,
  refresh: boolean,
  loader: () => Promise<ModelsData>,
  forcedLoader: () => Promise<ModelsData>,
): Promise<ModelsData> {
  if (!refresh) return loadModelsWithCache(cwd, loader);
  const states = (globalThis.__piModelsForcedRefresh ??= new Map());
  const generation = getModelsCacheGeneration();
  const last = states.get(cwd);
  if (last?.inFlight) return last.inFlight;
  if (last && last.generation === generation && Date.now() - last.at < FORCED_REFRESH_MIN_INTERVAL_MS) {
    console.info(`[pi-web] model list refresh throttled for ${cwd}: last network refresh ${Math.round((Date.now() - last.at) / 1000)}s ago, serving the cached catalog`);
    return loadModelsWithCache(cwd, loader);
  }
  const at = Date.now();
  const inFlight = forcedLoader().then((data) => {
    storeModelsCache(cwd, data, generation);
    return data;
  });
  states.set(cwd, { at, generation, inFlight });
  try {
    return await inFlight;
  } finally {
    // Failures count toward the window too (the caller logs them); the
    // regular cached path keeps serving in the meantime.
    if (states.get(cwd)?.inFlight === inFlight) states.set(cwd, { at, generation });
  }
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(cwd);
  }

  const existingLoad = state.inFlight.get(cwd);
  if (existingLoad) return existingLoad;

  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        setCacheEntry(state, cwd, data);
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
