import type { Api, Model, ProviderHeaders, RetryPolicy } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { createBuiltinPiCompactionAdapter } from "./adapter";
import type { AsyncCompactionAdapter } from "./adapter";
import { InvalidationReason } from "./constants";
import { emitLifecycleEvent, getLifecycleDurationMs } from "./diagnostics";
import { getAbortInvalidationReason, getStatusKey, markStale, nextJobId } from "./runtime-state";
import type { AsyncCompactionDetails, JobCorrelation, LocalCompactionPreparation, ReadyJob, ResolvedCompactionSettings, RuntimeState, Snapshot } from "./types";
import { getReadyJobContextInvalidationReason } from "./validation";
import { getCompactionSettings, getRetrySettings, getStartRatio, getStartWindow, getTimeoutMs, isEnabled } from "./utils";

function getReadyJobReplacementReason(
	ready: ReadyJob,
	ctx: ExtensionContext,
	settings: ResolvedCompactionSettings,
): InvalidationReason | undefined {
	return getReadyJobContextInvalidationReason(ready, ctx, settings);
}

function canApplyReadyCompaction(ctx: ExtensionContext): boolean {
	return ctx.isIdle() && !ctx.hasPendingMessages();
}

function shouldForceApplyReadyCompaction(ctx: ExtensionContext, deps: StartAsyncJobDependencies): boolean {
	if (ctx.isIdle() || ctx.hasPendingMessages()) return false;
	if (!ctx.signal || ctx.signal.aborted) return false;

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.contextWindow <= 0) return false;

	return usage.tokens > Math.floor(usage.contextWindow * deps.getStartRatio());
}

function normalizeProviderHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== null) normalized[name] = value;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export async function buildAsyncCompactionResult(
	preparation: LocalCompactionPreparation,
	model: Model<Api>,
	ctx: ExtensionContext,
	thinkingLevel: ThinkingLevel,
	signal: AbortSignal,
	compactFn: typeof compact = compact,
	getRetrySettingsFn: (ctx: ExtensionContext) => RetryPolicy = getRetrySettings,
): Promise<CompactionResult> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	const requestHeaders = normalizeProviderHeaders(auth.headers);
	if (!auth.apiKey && !requestHeaders) {
		throw new Error(`No API key or headers for ${model.provider}`);
	}
	const requestModel = auth.baseUrl || auth.headers
		? { ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}), headers: requestHeaders }
		: model;

	// Pi's compact() type still excludes nullable ProviderHeaders, but its runtime forwards them
	// to pi-ai unchanged. Keep the cast at this compatibility boundary until Pi widens the type.
	return compactFn(
		preparation,
		requestModel,
		auth.apiKey,
		auth.headers as Parameters<typeof compact>[3],
		undefined,
		signal,
		thinkingLevel,
		undefined,
		auth.env,
		getRetrySettingsFn(ctx),
	);
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface StartAsyncJobDependencies {
	readonly adapter?: AsyncCompactionAdapter<unknown, unknown>;
	readonly buildAsyncCompactionResult: (
		preparation: LocalCompactionPreparation,
		model: Model<Api>,
		ctx: ExtensionContext,
		thinkingLevel: ThinkingLevel,
		signal: AbortSignal,
	) => Promise<CompactionResult>;
	readonly getCompactionSettings: (ctx: ExtensionContext) => ResolvedCompactionSettings;
	readonly getStartRatio: () => number;
	readonly getTimeoutMs: () => number;
	readonly isEnabled: () => boolean;
	readonly setCliStatus: (ctx: ExtensionContext, statusKey: string, text: string | undefined) => void;
	readonly setTimeout: (handler: () => void, timeoutMs: number) => TimeoutHandle;
	readonly clearTimeout: (timeout: TimeoutHandle) => void;
	readonly triggerCompaction: (ctx: ExtensionContext, onError: (error: Error) => void) => void;
}

interface StartAsyncJobOptions {
	readonly adapter?: AsyncCompactionAdapter<unknown, unknown>;
	readonly force: boolean;
	readonly timeoutMs?: number;
}

export type StartAsyncJobOutcome =
	| "started"
	| "already_pending"
	| "ready_reused"
	| "disabled"
	| "model_missing"
	| "settings_disabled"
	| "context_unknown"
	| "start_window_empty"
	| "below_threshold"
	| "above_force_threshold"
	| "nothing_to_compact";

const defaultStartAsyncJobDependencies: StartAsyncJobDependencies = {
	buildAsyncCompactionResult,
	getCompactionSettings,
	getStartRatio,
	getTimeoutMs,
	isEnabled,
	setCliStatus: (ctx, statusKey, text) => {
		if (ctx.hasUI) ctx.ui.setStatus(statusKey, text);
	},
	setTimeout,
	clearTimeout,
	triggerCompaction: (ctx, onError) => ctx.compact({ onError }),
};

export function startAsyncJob(
	ctx: ExtensionContext,
	state: RuntimeState,
	options: StartAsyncJobOptions = { force: false, timeoutMs: undefined },
): StartAsyncJobOutcome {
	return startAsyncJobWithDeps(
		ctx,
		state,
		{ ...defaultStartAsyncJobDependencies, adapter: options.adapter },
		options,
	);
}

