import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBuiltinPiCompactionAdapter } from "./adapter";
import { registerAsyncCompaction } from "./core";
import type { AsyncCompactionCoreDependencies } from "./core";
import { buildAsyncCompactionResult } from "./job";

export default function asyncPrefixCompaction(
	pi: ExtensionAPI,
	injectedDeps: Partial<AsyncCompactionCoreDependencies> = {},
): void {
	registerAsyncCompaction(
		pi,
		createBuiltinPiCompactionAdapter(buildAsyncCompactionResult),
		{ commandName: "async-compact-now" },
		injectedDeps,
	);
}
