import type { Api, Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, calculateContextTokens, estimateTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_START_RATIO, DEFAULT_TIMEOUT_MS } from "./constants";
import type { AsyncCompactionMarker, ResolvedCompactionSettings } from "./types";

type StartWindow =
	| {
			readonly kind: "unknown";
	  }
	| {
			readonly kind: "empty";
			readonly contextWindow: number;
			readonly startRatio: number;
			readonly reserveTokens: number;
	  }
	| {
			readonly kind: "available";
			readonly startThreshold: number;
			readonly forceThreshold: number;
	  };

function readNumberSetting(name: string, defaultValue: number): number {
	const value = process.env[name];
	if (!value) return defaultValue;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function getStartRatio(): number {
	return Math.max(0, Math.min(1, readNumberSetting("PI_ASYNC_PREFIX_COMPACTION_START_RATIO", DEFAULT_START_RATIO)));
}

export function getTimeoutMs(): number {
	return Math.max(0, Math.floor(readNumberSetting("PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)));
}

export function isEnabled(): boolean {
	return process.env.PI_ASYNC_PREFIX_COMPACTION !== "0";
}

export function getStartWindow(contextWindow: number | undefined, startRatio: number, reserveTokens: number): StartWindow {
	if (!contextWindow || contextWindow <= 0) return { kind: "unknown" };
	const startThreshold = Math.floor(contextWindow * startRatio);
	const forceThreshold = contextWindow - reserveTokens;
	if (startThreshold >= forceThreshold) {
		return { kind: "empty", contextWindow, startRatio, reserveTokens };
	}
	return { kind: "available", startThreshold, forceThreshold };
}

export function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function settingsKey(settings: ResolvedCompactionSettings): string {
	return JSON.stringify({
		enabled: settings.enabled,
		reserveTokens: settings.reserveTokens,
		keepRecentTokens: settings.keepRecentTokens,
	});
}

export function getAsyncCompactionMarker(value: unknown): AsyncCompactionMarker | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const marker = (value as Record<string, unknown>).asyncPrefixCompaction;
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined;
	const fields = marker as Record<string, unknown>;
	if (
		typeof fields.adapterId !== "string" ||
		typeof fields.jobId !== "string" ||
		typeof fields.snapshotLeafId !== "string" ||
		typeof fields.modelKey !== "string" ||
		!isThinkingLevel(fields.thinkingLevel) ||
		typeof fields.settingsKey !== "string" ||
		typeof fields.promptVersion !== "string"
	) {
		return undefined;
	}
	return {
		adapterId: fields.adapterId,
		jobId: fields.jobId,
		snapshotLeafId: fields.snapshotLeafId,
		modelKey: fields.modelKey,
		thinkingLevel: fields.thinkingLevel,
		settingsKey: fields.settingsKey,
		promptVersion: fields.promptVersion,
	};
}

export function getCompactionSettings(ctx: ExtensionContext): ResolvedCompactionSettings {
	return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings();
}

export function getRetrySettings(ctx: ExtensionContext): RetryPolicy {
	return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getRetrySettings();
}

export function getThinkingLevel(pathEntries: readonly SessionEntry[]): ThinkingLevel {
	const thinkingLevel = buildSessionContext([...pathEntries]).thinkingLevel;
	return isThinkingLevel(thinkingLevel) ? thinkingLevel : "off";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

export function isToolResultEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "toolResult";
}

export function estimateMessagesTokens(messages: readonly Parameters<typeof estimateTokens>[0][]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

function getAssistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	if (!message.usage || calculateContextTokens(message.usage) <= 0) return undefined;
	return message.usage;
}

export function estimateContextUsageTokens(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		const usage = getAssistantUsage(message);
		if (!usage) continue;

		let trailingTokens = 0;
		for (let trailingIndex = index + 1; trailingIndex < messages.length; trailingIndex++) {
			const trailingMessage = messages[trailingIndex];
			if (trailingMessage) trailingTokens += estimateTokens(trailingMessage);
		}
		return calculateContextTokens(usage) + trailingTokens;
	}

	return estimateMessagesTokens(messages);
}

export function getStringArrayProperty(value: unknown, key: string): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const property = (value as Record<string, unknown>)[key];
	return Array.isArray(property) ? property.filter((item): item is string => typeof item === "string") : [];
}
