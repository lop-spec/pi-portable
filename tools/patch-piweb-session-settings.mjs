// Default choices belong to new conversations; loaded sessions own their snapshots.
export function integrateSessionSettings({set, change, prepend, template}) {
  const hook = 'hooks/useAgentSession.ts', rpc = 'lib/rpc-manager.ts';
  set('lib/portable-session-settings.mjs', template('portable-session-settings.mjs'));
  prepend(rpc, 'import { savedSessionSettings } from "@/lib/portable-session-settings.mjs";\n');
  // A session-local model choice must not silently become the app-wide default.
  change(rpc, 'await this.inner.setModel(model, { persist: true });', `const persistDefault = command.persistDefault === true && !this.inner.sessionManager.getBranch().some(
          (entry) => entry.type === "message" && entry.message.role !== "system",
        );
        await this.inner.setModel(model, { persist: persistDefault });`);
  // Only the new-draft path may opt into saving the next conversation's default.
  change(hook, '        await sendAgentCommand(sid, { type: "set_model", provider, modelId });', '        await sendAgentCommand(sid, { type: "set_model", provider, modelId, persistDefault: true });');
  change(hook, '    writeThinkingPreference(level);', '    if (isNew) writeThinkingPreference(level);', 2);
  change(hook, ': currentModel ?? (data?.context.messages.length === 0 ? newSessionDefaultModel : null);', ': currentModel;');
  change(hook, ': currentThinkingLevel ?? (data?.context.messages.length === 0 ? newSessionDefaultThinkingLevel : null);', ': currentThinkingLevel;');
  change(hook, `    setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);`, `    if (!sessionIdRef.current) setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);`);
  // Saved model/thinking events count even when no user message has been sent.
  change(rpc, `    const savedModel = hasExistingMessages
      ? getLatestModelChange(branch as unknown as SessionEntry[])
      : null;`, `    const savedPreferences = savedSessionSettings(branch as unknown as SessionEntry[]);
    const restoringSession = Boolean(sessionFile);
    const savedModel = restoringSession ? savedPreferences.model : null;`);
  change(rpc, '    const initial = hasExistingMessages ? null : selectInitialModelScope(scope, {', '    const initial = restoringSession || hasExistingMessages ? null : selectInitialModelScope(scope, {');
  change(rpc, '    const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)', `    if (restoringSession && savedModel && (!restoredModel || !services.modelRuntime.hasConfiguredAuth(restoredModel.provider))) {
      throw new Error(\`Saved session model is unavailable: \${savedModel.provider}/\${savedModel.modelId}. Choose a replacement for this conversation explicitly.\`);
    }
    const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)`);
  change(rpc, '      ...(initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),', `      ...(restoringSession && savedPreferences.thinkingLevel !== undefined
        ? { thinkingLevel: savedPreferences.thinkingLevel as ThinkingLevel }
        : initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),`);
  // Recreating an existing wrapper (e.g. tool preset change) isn't a new default choice.
  change(rpc, `        ...(effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),`, `        ...(!sessionFile && effectiveInitialModel ? { model: effectiveInitialModel } : {}),
        ...(!sessionFile && thinkingLevel ? { thinkingLevel } : {}),`);
}