export function applyReadyCompaction(
	ctx: ExtensionContext,
	state: RuntimeState,
	deps: StartAsyncJobDependencies = defaultStartAsyncJobDependencies,
): boolean {
	if (state.status !== "ready" || !state.ready || state.applyInFlight) return false;
	const replacementReason = getReadyJobReplacementReason(state.ready, ctx, deps.getCompactionSettings(ctx));
	if (replacementReason) {
		markStale(state, replacementReason);
		setCliStatus(deps, ctx, state, undefined);
		return false;
	}
	if (!canApplyReadyCompaction(ctx) && !shouldForceApplyReadyCompaction(ctx, deps)) {
		setCliStatus(deps, ctx, state, `${state.adapterLabel}: ready`);
		return false;
	}
	const correlation = getJobCorrelation(state.ready);
	const shouldAbortBeforeApply = !ctx.isIdle();
	state.applyInFlight = correlation;
	setCliStatus(deps, ctx, state, undefined);
	if (shouldAbortBeforeApply) {
		state.autoResumeAfterCompaction = correlation;
		ctx.abort();
	}
	deps.triggerCompaction(ctx, (error) => recordApplyError(state, correlation, error));
	return true;
}

function setCliStatus(
	deps: StartAsyncJobDependencies,
	ctx: ExtensionContext,
	state: RuntimeState,
	text: string | undefined,
): void {
	deps.setCliStatus(ctx, getStatusKey(state), text);
}

function getJobCorrelation(job: ReadyJob): JobCorrelation {
	return {
		adapterId: job.adapterId,
		jobId: job.jobId,
		promptVersion: job.promptVersion,
	};
}

function matchesJobCorrelation(
	left: JobCorrelation | undefined,
	right: JobCorrelation,
): boolean {
	return left?.adapterId === right.adapterId && left.jobId === right.jobId && left.promptVersion === right.promptVersion;
}

export function recordApplyError(state: RuntimeState, correlation: JobCorrelation, error: Error): void {
	const isApplyingJob = state.status === "ready" && matchesJobCorrelation(state.applyInFlight, correlation);
	const isHandedOffJob = state.status === "idle" && matchesJobCorrelation(state.lastHandedOff, correlation);
	if (!isApplyingJob && !isHandedOffJob) return;
	emitFailure(state, correlation.jobId, "apply", `apply failed: ${error.message}`, "confirmed");
	state.status = "failed";
	state.ready = undefined;
	state.reason = InvalidationReason.FAILED;
	state.error = `apply failed: ${error.message}`;
	state.applyInFlight = undefined;
	state.lastHandedOff = undefined;
	state.autoResumeAfterCompaction = undefined;
	state.lifecycleStartedAtMs = undefined;
}

function recordBackgroundFailure(state: RuntimeState, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (state.jobId) emitFailure(state, state.jobId, "background", message, "possible");
	state.status = "failed";
	state.reason = InvalidationReason.FAILED;
	state.error = message;
	state.lifecycleStartedAtMs = undefined;
}

function recordEmptySummaryFailure(state: RuntimeState): void {
	if (state.jobId) emitFailure(state, state.jobId, "background", "empty compaction summary", "confirmed");
	state.abortController = undefined;
	state.status = "failed";
	state.ready = undefined;
	state.reason = InvalidationReason.FAILED;
	state.error = "empty compaction summary";
	state.lifecycleStartedAtMs = undefined;
}

function emitFailure(
	state: RuntimeState,
	jobId: string,
	phase: "background" | "apply",
	error: string,
	wastedWork: "possible" | "confirmed",
): void {
	emitLifecycleEvent(state.lifecycleObserver, {
		event: "failed",
		adapterId: state.adapterId,
		jobId,
		durationMs: getLifecycleDurationMs(state.lifecycleStartedAtMs),
		phase,
		error,
		wastedWork,
	});
}

function storeReadyResult(state: RuntimeState, snapshot: Snapshot, result: CompactionResult): void {
	const piDetails = result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};

	state.abortController = undefined;
	state.status = "ready";
	state.ready = {
		...snapshot,
		adapterId: state.adapterId,
		result: {
			...result,
			details: {
				...piDetails,
				asyncPrefixCompaction: {
					adapterId: state.adapterId,
					jobId: snapshot.jobId,
					snapshotLeafId: snapshot.snapshotLeafId,
					modelKey: snapshot.modelKey,
					thinkingLevel: snapshot.thinkingLevel,
					settingsKey: snapshot.settingsKey,
					promptVersion: snapshot.promptVersion,
				},
			} satisfies AsyncCompactionDetails,
		},
	};
	emitLifecycleEvent(state.lifecycleObserver, {
		event: "ready",
		adapterId: state.adapterId,
		jobId: snapshot.jobId,
		durationMs: getLifecycleDurationMs(state.lifecycleStartedAtMs),
	});
}

