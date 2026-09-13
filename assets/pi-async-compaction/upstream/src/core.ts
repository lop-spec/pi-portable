import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncCompactionAdapter } from "./adapter";
import { AUTO_RESUME_PROMPT, InvalidationReason } from "./constants";
import { emitLifecycleEvent, getLifecycleDurationMs } from "./diagnostics";
import { applyReadyCompaction, recordApplyError, startAsyncJob } from "./job";
import type { StartAsyncJobOutcome } from "./job";
import { createRuntimeState, getStatusKey, markStale } from "./runtime-state";
import type { AsyncCompactionMarker, JobCorrelation, RuntimeState } from "./types";
import { getAsyncCompactionMarker } from "./utils";
import { validateReadyJob } from "./validation";

export type {
	AdapterCompactionInput,
	AdapterPrepareInput,
	AdapterRunInput,
	AdapterSnapshotInput,
	AsyncCompactionAdapter,
} from "./adapter";
export type { AsyncCompactionLifecycleEvent, AsyncCompactionLifecycleObserver, AsyncCompactionWastedWork } from "./diagnostics";
export type { Snapshot } from "./types";

export interface RegisterAsyncCompactionOptions {
	readonly commandName?: string | false;
	readonly commandDescription?: string;
	readonly onLifecycleEvent?: import("./diagnostics").AsyncCompactionLifecycleObserver;
}

export interface AsyncCompactionCoreDependencies {
	readonly applyReadyCompaction: typeof applyReadyCompaction;
	readonly startAsyncJob: typeof startAsyncJob;
}

const defaultCoreDependencies: AsyncCompactionCoreDependencies = {
	applyReadyCompaction,
	startAsyncJob,
};

const DEFAULT_COMMAND_DESCRIPTION = "Start async compaction now";
const SAFE_ADAPTER_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const registeredAdapterIds = new WeakMap<object, Set<string>>();

function eraseAdapter<TPrepared, TResult>(
	adapter: AsyncCompactionAdapter<TPrepared, TResult>,
): AsyncCompactionAdapter<unknown, unknown> {
	return adapter as unknown as AsyncCompactionAdapter<unknown, unknown>;
}

function clearCliStatus(ctx: ExtensionContext, state: RuntimeState): void {
	if (ctx.hasUI) ctx.ui.setStatus(getStatusKey(state), undefined);
}

function getJobCorrelation(marker: AsyncCompactionMarker): JobCorrelation {
	return {
		adapterId: marker.adapterId,
		jobId: marker.jobId,
		promptVersion: marker.promptVersion,
	};
}

function matchesJobCorrelation(
	left: JobCorrelation | undefined,
	right: JobCorrelation,
): boolean {
	return left?.adapterId === right.adapterId && left.jobId === right.jobId && left.promptVersion === right.promptVersion;
}

function validateAdapterRegistration(pi: ExtensionAPI, adapter: AsyncCompactionAdapter<unknown, unknown>): void {
	if (!SAFE_ADAPTER_ID.test(adapter.id)) throw new Error(`unsafe adapter id: ${adapter.id}`);
	const ids = registeredAdapterIds.get(pi) ?? new Set<string>();
	if (ids.has(adapter.id)) throw new Error(`adapter id already registered: ${adapter.id}`);
	ids.add(adapter.id);
	registeredAdapterIds.set(pi, ids);
}

function formatManualStartOutcome(outcome: StartAsyncJobOutcome): string | undefined {
	if (outcome === "started" || outcome === "ready_reused") return undefined;
	const reasonByOutcome: Record<Exclude<StartAsyncJobOutcome, "started" | "ready_reused">, string> = {
		already_pending: "job already pending",
		disabled: "disabled",
		model_missing: "model unavailable",
		settings_disabled: "Pi compaction disabled",
		context_unknown: "context usage unknown",
		start_window_empty: "start window empty",
		below_threshold: "below threshold",
		above_force_threshold: "past compaction threshold",
		nothing_to_compact: "nothing to compact",
	};
	return `async compaction not started: ${reasonByOutcome[outcome]}`;
}

function collapseCompactionRender(ctx: ExtensionContext): void {
	// Pi renders compaction summaries with the global tool-output expansion state.
	if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
}

