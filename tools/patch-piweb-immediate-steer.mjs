// Pi's steer queue waits for a whole assistant/tool turn, including in 1.5.2.
// Compose its public abort() + prompt() instead; never mutate agent internals.
export function integrateImmediateSteer({change}) {
  const rpc = 'lib/rpc-manager.ts';
  change(rpc, '  private pendingPromptCount = 0;', '  private pendingPromptCount = 0;\n  private promptInterruptRevision = 0;');
  change(rpc, '          this.pendingPromptCount += 1;\n          let prompt: Promise<void>;\n          try {', `          // Keep the wrapper busy across cancellation: no false completion or
          // idle shutdown between the interrupted run and its replacement.
          const interruptRevision = this.promptInterruptRevision;
          this.pendingPromptCount += 1;
          let prompt: Promise<void>;
          try {
            if (streamingBehavior === "steer"
              && !(command.message as string).trimStart().startsWith("/")
              && (this.inner.isStreaming || this.inner.isCompacting)) {
              // Native abort cancels the provider/tools and waits for finalized
              // tool results and session persistence. It does NOT clear queues.
              await this.inner.abort();
              if (!this._alive || interruptRevision !== this.promptInterruptRevision) {
                throw new Error("引导已被停止，消息未提交");
              }
            }`);
  change(rpc, '      case "abort":\n        return await this.stopGate.run', '      case "abort":\n        this.promptInterruptRevision += 1;\n        return await this.stopGate.run');
  for (const [locale, before, after] of [
    ['zh-CN', '引导', '立即引导'],
    ['zh-TW', '引導', '立即引導'],
    ['en', 'Steer', 'Steer now'],
  ]) {
    change(`lib/i18n/messages/${locale}.ts`, `"chat.steer": "${before}"`, `"chat.steer": "${after}"`);
  }
}
