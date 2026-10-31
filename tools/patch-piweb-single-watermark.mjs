// Applied after the redesign overlay, before source writes. `change` rejects drift.
export function integrateSingleWatermark({ change }) {
  const rpc = 'lib/rpc-manager.ts';
  const lightweightPath = `resolve(agentDir, "extensions/lop-async-compaction/compaction-only.ts")`;
  change(rpc, '            noExtensions: !subagentResources.loadExtensions,', `            noExtensions: !subagentResources.loadExtensions,
            ...(!subagentResources.loadExtensions ? { additionalExtensionPaths: [${lightweightPath}] } : {}),`);
  change(rpc, '? { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: [exactSystemPromptExtension] }', `? { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS, additionalExtensionPaths: [${lightweightPath}], extensionFactories: [exactSystemPromptExtension] }`);
  const subagent = 'lib/subagent-runtime.ts';
  change(subagent, 'import type { ThinkingLevel } from "@earendil-works/pi-agent-core";', 'import { resolve } from "path";\nimport type { ThinkingLevel } from "@earendil-works/pi-agent-core";');
  change(subagent, '          noExtensions: !profile.loadExtensions,', `          noExtensions: !profile.loadExtensions,
          ...(!profile.loadExtensions ? { additionalExtensionPaths: [${lightweightPath}] } : {}),`);
  const models = 'components/ModelsConfig.tsx';
  change(models, '  contextWindow?: number;\n', '');
  change(models, `  if (model.contextWindow === undefined && preset.contextWindow !== undefined) {
    next.contextWindow = preset.contextWindow;
    appliedCount += 1;
  }
`, '');
  change(models, `          <Field label={t("models.contextWindow")}>
            <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
              onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
          </Field>
`, '');
  const catalog = 'lib/model-catalog.ts';
  change(catalog, '  contextWindow?: number;\n', '', 2);
  change(catalog, '    contextWindow: entry.contextWindow,\n', '');
  change(catalog, `    contextWindow: modeValue(
      entries.flatMap((entry) => entry.contextWindow === undefined ? [] : [entry.contextWindow]),
      total,
      String,
    ),
`, '');
  change(catalog, '        const contextWindow = optionalPositiveNumber(rawModel.limit.context);\n', '');
  change(catalog, '        if (contextWindow !== undefined) entry.contextWindow = contextWindow;\n', '');
  const store = 'lib/models-config-store.ts';
  change(store, 'function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {', `// Old clients and model imports cannot reintroduce a local context-window registration.
function stripContextWindows(data: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(data);
  if (!isRecord(result.providers)) return result;
  for (const provider of Object.values(result.providers)) {
    if (!isRecord(provider)) continue;
    delete provider.contextWindow;
    if (Array.isArray(provider.models)) for (const model of provider.models) {
      if (isRecord(model)) delete model.contextWindow;
    }
    if (isRecord(provider.modelOverrides)) for (const override of Object.values(provider.modelOverrides)) {
      if (isRecord(override)) delete override.contextWindow;
    }
  }
  return result;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {`);
  change(store, '  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(data));', '  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(stripContextWindows(data)));');
  const shell = 'components/AppShell.tsx';
  change(shell, `    // >70% warning, >90% danger; colours come from the tokens via data-level.
    let contextLevel: "warning" | "danger" | undefined;
    let desktopContextText: string | null = null;
    let mobileContextText: string | null = null;
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      if (percent !== null && percent > 90) contextLevel = "danger";
      else if (percent !== null && percent > 70) contextLevel = "warning";
      desktopContextText = percent !== null ? \`\${percent.toFixed(0)}%\` : "—";
      mobileContextText = percent !== null ? \`\${percent.toFixed(0)}%\` : null;
    }
`, `    // Capacity is unknown: display observed context tokens, not an invented percentage.
    const contextLevel = undefined;
    const desktopContextText = contextUsage?.tokens != null ? formatCompact(contextUsage.tokens) : null;
    const mobileContextText = desktopContextText;
`);
  change(shell, `    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      tooltipParts.push(percent !== null
        ? translate("session.usageContextTooltip", { percent: \`\${percent.toFixed(1)}%\`, window: contextUsage.contextWindow.toLocaleString(locale) })
        : translate("session.usageContextPending", { window: contextUsage.contextWindow.toLocaleString(locale) }));
    }`, `    if (contextUsage?.tokens != null) {
      tooltipParts.push(\`\${translate("session.usageContext")}: \${contextUsage.tokens.toLocaleString(locale)} tokens\`);
    }`);
  change(shell, `                <span className="pw-tb-usage-meter" aria-hidden="true">
                  <i style={{ width: \`\${Math.max(0, Math.min(100, contextUsage?.percent ?? 0))}%\` }} />
                </span>
`, '');
  change(shell, '...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),', '...(ctx?.tokens != null ? [[translate("session.context"), formatCompact(ctx.tokens)]] : []),');
}