function invalidateActiveJob(ctx: ExtensionContext, state: RuntimeState, reason: InvalidationReason): void {
	if (state.status !== "pending" && state.status !== "ready") return;
	markStale(state, reason);
	clearCliStatus(ctx, state);
}

export function registerAsyncCompaction<TPrepared, TResult>(
	pi: ExtensionAPI,
	adapter: AsyncCompactionAdapter<TPrepared, TResult>,
	options: RegisterAsyncCompactionOptions = {},
	injectedDeps: Partial<AsyncCompactionCoreDependencies> = {},
): void {
	const jobAdapter = eraseAdapter(adapter);
	validateAdapterRegistration(pi, jobAdapter);
	const deps = { ...defaultCoreDependencies, ...injectedDeps };
	const state = createRuntimeState(adapter.id, adapter.label, options.onLifecycleEvent);

	pi.on("turn_end", (_event, ctx) => {
		deps.startAsyncJob(ctx, state, { adapter: jobAdapter, force: false });
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.hasPendingMessages()) deps.applyReadyCompaction(ctx, state);
	});

	pi.on("model_select", (_event, ctx) => {
		invalidateActiveJob(ctx, state, InvalidationReason.MODEL_CHANGED);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		invalidateActiveJob(ctx, state, InvalidationReason.THINKING_CHANGED);
	});

	pi.on("session_tree", (_event, ctx) => {
		invalidateActiveJob(ctx, state, InvalidationReason.SNAPSHOT_LEAF_MISSING);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const ready = state.ready;
		if (!ready || state.status !== "ready") {
			if (state.status === "pending") {
				markStale(state, InvalidationReason.SYNC_FALLBACK);
				clearCliStatus(ctx, state);
			}
			return;
		}

		const invalidReason = validateReadyJob(ready, event, ctx);
		if (invalidReason) {
			markStale(state, invalidReason);
			clearCliStatus(ctx, state);
			return;
		}

		state.status = "idle";
		state.ready = undefined;
		state.reason = undefined;
		state.applyInFlight = undefined;
		state.lastHandedOff = {
			adapterId: ready.adapterId,
			jobId: ready.jobId,
			promptVersion: ready.promptVersion,
		};
		emitLifecycleEvent(state.lifecycleObserver, {
			event: "handed_off",
			adapterId: ready.adapterId,
			jobId: ready.jobId,
			durationMs: getLifecycleDurationMs(state.lifecycleStartedAtMs),
		});
		clearCliStatus(ctx, state);
		collapseCompactionRender(ctx);
		return { compaction: ready.result };
	});

	pi.on("session_compact", (event, ctx) => {
		const marker = event.fromExtension ? getAsyncCompactionMarker(event.compactionEntry.details) : undefined;
		if (!marker || marker.adapterId !== state.adapterId) return;

		const correlation = getJobCorrelation(marker);
		if (!matchesJobCorrelation(state.lastHandedOff, correlation)) return;
		state.lastHandedOff = undefined;
		state.lifecycleStartedAtMs = undefined;
		const shouldAutoResume = matchesJobCorrelation(state.autoResumeAfterCompaction, correlation);
		if (shouldAutoResume) state.autoResumeAfterCompaction = undefined;
		if (ctx.hasUI) {
			const ui = ctx.ui;
			setTimeout(() => ui.notify(`Applied ready ${state.adapterLabel}`, "info"), 0);
		}
		if (shouldAutoResume) {
			setTimeout(() => {
				if (!ctx.hasPendingMessages()) pi.sendUserMessage(AUTO_RESUME_PROMPT);
			}, 0);
		}
	});

	pi.on("session_compact_failed", (event) => {
		const correlation = state.lastHandedOff;
		if (!event.fromExtension || !correlation) return;
		recordApplyError(state, correlation, new Error(event.errorMessage ?? "compaction aborted"));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		markStale(state, InvalidationReason.CANCELLED);
		clearCliStatus(ctx, state);
	});

	if (options.commandName) {
		pi.registerCommand(options.commandName, {
			description: options.commandDescription ?? DEFAULT_COMMAND_DESCRIPTION,
			handler: async (_args, ctx) => {
				const message = formatManualStartOutcome(deps.startAsyncJob(ctx, state, { adapter: jobAdapter, force: true }));
				if (message && ctx.hasUI) ctx.ui.notify(message, "info");
				if (message && !ctx.hasUI) console.log(message);
			},
		});
	}
}
