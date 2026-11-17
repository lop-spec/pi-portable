// Message-level fork and pin, as in the Claude desktop app (lop 2026-11-17: copy / fork / pin move under the
// finished answer, left of the model line; fork behaves like the desktop one).
//  - Under every finished answer: copy, "fork from here" (a new session from that turn, this one stays as it is,
//    also while it runs) and "pin as chapter" (kept in the browser, shown in the Q/A navigation).
//  - Fork from a user message leaves that message behind and puts its text (and images) in the new session's
//    composer; the new session is titled "<title> (fork)" / "(fork 2)"; /fork [prompt] forks the current end,
//    with a prompt it runs there while this session stays open.
//  - A fork shows where it came from at its top; the session it left shows "forked here" under that turn
//    (GET /api/sessions/<id>/forks).
// Server: fork_branch learns `before` and `name` and no longer refuses a running session (it only reads the
// saved file, the running session is untouched). Applied after every other step, on the final text.
const CSS = `/* 回合下方操作：复制 · 分叉 · 固定为章节，放在模型/时间行左侧（与 Claude 桌面端同位）；常显、悬停加深 */
.pw-turn-meta .pw-turn-actions { display: inline-flex; align-items: center; gap: 2px; margin: 0 2px 0 -5px; }
.pw-turn-actions .pw-icon-btn { color: var(--text-dim); }
.pw-turn-actions .pw-icon-btn:hover { color: var(--text); }
.pw-turn-actions .pw-icon-btn[aria-pressed="true"] { color: var(--accent); }
.pw-fork-marker { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; margin: 10px 0 0; color: var(--text-dim); font-size: var(--fs-meta); }
.pw-fork-marker.is-origin { margin: 0 0 12px; }
.pw-fork-marker > svg { flex: none; width: 14px; height: 14px; }
.pw-fork-link { min-width: 0; max-width: min(100%, 420px); padding: 0; border: 0; background: none; color: var(--text-muted); font: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.pw-fork-link:hover { color: var(--text); text-decoration: underline; }
.pw-node-panel header .pw-node-tools { display: inline-flex; align-items: center; gap: 6px; }
.pw-node-list button > .pw-node-pin { flex: none; width: 12px; height: 12px; color: var(--accent); }

`;

const MESSAGES = {
  'zh-CN': {
    'chat.commandFork': '从当前位置分叉出新会话；带提示词则在新会话里运行，这里保持不动（输入框里 Ctrl+Alt+Enter 等同于 /fork 加输入内容）',
    'chat.forkFromHere': '从此处分叉',
    'chat.forkFromHereHint': '开一个新会话，当前会话保持不变',
    'chat.forkFromMessageHint': '开一个新会话，这条消息的原文放进它的输入框，当前会话保持不变',
    'chat.forking': '正在分叉…',
    'chat.pinChapter': '固定为章节',
    'chat.unpinChapter': '取消固定章节',
    'chat.pinnedOnly': '只看已固定章节',
    'chat.turnActions': '回答操作',
    'chat.forkedFrom': '分叉自',
    'chat.forkedFromOther': '分叉自其他会话',
    'chat.forkedHere': '已在此分叉',
    'chat.forksHere': '此处已分叉 {count} 次',
  },
  en: {
    'chat.commandFork': 'Fork the session from here; with a prompt it runs in the fork and this session stays put (Ctrl+Alt+Enter in the composer sends its text this way)',
    'chat.forkFromHere': 'Fork from here',
    'chat.forkFromHereHint': 'Starts a new session from this point. This one stays as it is.',
    'chat.forkFromMessageHint': 'Starts a new session with this message in its composer. This one stays as it is.',
    'chat.forking': 'Forking…',
    'chat.pinChapter': 'Pin as chapter',
    'chat.unpinChapter': 'Unpin chapter',
    'chat.pinnedOnly': 'Pinned chapters only',
    'chat.turnActions': 'Answer actions',
    'chat.forkedFrom': 'Forked from',
    'chat.forkedFromOther': 'Forked from another session',
    'chat.forkedHere': 'Forked here',
    'chat.forksHere': '{count} forks from here',
  },
  'zh-TW': {
    'chat.commandFork': '從目前位置分叉出新工作階段；帶提示詞則在新工作階段執行，這裡保持不動（輸入框裡 Ctrl+Alt+Enter 等同於 /fork 加輸入內容）',
    'chat.forkFromHere': '從此處分叉',
    'chat.forkFromHereHint': '開一個新工作階段，目前工作階段保持不變',
    'chat.forkFromMessageHint': '開一個新工作階段，這則訊息的原文放進它的輸入框，目前工作階段保持不變',
    'chat.forking': '正在分叉…',
    'chat.pinChapter': '固定為章節',
    'chat.unpinChapter': '取消固定章節',
    'chat.pinnedOnly': '只看已固定章節',
    'chat.turnActions': '回答操作',
    'chat.forkedFrom': '分叉自',
    'chat.forkedFromOther': '分叉自其他工作階段',
    'chat.forkedHere': '已在此分叉',
    'chat.forksHere': '此處已分叉 {count} 次',
  },
};

