export const EXTENSION_NAME = "async-prefix-compaction";
export const BUILTIN_ADAPTER_ID = "builtin-pi-compaction";
export const BUILTIN_ADAPTER_LABEL = "built-in Pi compaction";
export const SUMMARY_PROMPT_VERSION = "pi-compact-background-v1";
export const DEFAULT_START_RATIO = 0.8;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const AUTO_RESUME_PROMPT = "continue";

export const InvalidationReason = {
	FIRST_KEPT_MISSING: "first_kept_missing",
	FIRST_KEPT_TOOL_RESULT: "first_kept_tool_result",
	SNAPSHOT_LEAF_MISSING: "snapshot_leaf_missing",
	FIRST_KEPT_AFTER_SNAPSHOT: "first_kept_after_snapshot",
	FIRST_KEPT_MISMATCH: "first_kept_mismatch",
	MODEL_CHANGED: "model_changed",
	SESSION_CHANGED: "session_changed",
	THINKING_CHANGED: "thinking_changed",
	SETTINGS_CHANGED: "settings_changed",
	CUSTOM_INSTRUCTIONS: "custom_instructions",
	TOO_LARGE: "too_large",
	SUPERSEDED: "superseded",
	SYNC_FALLBACK: "sync_fallback",
	CANCELLED: "cancelled",
	TIMEOUT: "timeout",
	FAILED: "failed",
} as const;

export type JobStatus = "idle" | "pending" | "ready" | "stale" | "failed";
export type InvalidationReason = (typeof InvalidationReason)[keyof typeof InvalidationReason];
