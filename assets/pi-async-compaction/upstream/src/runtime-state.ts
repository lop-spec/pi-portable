import { BUILTIN_ADAPTER_ID, BUILTIN_ADAPTER_LABEL, EXTENSION_NAME, InvalidationReason } from "./constants";
import { emitLifecycleEvent, getLifecycleDurationMs } from "./diagnostics";
import type { AsyncCompactionLifecycleObserver } from "./diagnostics";
import type { RuntimeState } from "./types";

export function createRuntimeState(
	adapterId = BUILTIN_ADAPTER_ID,
	adapterLabel = BUILTIN_ADAPTER_LABEL,
	lifecycleObserver?: AsyncCompactionLifecycleObserver,
): RuntimeState {
	return {
		adapterId,
		adapterLabel,
		status: "idle",
		jobId: undefined,
		ready: undefined,
		reason: undefined,
		error: undefined,
		abortController: undefined,
		jobCounter: 0,
		applyInFlight: undefined,
		lastHandedOff: undefined,
		autoResumeAfterCompaction: undefined,
		lifecycleObserver,
		lifecycleStartedAtMs: undefined,
	};
}

export function nextJobId(state: RuntimeState): string {
	state.jobCounter++;
	return `${EXTENSION_NAME}:${state.adapterId}:${state.jobCounter}`;
}

export function getStatusKey(state: RuntimeState): string {
	return `${EXTENSION_NAME}:${state.adapterId}`;
}

export function markStale(state: RuntimeState, reason: InvalidationReason): void {
	const wasActive = state.status === "pending" || state.status === "ready";
	if (wasActive && state.jobId) {
		emitLifecycleEvent(state.lifecycleObserver, {
			event: "invalidated",
			adapterId: state.adapterId,
			jobId: state.jobId,
			durationMs: getLifecycleDurationMs(state.lifecycleStartedAtMs),
			reason,
			wastedWork: state.status === "ready" ? "confirmed" : "possible",
		});
	}
	state.abortController?.abort();
	state.abortController = undefined;
	state.status = "stale";
	state.ready = undefined;
	state.reason = reason;
	state.applyInFlight = undefined;
	state.lastHandedOff = undefined;
	state.autoResumeAfterCompaction = undefined;
	state.lifecycleStartedAtMs = undefined;
}

export function getAbortInvalidationReason(timedOut: boolean): InvalidationReason {
	return timedOut ? InvalidationReason.TIMEOUT : InvalidationReason.CANCELLED;
}