const messageLines = locale => Object.entries(MESSAGES[locale]).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join('\n');

export function integrateForkActions({ set, change, template }) {
  set('lib/portable-fork-core.mjs', template('fork-actions/portable-fork-core.mjs'));
  set('lib/portable-fork.ts', template('fork-actions/portable-fork.ts'));
  set('lib/portable-pins.ts', template('fork-actions/portable-pins.ts'));
  set('components/PortableTurnActions.tsx', template('fork-actions/PortableTurnActions.tsx'));
  set('components/PortableForkMarkers.tsx', template('fork-actions/PortableForkMarkers.tsx'));
  set('app/api/sessions/[id]/forks/route.ts', template('fork-actions/forks-route.ts'));

  // Server: fork_branch can leave the entry behind (a user message) and name the new session; it never
  // refuses a running session because it reads the saved file only.
  const rpc = 'lib/rpc-manager.ts';
  change(rpc, `      case "fork_branch": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot fork while the session is running");
        }
        const entryId = command.entryId as string;`, `      case "fork_branch": {
        const entryId = command.entryId as string;
        const before = command.before === true;
        const name = typeof command.name === "string" ? command.name.trim() : "";`);
  change(rpc, `        if (!sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const forkedPath = sourceManager.createBranchedSession(entryId);
        if (!forkedPath) throw new Error("Failed to create forked session");

        const newSessionId = SessionManager.open(forkedPath, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, forkedPath);`, `        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        // \`before\`: fork from a user message, so everything up to the entry's parent is copied (nothing at all
        // before the first message). The default keeps the entry, as a finished turn does.
        const sessionDir = sessionManager.getSessionDir();
        let forkedManager: SessionManager;
        let forkedPath: string | undefined;
        if (before && !entry.parentId) {
          forkedManager = SessionManager.create(sessionManager.getCwd(), sessionDir, { parentSession: currentSessionFile });
          forkedPath = forkedManager.getSessionFile();
        } else {
          forkedManager = SessionManager.open(currentSessionFile, sessionDir);
          forkedPath = forkedManager.createBranchedSession(before ? (entry.parentId as string) : entryId);
        }
        if (!forkedPath) throw new Error("Failed to create forked session");
        if (name) forkedManager.appendSessionInfo(name);
        if (!existsSync(forkedPath)) {
          const header = forkedManager.getHeader();
          if (!header) throw new Error("Forked session is missing a session header");
          const content = [header, ...forkedManager.getEntries()]
            .map((forkedEntry) => JSON.stringify(forkedEntry))
            .join("\\n") + "\\n";
          writeFileSync(forkedPath, content, { encoding: "utf8", flag: "wx" });
        }

        const newSessionId = forkedManager.getSessionId();
        cacheSessionPath(newSessionId, forkedPath);`);

  // Hook: fork leaves the source alone, names the fork, prefills the user's message; /fork [prompt].
  const hook = 'hooks/useAgentSession.ts';
  change(hook, 'import { clearDraft, rekeyDraft, restoreDraftSubmission } from "@/lib/draft-store";', 'import { clearDraft, rekeyDraft, restoreDraftSubmission } from "@/lib/draft-store";\nimport { forkSessionAt, forkTitle, registerForkAfter, type PortableForkPrefill } from "@/lib/portable-fork";');
  change(hook, `  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);`, `  // Fork as in the Claude desktop app: the session you are in stays as it is (running or not), the fork is
  // titled "<title> (fork)", and forking from a user message puts that message in the fork's composer.
  const handleFork = useCallback(async (entryId: string, prefill?: PortableForkPrefill) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const newSessionId = await forkSessionAt(sid, { entryId, before: true, title: forkTitle(session?.name?.trim() || session?.firstMessage || ""), prefill });
      if (newSessionId) onSessionForked?.(newSessionId);
      else addNotice({ type: "error", message: "无法分叉：会话还没有保存" });
    } catch (e) {
      console.error("Fork failed:", e);
      addNotice({ type: "error", message: "分叉失败：" + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setForkingEntryId(null);
    }
  }, [addNotice, onSessionForked, session?.name, session?.firstMessage]);

  // Fork after a finished turn (the button under each answer); the transcript reaches it through the registry.
  const forkSourceTitle = session?.name?.trim() || session?.firstMessage || "";
  const handleForkAfter = useCallback(async (entryId: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      const newSessionId = await forkSessionAt(sid, { entryId, title: forkTitle(forkSourceTitle) });
      if (!newSessionId) {
        addNotice({ type: "error", message: "无法分叉：会话还没有保存" });
        return false;
      }
      onSessionForked?.(newSessionId);
      return true;
    } catch (e) {
      console.error("Fork failed:", e);
      addNotice({ type: "error", message: "分叉失败：" + (e instanceof Error ? e.message : String(e)) });
      return false;
    }
  }, [addNotice, forkSourceTitle, onSessionForked]);
  // Registered once per session; the ref keeps the action current without re-registering when the title changes.
  const forkable = session?.relation?.kind !== "subagent";
  const handleForkAfterRef = useRef(handleForkAfter);
  handleForkAfterRef.current = handleForkAfter;
  useEffect(() => {
    const sid = session?.id;
    if (!sid || isNew || !forkable) return;
    return registerForkAfter(sid, (entryId) => handleForkAfterRef.current(entryId));
  }, [session?.id, isNew, forkable]);`);
  change(hook, `        case "clone": {
          if (!sid) return complete({ handled: true, error: "No active session to clone" });`, `        case "fork": {
          if (isNew || !sid) return complete({ handled: true, error: "没有可分叉的会话" });
          if (!activeLeafId) return complete({ handled: true, error: "会话还是空的，无法分叉" });
          const title = forkTitle(forkSourceTitle);
          const newSessionId = await forkSessionAt(sid, { entryId: activeLeafId, title });
          if (!newSessionId) return complete({ handled: true, error: "无法分叉：会话还没有保存" });
          if (args) {
            // With a prompt the work runs in the fork while this session stays open.
            await sendAgentCommand(newSessionId, { type: "prompt", message: args });
            return complete({ handled: true, message: \`已在分叉会话「\${title || "新会话"}」中开始\` });
          }
          const forked = complete({ handled: true, message: "已分叉当前会话" });
          onSessionForked?.(newSessionId);
          return forked;
        }

        case "clone": {
          if (!sid) return complete({ handled: true, error: "No active session to clone" });`);
  change(hook, 'loadTools, promoteNewSession, onSessionForked, onSessionStatsPanelOpen]);', 'loadTools, promoteNewSession, onSessionForked, onSessionStatsPanelOpen, forkSourceTitle, isNew]);');

  // Composer: /fork, and Ctrl+Alt+Enter ("send in a forked session") which is /fork with what is typed.
  const input = 'components/ChatInput.tsx';
  change(input, '  { name: "clone", description: "chat.commandClone", source: "builtin" },', '  { name: "clone", description: "chat.commandClone", source: "builtin" },\n  { name: "fork", description: "chat.commandFork", source: "builtin", availableWhileStreaming: true },');
  change(input, `  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;`, `  // Ctrl+Alt+Enter: the typed prompt runs in a fork of this session; the text stays here when the fork fails.
  const sendInFork = useCallback(async (text: string) => {
    if (!onBuiltinCommand || builtinCommandPendingRef.current) return;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(\`/fork \${text}\`);
      if (result.handled && !result.error && valueRef.current.trim() === text) clearInput();
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [onBuiltinCommand, clearInput]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;`);
  change(input, `      if (sendShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }
`, `      if (sendShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (sendShortcut && e.ctrlKey && e.altKey && !isComposing && !imageMode && !attachedImages.length && onBuiltinCommand) {
        const text = value.trim();
        if (text && !text.startsWith("/")) {
          e.preventDefault();
          void sendInFork(text);
          return;
        }
      }
`);
  change(input, 'applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]', 'applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, attachedImages, onBuiltinCommand, sendInFork]');

  // Transcript: fork from a user message works while the session runs; the answer footer carries the actions.
  const chat = 'components/ChatWindow.tsx';
  change(chat, 'import { PortableNodes } from "./PortableNodes";', 'import { PortableNodes } from "./PortableNodes";\nimport { PortableForkedFrom } from "./PortableForkMarkers";\nimport type { PortableForkPrefill } from "@/lib/portable-fork";');
  change(chat, '  handleFork: (entryId: string) => void;', '  handleFork: (entryId: string, prefill?: PortableForkPrefill) => void;');
  change(chat, '          onFork={sessionBusy || isNew ? undefined : handleFork}', '          onFork={isNew ? undefined : handleFork}');
  // The upstream hook test pins the old gate; it follows the new behaviour.
  change('hooks/useAgentSession.test.mjs', String.raw`assert.match(chatWindowSource, /onFork=\{sessionBusy \|\| isNew \? undefined : handleFork\}/);`, String.raw`assert.match(chatWindowSource, /onFork=\{isNew \? undefined : handleFork\}/);`);
  change(chat, '            {topGap > 0 && <div data-pw-window-gap="top" aria-hidden="true" style={{ height: topGap }} />}', '            {!hasEarlierMessages && topIndex === 0 && <PortableForkedFrom session={session} onOpenSession={onOpenSession} />}\n            {topGap > 0 && <div data-pw-window-gap="top" aria-hidden="true" style={{ height: topGap }} />}');

  const view = 'components/MessageView.tsx';
  change(view, 'import { TurnWrittenFiles } from "./TurnWrittenFiles";', 'import { TurnWrittenFiles } from "./TurnWrittenFiles";\nimport { PortableTurnActions } from "./PortableTurnActions";\nimport { PortableForkHere } from "./PortableForkMarkers";\nimport { forkPrefillFrom, type PortableForkPrefill } from "@/lib/portable-fork";');
  change(view, '  onFork?: (entryId: string) => void;\n  forking?: boolean;', '  onFork?: (entryId: string, prefill?: PortableForkPrefill) => void;\n  forking?: boolean;', 2);
  change(view, '  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;', '  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;\n  const forkPrefill = forkPrefillFrom(copyTarget, imageBlocks);');
  change(view, `              onClick={() => { onFork!(entryId!); }}
              disabled={forking}
              aria-label={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
              title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}`, `              onClick={() => { onFork!(entryId!, forkPrefill); }}
              disabled={forking}
              aria-label={forking ? t("i18n.creatingSession") : t("chat.forkFromHere")}
              title={forking ? t("i18n.creatingSession") : \`\${t("chat.forkFromHere")}：\${t("chat.forkFromMessageHint")}\`}`);
  change(view, `      {(metaParts.length > 0 || showCopy) && (
        <div className="pw-turn-meta">
          {withSeparators(metaParts)}
          {showCopy && (
            <span className="pw-hover-actions">
              <button type="button" className="pw-icon-btn pw-icon-btn--sm" onClick={copyContent} aria-label={copied ? t("i18n.copied") : t("i18n.copyMessage")} title={copied ? t("i18n.copied") : t("i18n.copyMessage")}>
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </span>
          )}
        </div>
      )}`, `      {(metaParts.length > 0 || showCopy) && (
        <div className="pw-turn-meta">
          <PortableTurnActions sessionId={sessionId} entryId={entryId} turnEnd={Boolean(showTimestamp) && !isStreaming} showCopy={showCopy} copied={copied} onCopy={copyContent} />
          {withSeparators(metaParts)}
        </div>
      )}
      {showTimestamp && !isStreaming && <PortableForkHere sessionId={sessionId} entryId={entryId} onOpenSession={onOpenSession} />}`);

  // Q/A navigation: pinned answers carry a pin, and a toggle narrows the list to them.
  const nodes = 'components/PortableNodes.tsx';
  change(nodes, 'import { ListIcon } from "./conversation/icons";', 'import { ListIcon } from "./conversation/icons";\nimport { PortablePinIcon } from "./PortableTurnActions";\nimport { usePortablePins } from "@/lib/portable-pins";\nimport { useI18n } from "@/hooks/useI18n";');
  change(nodes, '  const nodes = useMemo(() => {\n    const map = new Map(history.map(node => [node.entryId, node]));', '  const { t } = useI18n();\n  const pins = usePortablePins(sessionId);\n  const [pinnedOnly, setPinnedOnly] = useState(false);\n  const allNodes = useMemo(() => {\n    const map = new Map(history.map(node => [node.entryId, node]));');
  change(nodes, '    return [...map.values()];\n  }, [history, messages, entryIds]);', '    return [...map.values()];\n  }, [history, messages, entryIds]);\n  const nodes = useMemo(() => pinnedOnly ? allNodes.filter(node => pins.has(node.entryId)) : allNodes, [allNodes, pinnedOnly, pins]);');
  change(nodes, '  if (!nodes.length && !error && !navigationError && !navigating) return null;', '  if (!allNodes.length && !error && !navigationError && !navigating) return null;');
  change(nodes, 'aria-label={`问答导航（${nodes.length}）`}', 'aria-label={`问答导航（${allNodes.length}）`}');
  change(nodes, '<span className="pw-num">{nodes.length}</span></button>', '<span className="pw-num">{allNodes.length}</span></button>');
  change(nodes, '      <header><span>问题与最终回答</span><span className="pw-num">{nodes.length}</span></header>', `      <header>
        <span>问题与最终回答</span>
        <span className="pw-node-tools">
          {(pins.size > 0 || pinnedOnly) && <button type="button" className="pw-icon-btn pw-icon-btn--sm" aria-pressed={pinnedOnly} aria-label={t("chat.pinnedOnly")} title={t("chat.pinnedOnly")} onClick={() => setPinnedOnly(value => !value)}><PortablePinIcon filled={pinnedOnly} /></button>}
          <span className="pw-num">{nodes.length}</span>
        </span>
      </header>`);
  change(nodes, '<span>{node.text}</span>\n          </button>)}', '<span>{node.text}</span>{pins.has(node.entryId) && <PortablePinIcon filled className="pw-node-pin" />}\n          </button>)}');

  change('app/redesign-conversation.css', '/* 运行中但还没有时间线的阶段提示 */', `${CSS}/* 运行中但还没有时间线的阶段提示 */`);
  for (const [file, locale] of [['lib/i18n/messages/zh-CN.ts', 'zh-CN'], ['lib/i18n/messages/en.ts', 'en'], ['lib/i18n/messages/zh-TW.ts', 'zh-TW']]) {
    const anchor = { 'zh-CN': '    "chat.commandClone": "将当前分支复制为独立新会话",', en: '    "chat.commandClone": "Clone the current branch into a new session",', 'zh-TW': '    "chat.commandClone": "將目前分支複製為獨立新工作階段",' }[locale];
    change(file, anchor, `${anchor}\n${messageLines(locale)}`);
  }
}
