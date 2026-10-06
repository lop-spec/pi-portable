import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (url) => (await readFile(new URL(url, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const source = await read("./ChatWindow.tsx");
const hookSource = await read("../hooks/useAgentSession.ts");
const timelineSource = await read("./PortableProcessTimeline.tsx");
const css = await read("../app/redesign-conversation.css");

test("a send restores the render window's tail before the new user message is appended", () => {
  const send = hookSource.slice(hookSource.indexOf("const handleSend = useCallback"), hookSource.indexOf("const executeBash = useCallback"));
  const reveal = send.indexOf('revealTailRef?.current?.("instant", { scroll: false, appending: 1 });');
  const append = send.indexOf("setMessages((prev) => [...prev, userMsg]);");
  assert.ok(reveal > 0, "handleSend asks the chat window to re-mount the newest turns");
  assert.ok(append > reveal, "the window is restored in the same batch, before the append");
  assert.match(send, /pendingScrollToUserRef\.current = true;/, "the jump to the new message still follows");
  assert.match(hookSource, /\}, \[isNew, newSessionCwd[^\]]*restoreSubmission, revealTailRef\]\);/, "the callback depends on the ref");
  // ChatWindow: re-mount through the shared tail window; scroll: false must not queue a bottom scroll
  // (it would override the jump to the new user message in the same commit).
  assert.match(
    source,
    /revealTailRef\.current = \(_behavior, options\) => \{\n[^\n]*\n    if \(bottom >= list\.length\) return false;\n    if \(options\?\.scroll !== false\) pendingTailScrollRef\.current = "instant";\n    setTurnWindow\(tailTurnWindow\(list, options\?\.appending \?\? 0\)\);\n    return true;\n  \};/,
  );
});

test("only a running agent makes the last turn live; a ! command keeps the finished turn's grouping", () => {
  assert.match(source, /buildTurnModel\(messages, entryIds, \{ busy: agentRunning, streaming: streamState\.isStreaming \}, toolResultsMap, turnCacheRef\.current\);/);
  assert.match(source, /\}, \[messages, entryIds, agentRunning, streamState\.isStreaming, toolResultsMap\]\);/);
  assert.doesNotMatch(source, /buildTurnModel\([^\n]*busy: sessionBusy/);
  // The command's own progress keeps its separate indicators.
  assert.match(source, /\{bashRunning && !pendingBash && \(/);
});

test("a render failure shows a recoverable banner instead of unmounting the page", () => {
  assert.match(source, /import \{ ErrorBoundary \} from "\.\/ErrorBoundary";/);
  // Message region: the composer and sidebar stay usable; another session clears the error.
  assert.match(source, /<ErrorBoundary scope="对话区" fill resetKey=\{session\?\.id \?\? newSessionDraftKey \?\? null\}>\n      <div className="pw-chat-region [^"]*">/);
  assert.match(source, /<\/div>\n      <\/ErrorBoundary>\n\n      \{quoteSelectionEnabled && quotedSelection/);
  // Whole window: failures outside the message region (hook, composer) are contained too.
  assert.match(source, /export const ChatWindow = memo\(function ChatWindow\(props: Props\) \{\n  return \(\n    <ErrorBoundary scope="对话窗口" fill resetKey=\{props\.session\?\.id \?\? props\.newSessionDraftKey \?\? null\}>\n      <MemoChatWindow \{\.\.\.props\} \/>/);
  assert.match(source, /const MemoChatWindow = memo\(ChatWindowView, sameChatWindowProps\);/);
  assert.match(css, /\.pw-error-region \{[^}]*flex: 1 1 0;/);
  assert.match(css, /\.pw-error-banner \{[^}]*border-radius: var\(--r-lg\);[^}]*background: var\(--danger-soft\);/);
  assert.doesNotMatch(css.slice(css.indexOf(".pw-error-region")), /#[0-9a-fA-F]{3,8}\b/, "tokens only, no hex colours");
});

test("a search hit inside a collapsed process opens it for good instead of only while the jump is pending", () => {
  // Open on mount when the hit is already there, and when the hit arrives later.
  assert.match(timelineSource, /const \[collapsed, setCollapsed\] = useState\(\(\) => Boolean\(collapseKey && collapsedTimelines\.has\(collapseKey\)\) && !hasTarget\);/);
  assert.match(timelineSource, /const \[hadTarget, setHadTarget\] = useState\(hasTarget\);\n  if \(hasTarget !== hadTarget\) \{\n    setHadTarget\(hasTarget\);\n    if \(hasTarget && collapsed\) setCollapsed\(false\);\n  \}/);
  // The page-lifetime memory forgets the collapse, so the process stays open when it scrolls out of the window and back.
  assert.match(timelineSource, /useEffect\(\(\) => \{\n    if \(hasTarget && collapseKey\) collapsedTimelines\.delete\(collapseKey\);\n  \}, \[hasTarget, collapseKey\]\);/);
  // A hit in the final answer shares the process's assistant entry but is rendered below it: it must not open the process.
  assert.match(timelineSource, /entry.entryId === searchEntryId && (!searchBlock || entry.kind !== "assistant" || entry.message.content.includes(searchBlock))/);
  // The state is declared before the early return (hooks order) and `expanded` still honours the live target.
  assert.ok(timelineSource.indexOf("const [hadTarget, setHadTarget]") < timelineSource.indexOf("if (items.length === 0 && !live) return null;"));
  assert.match(timelineSource, /const expanded = Boolean\(live\) \|\| hasTarget \|\| !collapsed;/);
});
