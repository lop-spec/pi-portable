import crypto from 'node:crypto';
// Stop releases the composer before transport cleanup. Model/effort edits while busy
// are next-request preferences, never mutations of an in-flight model turn.
export function integrateImmediateStop({change, set, template}) {
  const hook='hooks/useAgentSession.ts', input='components/ChatInput.tsx';
  const keyboard='hooks/useKeyboardShortcuts.ts';
  set('lib/portable-stop-guard.ts', template('immediate-stop/stop-guard.ts'));
  change(keyboard, 'import { useEffect } from "react";', 'import { useEffect } from "react";\nimport { shouldStopOnGlobalEscape } from "@/lib/portable-stop-guard";');
  change(keyboard, `export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}`, `export function registerAbortHandler(handler: (() => void) | null): () => void {
  globalAbortHandler = handler;
  return () => { if (globalAbortHandler === handler) globalAbortHandler = null; };
}`);
  change(keyboard, `        if (!globalAbortHandler) return;

        const tag = (e.target as HTMLElement)?.tagName;
        // Let textarea/input handle Esc internally (ChatInput menus / stop).
        if (tag === "TEXTAREA" || tag === "INPUT") return;`, `        if (!globalAbortHandler || !shouldStopOnGlobalEscape(e)) return;`);
  change(input, '  onAbort: () => void;', '  onAbort: (source?: string) => void;');
  change(input, '        onAbort();', '        onAbort("keyboard-input");');
  change(input, '                    onClick={onAbort}', '                    onClick={() => onAbort("button")}');
  change(input,'                  onChange={onModelChange}\n                  disabled={isStreaming}', '                  onChange={onModelChange}\n                  disabled={false}');
  change(input,'                      if (isStreaming) return;\n                      setThinkingDropdownOpen', '                      setThinkingDropdownOpen');
  change(input,`                    disabled={isStreaming}
                    title={isStreaming
                      ? t("chat.currentReasoning", { level: thinkingDisplayLabel })
                      : t("chat.changeReasoning", { level: thinkingDisplayLabel })}`,`                    title={isStreaming ? "用于下一次请求" : t("chat.changeReasoning", { level: thinkingDisplayLabel })}`);
  change(hook,'  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);',`  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const stoppedSessionsRef = useRef(new Set<string>());
  const stopBarriersRef = useRef(new Map<string, Promise<unknown>>());
  const stopTicketsRef = useRef(new Map<string, string>());
  const nextSelectionRef = useRef(new Map<string, { model?: {provider: string; modelId: string}; thinking?: ThinkingLevelOption }>());
  useLayoutEffect(() => {
    const sid = sessionIdRef.current;
    const pending = asConcreteThinkingLevel(readPendingThinking(sid));
    if (sid && pending) {
      nextSelectionRef.current.set(sid, {...nextSelectionRef.current.get(sid), thinking: pending});
      setCurrentThinkingOverride(pending);
    }
  }, []);`);
  change(hook,'setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);\n      setCurrentThinkingOverride(null);', 'if (!nextSelectionRef.current.get(sid)?.model) setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);\n      setCurrentThinkingOverride((current) => nextSelectionRef.current.get(sid)?.thinking ? current : null);');
  change(hook,'  const reconcileAgentState = useCallback(async (sid: string) => {', '  const reconcileAgentState = useCallback(async (sid: string) => {\n    if (stoppedSessionsRef.current.has(sid)) return;');
  change(hook,'  const handleAgentEvent = useCallback((event: AgentEvent) => {', '  const handleAgentEvent = useCallback((event: AgentEvent) => {\n    if (sessionIdRef.current && stoppedSessionsRef.current.has(sessionIdRef.current)) return;');
  change(hook,`  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;`, `  const handleAbort = useCallback(async (stopSource?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (stopBarriersRef.current.has(sid) && !agentRunningRef.current && !bashRunningRef.current) return;
    const wasBash = bashRunningRef.current;
    stoppedSessionsRef.current.add(sid);
    ++promptRunIdRef.current;
    rpcPromptPendingRef.current = false;
    sdkAgentActiveRef.current = false;
    cancelEventStreamGrace();
    closeEvents();
    settleUiStage();
    bashRunningRef.current = false;
    setBashRunning(false);
    setPendingBash(null);
    setIsCompacting(false);
    setExtensionDialog(null);
    setQueuedMessages({steering: [], followUp: []});
    const stopToken = crypto.randomUUID();
    stopTicketsRef.current.set(sid, stopToken);
    const barrier = sendAgentCommand(sid, { type: wasBash ? "abort_bash" : "abort", stopToken, stopSource });
    stopBarriersRef.current.set(sid, barrier);
    void barrier.catch((e) => { if (stopBarriersRef.current.get(sid) === barrier) stopBarriersRef.current.delete(sid); addNotice({type: "error", message: "后台停止失败：" + String(e)}); });
    return;
    /* legacy stop path (unreachable; retained below for upstream context) */`);
  // Remove the old abort body completely instead of leaving a second transport call.
  change(hook,`    /* legacy stop path (unreachable; retained below for upstream context) */
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);`, `  }, [addNotice, cancelEventStreamGrace, closeEvents, settleUiStage]);`);
  change(hook,'  const handleModelChange = useCallback(async (provider: string, modelId: string) => {\n    if (modelSwitchPendingRef.current) return;',`  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    const selectionSid = sessionIdRef.current;
    if (selectionSid && (agentRunningRef.current || stopBarriersRef.current.has(selectionSid))) {
      const model = {provider, modelId};
      nextSelectionRef.current.set(selectionSid, {...nextSelectionRef.current.get(selectionSid), model});
      setCurrentModelOverride(model);
      if (isNew) { newSessionModelOverrideRef.current = model; setNewSessionModel(model); }
      return;
    }
    if (modelSwitchPendingRef.current) return;`);
  change(hook,'  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {',`  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    const selectionSid = sessionIdRef.current;
    if (selectionSid && level !== "auto" && (agentRunningRef.current || stopBarriersRef.current.has(selectionSid))) {
      writeThinkingPreference(level);
      savePendingThinking(selectionSid, level);
      nextSelectionRef.current.set(selectionSid, {...nextSelectionRef.current.get(selectionSid), thinking: level});
      setCurrentThinkingOverride(level);
      if (isNew) setNewSessionThinkingLevel(level);
      return;
    }
    if (selectionSid && level !== "auto") {
      const queued = nextSelectionRef.current.get(selectionSid);
      if (queued?.thinking) {
        clearPendingThinking(selectionSid, queued.thinking);
        if (queued.model) nextSelectionRef.current.set(selectionSid, {model: queued.model});
        else nextSelectionRef.current.delete(selectionSid);
      }
    }`);
  change(hook,'    let promptRequestStarted = false;\n\n    try {',`    let promptRequestStarted = false;
    const selectionSid = sessionIdRef.current;
    const selection = selectionSid ? nextSelectionRef.current.get(selectionSid) : undefined;
    const stopTicket = selectionSid ? stopTicketsRef.current.get(selectionSid) : undefined;
    const prepareNextRequest = async (sid: string) => {
      const barrier = stopBarriersRef.current.get(sid);
      if (barrier) await Promise.race([barrier.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 750))]);
      if (promptRunIdRef.current !== promptRunId) throw new Error("Request cancelled before dispatch");
      stopBarriersRef.current.delete(sid);
      stopTicketsRef.current.delete(sid);
      stoppedSessionsRef.current.delete(sid);
      if (selection?.model) await sendAgentCommand(sid, {type: "set_model", ...selection.model});
      if (selection?.thinking) {
        await sendAgentCommand(sid, {type: "set_thinking_level", level: selection.thinking});
        clearPendingThinking(sid, selection.thinking);
        if (sessionIdRef.current === sid) setLiveThinkingLevel(asConcreteThinkingLevel(selection.thinking));
      }
      if (nextSelectionRef.current.get(sid) === selection) nextSelectionRef.current.delete(sid);
    };

    try {`);
  change(hook,'        await ensureEventsConnected(sid);\n        promptRequestStarted = true;', '        await prepareNextRequest(sid);\n        await ensureEventsConnected(sid);\n        promptRequestStarted = true;');
  change(hook,'        sentSessionId = session.id;\n        await ensureEventsConnected(session.id);', '        sentSessionId = session.id;\n        await prepareNextRequest(session.id);\n        await ensureEventsConnected(session.id);');
  change(hook,'        promptRequestStarted = true;\n        await sendAgentCommand', '        if (promptRunIdRef.current !== promptRunId) return;\n        promptRequestStarted = true;\n        await sendAgentCommand', 2);
  change(hook, '          type: "prompt",\n          message,', '          type: "prompt",\n          ...(stopTicket ? {afterStop: stopTicket} : {}),\n          message,', 2);
  change('lib/rpc-manager.ts', 'import { setPortableServiceTier } from "@/lib/pi-portable-tier.js";', 'import { setPortableServiceTier } from "@/lib/pi-portable-tier.js";\nimport { createStopGate } from "@/lib/portable-stop-guard";');
  change('lib/rpc-manager.ts', '  private pendingPromptCount = 0;', '  private pendingPromptCount = 0;\n  private stopGate = createStopGate();');
  change('lib/rpc-manager.ts', '        const releaseAdmission = await this.acquirePromptAdmission();', `        if (typeof command.afterStop === "string") {
          await this.stopGate.run(command.afterStop, async () => {
            console.info(JSON.stringify({event: "pi-agent-stop", sessionId: this.sessionId, source: "after-stop", streaming: this.inner.isStreaming}));
            this.inner.clearQueue();
            await this.inner.abort();
          });
        }
        const releaseAdmission = await this.acquirePromptAdmission();`);
  change('lib/rpc-manager.ts', `      case "abort":
        this.forceShutdownOnIdle = true;
        // Stop must unwind`, `      case "abort":
        return await this.stopGate.run(command.stopToken, async () => {
        const source = ["button", "keyboard-input", "keyboard-global"].includes(String(command.stopSource)) ? command.stopSource : "rpc";
        console.info(JSON.stringify({event: "pi-agent-stop", sessionId: this.sessionId, source, streaming: this.inner.isStreaming}));
        this.forceShutdownOnIdle = true;
        this.inner.clearQueue();
        this.inner.abortCompaction();
        if (this.inner.isBashRunning) this.inner.abortBash();
        // Stop must unwind`);
  change('lib/rpc-manager.ts', `          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

      case "get_state":`, `          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }
        });

      case "get_state":`);
  change('components/ChatInput.streaming-thinking.test.mjs', 'keeps one thinking control and disables it while the session is busy', 'keeps one thinking control editable while the session is busy');
  change('components/ChatInput.streaming-thinking.test.mjs', '  assert.match(thinkingControl, /disabled=\\{isStreaming\\}/);', '  assert.doesNotMatch(thinkingControl.slice(0, thinkingControl.indexOf("aria-label=")), /disabled=\\{isStreaming\\}/);');
  change('components/ChatInput.streaming-thinking.test.mjs', '  assert.match(thinkingControl, /t\\("chat\\.currentReasoning", \\{ level: thinkingDisplayLabel \\}\\)/);', '  assert.match(thinkingControl, /用于下一次请求/);');
  change(hook,'      console.error("Failed to send message:", e);\n      const definitivelyRejected', '      console.error("Failed to send message:", e);\n      if (promptRunIdRef.current !== promptRunId) return;\n      const definitivelyRejected');
}

export function integrateStopHandlerCleanup({get, change, template}) {
  change('components/ChatWindow.tsx', `  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);`, `  useEffect(() => registerAbortHandler(sessionBusy ? () => { void handleAbort("keyboard-global"); } : null), [sessionBusy, handleAbort]);`);
  const manifest = JSON.parse(template('immediate-stop/stop-safety-manifest.json'));
  const mismatches = Object.entries(manifest.files).flatMap(([name, expected]) => {
    const actual = crypto.createHash('sha256').update(get(name)).digest('hex');
    return actual === expected ? [] : [{name, actual}];
  });
  if (mismatches.length) throw Error('stop-safety final-stage hash mismatch; zero writes: ' + JSON.stringify(mismatches));
}
