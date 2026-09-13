import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_ADAPTER_ID, BUILTIN_ADAPTER_LABEL, SUMMARY_PROMPT_VERSION } from "./constants";
import { prepareAsyncCompaction } from "./preparation";
import type { LocalCompactionPreparation, ResolvedCompactionSettings, Snapshot } from "./types";
import { getThinkingLevel, modelKey, settingsKey } from "./utils";

export interface AdapterPrepareInput {
	readonly ctx: ExtensionContext;
	readonly settings: ResolvedCompactionSettings;
}

export interface AdapterSnapshotInput<TPrepared> {
	readonly ctx: ExtensionContext;
	readonly jobId: string;
	readonly prepared: TPrepared;
	readonly settings: ResolvedCompactionSettings;
}

export interface AdapterRunInput<TPrepared> {
	readonly ctx: ExtensionContext;
	readonly prepared: TPrepared;
	readonly signal: AbortSignal;
}

export interface AdapterCompactionInput<TPrepared, TResult> {
	readonly prepared: TPrepared;
	readonly snapshot: Snapshot;
	readonly result: TResult;
}

export interface AsyncCompactionAdapter<TPrepared, TResult> {
	readonly id: string;
	readonly label: string;
	prepare(input: AdapterPrepareInput): TPrepared | undefined;
	createSnapshot(input: AdapterSnapshotInput<TPrepared>): Snapshot;
	run(input: AdapterRunInput<TPrepared>): Promise<TResult>;
	toCompaction(input: AdapterCompactionInput<TPrepared, TResult>): CompactionResult;
}

export interface BuiltinPiPreparedCompaction {
	readonly preparation: LocalCompactionPreparation;
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
	readonly snapshotLeafId: string;
}

export type BuildAsyncCompactionResult = (
	preparation: LocalCompactionPreparation,
	model: Model<Api>,
	ctx: ExtensionContext,
	thinkingLevel: ThinkingLevel,
	signal: AbortSignal,
) => Promise<CompactionResult>;

export function createBuiltinPiCompactionAdapter(
	buildAsyncCompactionResult: BuildAsyncCompactionResult,
): AsyncCompactionAdapter<BuiltinPiPreparedCompaction, CompactionResult> {
	return {
		id: BUILTIN_ADAPTER_ID,
		label: BUILTIN_ADAPTER_LABEL,
		prepare: ({ ctx, settings }) => {
			const branch = ctx.sessionManager.getBranch();
			const preparation = prepareAsyncCompaction(branch, settings);
			if (!preparation || !ctx.model) return undefined;

			const snapshotLeafId = branch[branch.length - 1]?.id;
			if (!snapshotLeafId) return undefined;

			return {
				preparation,
				model: ctx.model,
				thinkingLevel: getThinkingLevel(branch),
				snapshotLeafId,
			};
		},
		createSnapshot: ({ ctx, jobId, prepared, settings }) => ({
			jobId,
			sessionId: ctx.sessionManager.getSessionId(),
			snapshotLeafId: prepared.snapshotLeafId,
			firstKeptEntryId: prepared.preparation.firstKeptEntryId,
			modelKey: modelKey(prepared.model),
			thinkingLevel: prepared.thinkingLevel,
			settingsKey: settingsKey(settings),
			promptVersion: SUMMARY_PROMPT_VERSION,
		}),
		run: ({ ctx, prepared, signal }) =>
			buildAsyncCompactionResult(prepared.preparation, prepared.model, ctx, prepared.thinkingLevel, signal),
		toCompaction: ({ result }) => result,
	};
}