function scheduleTimeout(
	deps: StartAsyncJobDependencies,
	ctx: ExtensionContext,
	state: RuntimeState,
	jobId: string,
	abortController: AbortController,
	timeoutMs: number,
	onTimeout: () => void,
): TimeoutHandle | undefined {
	if (timeoutMs <= 0) return undefined;
	return deps.setTimeout(() => {
		onTimeout();
		abortController.abort();
		if (state.status !== "pending" || state.jobId !== jobId) return;
		markStale(state, InvalidationReason.TIMEOUT);
		setCliStatus(deps, ctx, state, undefined);
	}, timeoutMs);
}

function getAutomaticStartBlocker(
	ctx: ExtensionContext,
	deps: StartAsyncJobDependencies,
	settings: ResolvedCompactionSettings,
): StartAsyncJobOutcome | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.contextWindow <= 0) return "context_unknown";

	// Pi's shouldCompact checks the final trigger threshold; async starts earlier and must keep its own window.
	const startWindow = getStartWindow(usage.contextWindow, deps.getStartRatio(), settings.reserveTokens);
	if (startWindow.kind === "unknown") return "context_unknown";
	if (startWindow.kind === "empty") return "start_window_empty";
	if (usage.tokens <= startWindow.startThreshold) return "below_threshold";
	if (usage.tokens > startWindow.forceThreshold) return "above_force_threshold";
	return undefined;
}

function markPending(state: RuntimeState, jobId: string, abortController: AbortController): void {
	state.abortController?.abort();
	state.abortController = abortController;
	state.status = "pending";
	state.jobId = jobId;
	state.ready = undefined;
	state.reason = undefined;
	state.error = undefined;
	state.applyInFlight = undefined;
	state.lastHandedOff = undefined;
	state.autoResumeAfterCompaction = undefined;
	state.lifecycleStartedAtMs = Date.now();
	emitLifecycleEvent(state.lifecycleObserver, {
		event: "started",
		adapterId: state.adapterId,
		jobId,
		startedAtMs: state.lifecycleStartedAtMs,
	});
}

function getAdapter(deps: StartAsyncJobDependencies): AsyncCompactionAdapter<unknown, unknown> {
	return deps.adapter ?? createBuiltinPiCompactionAdapter(deps.buildAsyncCompactionResult) as AsyncCompactionAdapter<unknown, unknown>;
}

export function startAsyncJobWithDeps(
	ctx: ExtensionContext,
	state: RuntimeState,
	deps: StartAsyncJobDependencies,
	options: StartAsyncJobOptions = { force: false, timeoutMs: undefined },
): StartAsyncJobOutcome {
	if (!deps.isEnabled()) return "disabled";
	if (!ctx.model) return "model_missing";

	const settings = deps.getCompactionSettings(ctx);
	if (!settings.enabled) return "settings_disabled";

	if (!options.force) {
		const blocker = getAutomaticStartBlocker(ctx, deps, settings);
		if (blocker) return blocker;
	}

	if (state.status === "pending") return "already_pending";
	const readyReplacementReason = state.ready
		? getReadyJobReplacementReason(state.ready, ctx, settings)
		: InvalidationReason.SUPERSEDED;
	if (state.status === "ready" && state.ready && !readyReplacementReason) {
		if (options.force) applyReadyCompaction(ctx, state, deps);
		return "ready_reused";
	}
	if (state.status === "ready") {
		markStale(state, readyReplacementReason ?? InvalidationReason.SUPERSEDED);
	}

	const adapter = options.adapter ?? getAdapter(deps);
	const prepared = adapter.prepare({ ctx, settings });
	if (!prepared) return "nothing_to_compact";

	const jobId = nextJobId(state);
	const abortController = new AbortController();
	const snapshot = adapter.createSnapshot({ ctx, jobId, prepared, settings });
	markPending(state, jobId, abortController);
	setCliStatus(deps, ctx, state, `${state.adapterLabel}: preparing`);

	const timeoutMs = options.timeoutMs ?? deps.getTimeoutMs();
	let timedOut = false;
	const timeout = scheduleTimeout(deps, ctx, state, jobId, abortController, timeoutMs, () => {
		timedOut = true;
	});

	void adapter.run({ ctx, prepared, signal: abortController.signal })
		.then((adapterResult) => {
			if (timeout) deps.clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			if (abortController.signal.aborted) {
				markStale(state, getAbortInvalidationReason(timedOut));
				setCliStatus(deps, ctx, state, undefined);
				return;
			}

			const result = adapter.toCompaction({ prepared, snapshot, result: adapterResult });
			if (!result.summary.trim()) {
				recordEmptySummaryFailure(state);
				setCliStatus(deps, ctx, state, undefined);
				return;
			}

			storeReadyResult(state, snapshot, result);
			applyReadyCompaction(ctx, state, deps);
		})
		.catch((error: unknown) => {
			if (timeout) deps.clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			state.abortController = undefined;
			if (abortController.signal.aborted) {
				markStale(state, getAbortInvalidationReason(timedOut));
				state.error = undefined;
				setCliStatus(deps, ctx, state, undefined);
				return;
			}
			recordBackgroundFailure(state, error);
			setCliStatus(deps, ctx, state, undefined);
		});
	return "started";
}
