import type { ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { InvalidationReason } from "./constants";
import type { ReadyJob, ResolvedCompactionSettings } from "./types";
import { estimateMessagesTokens, getThinkingLevel, isToolResultEntry, modelKey, settingsKey } from "./utils";

function buildPreviewCompactionEntry(job: ReadyJob, currentPath: readonly SessionEntry[]): SessionEntry {
	return {
		type: "compaction",
		id: "__async_prefix_compaction_preview__",
		parentId: currentPath[currentPath.length - 1]?.id ?? null,
		timestamp: new Date().toISOString(),
		summary: job.result.summary,
		firstKeptEntryId: job.result.firstKeptEntryId,
		tokensBefore: job.result.tokensBefore,
		details: job.result.details,
	};
}

function estimateAfterApply(job: ReadyJob, currentPath: readonly SessionEntry[]): number {
	const previewEntry = buildPreviewCompactionEntry(job, currentPath);
	return estimateMessagesTokens(buildSessionContext([...currentPath, previewEntry]).messages);
}

export function getReadyJobContextInvalidationReason(
	job: ReadyJob,
	ctx: ExtensionContext,
	settings: ResolvedCompactionSettings,
): InvalidationReason | undefined {
	if (job.sessionId !== ctx.sessionManager.getSessionId()) {
		return InvalidationReason.SESSION_CHANGED;
	}
	if (!ctx.model || job.modelKey !== modelKey(ctx.model)) {
		return InvalidationReason.MODEL_CHANGED;
	}
	if (job.settingsKey !== settingsKey(settings)) {
		return InvalidationReason.SETTINGS_CHANGED;
	}
	if (job.result.firstKeptEntryId !== job.firstKeptEntryId) {
		return InvalidationReason.FIRST_KEPT_MISMATCH;
	}

	const currentPath = ctx.sessionManager.getBranch();
	if (job.thinkingLevel !== getThinkingLevel(currentPath)) {
		return InvalidationReason.THINKING_CHANGED;
	}

	const firstKeptIndex = currentPath.findIndex((entry) => entry.id === job.firstKeptEntryId);
	if (firstKeptIndex === -1) {
		return InvalidationReason.FIRST_KEPT_MISSING;
	}
	if (isToolResultEntry(currentPath[firstKeptIndex]!)) {
		return InvalidationReason.FIRST_KEPT_TOOL_RESULT;
	}

	const snapshotLeafIndex = currentPath.findIndex((entry) => entry.id === job.snapshotLeafId);
	if (snapshotLeafIndex === -1) {
		return InvalidationReason.SNAPSHOT_LEAF_MISSING;
	}
	if (firstKeptIndex > snapshotLeafIndex) {
		return InvalidationReason.FIRST_KEPT_AFTER_SNAPSHOT;
	}

	const maxAfter = (ctx.model.contextWindow ?? 0) - settings.reserveTokens;
	if (maxAfter > 0 && estimateAfterApply(job, currentPath) > maxAfter) {
		return InvalidationReason.TOO_LARGE;
	}

	return undefined;
}

export function validateReadyJob(
	job: ReadyJob,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): InvalidationReason | undefined {
	if (event.customInstructions?.trim()) {
		return InvalidationReason.CUSTOM_INSTRUCTIONS;
	}
	return getReadyJobContextInvalidationReason(job, ctx, event.preparation.settings);
}
