// Default choices belong to new conversations; loaded sessions own their snapshots.
export function integrateSessionSettings({set, change, prepend, template}) {
  const hook = 'hooks/useAgentSession.ts', rpc = 'lib/rpc-manager.ts';
  set('lib/portable-session-settings.mjs', template('portable-session-settings.mjs'));
  prepend(rpc, 'import { savedSessionSettings } from "@/lib/portable-session-settings.mjs";\nimport { getSupportedThinkingLevels } from "@earendil-works/pi-ai";\n');
  // A session-local model choice must not silently become the app-wide default.
  change(rpc, 'await this.inner.setModel(model, { persist: true });', `const persistDefault = command.persistDefault === true && !this.inner.sessionManager.getBranch().some(
          (entry) => entry.type === "message" && entry.message.role !== "system",
        );
        await this.inner.setModel(model, { persist: persistDefault });`);
  // Free routing and web providers keep automatic highest effort on an explicit model switch.
  // Reopening a conversation never enters this branch; manual effort edits still win later.
  change(rpc, '        this.inner.setThinkingLevel(sessionThinkingLevel);', `        const switchedThinkingLevel = model.provider === "pi-free" || model.provider.endsWith("-web")
          ? getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]).at(-1) ?? sessionThinkingLevel
          : sessionThinkingLevel;
        this.inner.setThinkingLevel(switchedThinkingLevel);`);
  // Only the new-draft path may opt into saving the next conversation's default.
  change(hook, '        await sendAgentCommand(sid, { type: "set_model", provider, modelId });', `        await sendAgentCommand(sid, { type: "set_model", provider, modelId, persistDefault: true });
        if (provider === "pi-free" || provider.endsWith("-web")) {
          const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
          if (sessionHookMountedRef.current && sessionIdRef.current === sid) {
            syncLiveModel(state);
            const resolved = asConcreteThinkingLevel(state?.thinkingLevel);
            if (resolved) {
              thinkingLevelOverrideRef.current = resolved;
              setNewSessionThinkingLevel(resolved);
            }
          }
        }`);
  change(hook, '[addNotice, currentModelOverride, ensureNewSession, isNew, loadSession, setNewSessionModel]', '[addNotice, currentModelOverride, ensureNewSession, isNew, loadSession, setNewSessionModel, syncLiveModel]');
  change(hook, '    writeThinkingPreference(level);', '    if (isNew) writeThinkingPreference(level);', 2);
  change(hook, ': currentModel ?? (data?.context.messages.length === 0 ? newSessionDefaultModel : null);', ': currentModel;');
  change(hook, ': currentThinkingLevel ?? (data?.context.messages.length === 0 ? newSessionDefaultThinkingLevel : null);', ': currentThinkingLevel;');
  change(hook, `    setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);`, `    if (!sessionIdRef.current) setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);`);
  // Explicit replacement is distinct from new defaults and implicit tool-wrapper rebuilds.
  change(rpc, '  initialModel?: { provider: string; modelId: string };', '  initialModel?: { provider: string; modelId: string };\n  replacementModel?: { provider: string; modelId: string };');
  change(rpc, '  const { initialModel, allowInitialModelFallback, thinkingLevel } = options;', '  const { initialModel, allowInitialModelFallback, thinkingLevel, replacementModel } = options;');
  change('app/api/agent/[id]/route.ts', `    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });`, `    if (body.type === "set_model" && (typeof body.provider !== "string" || !body.provider.trim()
        || typeof body.modelId !== "string" || !body.modelId.trim())) {
      throw new Error("Invalid model selection");
    }
    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(body.type === "set_model"
        ? { replacementModel: { provider: body.provider as string, modelId: body.modelId as string } }
        : {}),
    });`);
  // Saved model/thinking events count even when no user message has been sent.
  change(rpc, `    const savedModel = hasExistingMessages
      ? getLatestModelChange(branch as unknown as SessionEntry[])
      : null;`, `    const savedPreferences = savedSessionSettings(branch as unknown as SessionEntry[]);
    const restoringSession = Boolean(sessionFile);
    const savedModel = restoringSession ? savedPreferences.model : null;`);
  change(rpc, '    const initial = hasExistingMessages ? null : selectInitialModelScope(scope, {', '    const initial = restoringSession || hasExistingMessages ? null : selectInitialModelScope(scope, {');
  change(rpc, `    const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)
      ? restoredModel
      : initial?.model;`, `    let explicitReplacement = restoringSession && replacementModel
      ? services.modelRuntime.getModel(replacementModel.provider, replacementModel.modelId)
      : undefined;
    if (restoringSession && replacementModel && !explicitReplacement) {
      await services.modelRuntime.refresh({ allowNetwork: false });
      explicitReplacement = services.modelRuntime.getModel(replacementModel.provider, replacementModel.modelId);
      if (!explicitReplacement) throw new Error(\`Model not found: \${replacementModel.provider}/\${replacementModel.modelId}\`);
    }
    if (!explicitReplacement && restoringSession && savedModel && (!restoredModel || !services.modelRuntime.hasConfiguredAuth(restoredModel.provider))) {
      throw new Error(\`Saved session model is unavailable: \${savedModel.provider}/\${savedModel.modelId}. Choose a replacement for this conversation explicitly.\`);
    }
    const startupModel = explicitReplacement ?? (restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)
      ? restoredModel
      : initial?.model);`);
  change(rpc, '      ...(initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),', `      ...(restoringSession && savedPreferences.thinkingLevel !== undefined
        ? { thinkingLevel: savedPreferences.thinkingLevel as ThinkingLevel }
        : initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),`);
  // Recreating an existing wrapper (e.g. tool preset change) isn't a new default choice.
  change(rpc, `        ...(effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),`, `        ...(!sessionFile && effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(!sessionFile && thinkingLevel ? { thinkingLevel } : {}),`);
}
