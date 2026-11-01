// Remove Pi Web's notification audio without touching chat, unread state or visible notifications.
// Applied last so all prior integration safety hashes remain meaningful.
export function integrateRemoveSound({ get, set, change }) {
  const shell = 'components/AppShell.tsx';
  const chat = 'components/ChatWindow.tsx';
  const input = 'components/ChatInput.tsx';
  const sidebar = 'components/SessionSidebar.tsx';

  change(shell, 'import { useAudio } from "@/hooks/useAudio";\n', '');
  change(shell, `  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
`, '');
  change(shell, `  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
`, '');
  change(shell, '      if (result?.imageSuccess === true) playDoneSound();\n', '');
  change(shell, '  }, [playDoneSound]);', '  }, []);');
  change(shell, '        onBackgroundTaskDone={handleBackgroundTaskDone}\n', '');
  change(shell, `              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
`, '');

  change(chat, `  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
`, '');
  change(chat, ', soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {', ' }: Props) {');
  change(chat, `  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [completionNotificationsEnabled, onAgentEnd]);

`, '');
  change(chat, 'onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded', 'onAgentEnd, onAttentionNeeded');
  change(chat, '    unlockAudio?.();\n', '');
  change(chat, ', closeQuotedSelection, unlockAudio]);', ', closeQuotedSelection]);');
  change(chat, `  useEffect(() => {
    if (
      !completionNotificationsEnabled
      || !extensionDialog
      || soundedExtensionDialogIdRef.current === extensionDialog.id
    ) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

`, '');
  change(chat, `      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
`, '');
  change(chat, ', handleBuiltinSlashCommand, soundEnabled, onSoundToggle, unlockAudio, newSessionDraftKey,', ', handleBuiltinSlashCommand, newSessionDraftKey,');

  change(input, '  soundEnabled?: boolean;\n  onSoundToggle?: () => void;\n  onAudioUnlock?: () => void;\n', '');
  change(input, '  onAudioUnlock,\n', '');
  change(input, '      onAudioUnlock?.();\n', '');
  change(input, '    onAudioUnlock?.();\n', '', 2);
  change(input, ', onSend, clearInput, onAudioUnlock]);', ', onSend, clearInput]);');
  change(input, ', clearInput, onAudioUnlock, runBuiltinCommand]);', ', clearInput, runBuiltinCommand]);');

  change(sidebar, '  onBackgroundTaskDone?: () => void;\n', '');
  change(sidebar, ', onBackgroundTaskDone, onRunningSessionIdsChange,', ', onRunningSessionIdsChange,');
  change(sidebar, `    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

`, '');
  change(sidebar, ', allSessions, loadSessions, onBackgroundTaskDone]);', ', allSessions, loadSessions]);');
  // The upstream file must no longer contain an audio implementation, even unused.
  set('hooks/useAudio.ts', 'export {};\n');

  // Windows/macOS notification sounds are independent of the removed Web Audio
  // player. Preserve visual notifications while explicitly requesting silence.
  change('lib/browser-notifications.ts', '  const notificationOptions: NotificationOptions = {\n    body: options.body,', '  const notificationOptions: NotificationOptions = {\n    silent: true,\n    body: options.body,');
  change('public/sw.js', '    self.registration.showNotification(title, {\n      body,', '    self.registration.showNotification(title, {\n      silent: true,\n      body,');
  change('lib/browser-notifications.test.mjs', '      body: "Task finished.",\n      tag: "session-complete:session-1",', '      silent: true,\n      body: "Task finished.",\n      tag: "session-complete:session-1",');
  change('lib/browser-notifications.test.mjs', '    options: { body: "Task finished." },', '    options: { silent: true, body: "Task finished." },');
  change('public/sw.test.mjs', '      body: "Task finished.",\n      data: { url: "/?session=session-1" },', '      silent: true,\n      body: "Task finished.",\n      data: { url: "/?session=session-1" },');

  const hookTest = 'hooks/useAgentSession.test.mjs';
  const src = get(hookTest);
  const start = src.indexOf('test("plays the enabled sound once for each extension dialog"');
  const end = src.indexOf('test("routes blocking extension requests through deduplicated browser attention notifications"', start);
  if (start < 0 || end < 0) throw new Error('sound regression test anchors missing; zero writes');
  change(hookTest, src.slice(start, end), `test("subagent browser attention remains suppressed", () => {
  const completionSource = appShellSource.slice(appShellSource.indexOf("  const handleAgentEnd = useCallback"), appShellSource.indexOf("  const handleAttentionNeeded = useCallback"));
  const attentionSource = appShellSource.slice(appShellSource.indexOf("  const handleAttentionNeeded = useCallback"), appShellSource.indexOf("  const handleAutoName = useCallback"));
  assert.match(completionSource, /selectedSession\\?\\.relation\\?\\.kind === "subagent"\\) return/);
  assert.match(attentionSource, /selectedSession\\?\\.relation\\?\\.kind === "subagent"\\) return/);
  assert.doesNotMatch(chatWindowSource, /playDoneSound|soundEnabled|unlockAudio/);
});

`);
  change('components/SessionSidebar.test.mjs', '  assert.match(source, /if \\(completedWithNotifications\\.length > 0\\) \\{\\s*onBackgroundTaskDone\\?\\.\\(\\)/);', '  assert.doesNotMatch(source, /onBackgroundTaskDone/);');
  change('components/SessionSidebar.test.mjs', '  assert.match(source, /loadSessions\\(false, true\\);[\\s\\S]*?onBackgroundTaskDone/);', '  assert.match(source, /completedInBackground\\.length > 0 \\|\\| hasUnlistedRunningSession/);');
  change('components/ChatInput.test.mjs', '      onSoundToggle() {}, soundEnabled: true, isStreaming: false, isCompacting,', '      isStreaming: false, isCompacting,');
}
