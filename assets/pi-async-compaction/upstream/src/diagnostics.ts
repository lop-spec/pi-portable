export type AsyncCompactionWastedWork = "possible" | "confirmed";

interface AsyncCompactionLifecycleEventBase {
	readonly adapterId: string;
	readonly jobId: string;
	readonly durationMs: number;
}

export type AsyncCompactionLifecycleEvent =
	| {
			readonly event: "started";
			readonly adapterId: string;
			readonly jobId: string;
			readonly startedAtMs: number;
	  }
	| (AsyncCompactionLifecycleEventBase & {
			readonly event: "ready" | "handed_off";
	  })
	| (AsyncCompactionLifecycleEventBase & {
			readonly event: "invalidated";
			readonly reason: string;
			readonly wastedWork: AsyncCompactionWastedWork;
	  })
	| (AsyncCompactionLifecycleEventBase & {
			readonly event: "failed";
			readonly phase: "background" | "apply";
			readonly error: string;
			readonly wastedWork: AsyncCompactionWastedWork;
	  });

export type AsyncCompactionLifecycleObserver = (event: AsyncCompactionLifecycleEvent) => void;

export function emitLifecycleEvent(
	observer: AsyncCompactionLifecycleObserver | undefined,
	event: AsyncCompactionLifecycleEvent,
): void {
	if (!observer) return;
	try {
		observer(event);
	} catch (error) {
		console.warn("async compaction lifecycle observer failed", error);
	}
}

export function getLifecycleDurationMs(startedAtMs: number | undefined): number {
	return startedAtMs === undefined ? 0 : Math.max(0, Date.now() - startedAtMs);
}
