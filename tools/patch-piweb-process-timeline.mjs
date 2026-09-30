// Source integration: Claude-style process timeline (lop 2026-09-29「中文推理过程被吃掉了，
// 显示的命令太多了，应该折叠到中文推理里面，就像是 claude 一样」).
// 2026-09-30 (「直接都隐藏命令」「英文推理折叠，中文还是跟之前一样的显示」): the Chinese narration
// stays visible, consecutive thinking summaries fold into one row, tool calls are not shown.
// Live and finished turns share the layout.
// Replaces the 0.9.0 overlay that pulled every tool card out of the collapsed process group.
export const INLINE_THINKING_CHARS = 2000;

export function integrateProcessTimeline({ get, set, change, prepend, template }) {
  const chat = 'components/ChatWindow.tsx', view = 'components/MessageView.tsx';
  set('components/PortableProcessTimeline.tsx', template('PortableProcessTimeline.tsx'));

  // The timeline reuses the native renderers instead of copying them.
  set(view, get(view) + '\nexport { ToolCallBlock as PortableToolCallBlock, TextBlock as PortableTextBlock, loadThinkingContent as portableLoadThinkingContent, getToolPreview as portableToolPreview };\n');
  // The live bubble keeps the native thinking block, collapsed by default like the timeline
  // (lop 2026-09-30「英文推理折叠」); the 09-29 force-expand while streaming is gone.

  // History keeps short reasoning inline so the timeline shows it without one request per
  // block; only long reasoning stays deferred behind "展开全文".
  change('lib/session-reader.ts', '          block.type === "thinking" && block.thinking.trim() !== ""',
    `          block.type === "thinking" && block.thinking.trim().length > ${INLINE_THINKING_CHARS}`);

  prepend(chat, 'import { PortableProcessTimeline, type PortableTimelineEntry } from "./PortableProcessTimeline";\n');
  change(chat, '              const rendered: ReactNode[] = [];\n', `              const rendered: ReactNode[] = [];
              const portableProcessTimeline = (anchorIdx: number, from: number, to: number, options: { live?: boolean; finalIdx?: number; finalBlocks?: AssistantContentBlock[]; omitFinalUsage?: boolean } = {}): ReactNode => {
                const entries: PortableTimelineEntry[] = [];
                let firstRefIdx: number | undefined;
                for (let i = from; i <= to; i++) {
                  const item = messages[i];
                  if (item.role === "toolResult") continue;
                  if (item.role !== "assistant") {
                    entries.push({ kind: "node", key: \`node-\${entryIds[i] ?? i}\`, node: renderMessage(i, { attachRef: false, keyPrefix: "process" }) });
                    continue;
                  }
                  const message = i === options.finalIdx
                    ? withAssistantBlocks(item as AssistantMessage, options.finalBlocks ?? [], { omitUsage: options.omitFinalUsage })
                    : item as AssistantMessage;
                  // Failed or truncated intermediate replies keep the native error view.
                  const broken = i !== options.finalIdx && Boolean(getAssistantErrorMessage(message) || isAssistantTruncated(message));
                  if (!broken && getDisplayableAssistantBlocks(message).length === 0) continue;
                  firstRefIdx ??= visibleRefIndexByMessage.get(i);
                  entries.push(broken
                    ? { kind: "node", key: \`node-\${entryIds[i] ?? i}\`, node: renderMessage(i, { attachRef: false, keyPrefix: "process", messageOverride: message, showTimestamp: false }) }
                    : { kind: "assistant", key: \`msg-\${entryIds[i] ?? i}\`, entryId: entryIds[i], message });
                }
                if (entries.length === 0) return null;
                const refIndex = firstRefIdx;
                return (
                  <div key={\`process-timeline-\${entryIds[anchorIdx] ?? anchorIdx}\`} ref={refIndex === undefined ? undefined : (el) => { messageRefs.current[refIndex] = el; }}>
                    <PortableProcessTimeline entries={entries} toolResults={toolResultsMap} cwd={messageCwd} sessionId={session?.id ?? sessionIdRef.current ?? undefined} searchEntryId={pendingSearchScroll?.entryId} searchBlock={searchBlock} live={options.live} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                  </div>
                );
              };
`);
  // A lazy-load window can start inside a long turn: its leading messages have no anchor
  // and upstream renders them one by one. They get the same timeline (and final answer).
  change(chat, `                if (!isMessageGroupAnchor(msg)) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }`, `                if (!isMessageGroupAnchor(msg)) {
                  let segmentEnd = idx + 1;
                  while (segmentEnd < messages.length && !isMessageGroupAnchor(messages[segmentEnd])) segmentEnd += 1;
                  const liveSegment = (sessionBusy || streamState.isStreaming) && segmentEnd === messages.length;
                  const segmentFinalIdx = liveSegment ? -1 : findFinalAssistantIndex(messages, idx - 1, segmentEnd);
                  if (segmentFinalIdx < 0) {
                    const segmentTimeline = portableProcessTimeline(idx, idx, segmentEnd - 1, { live: liveSegment });
                    if (segmentTimeline) rendered.push(segmentTimeline);
                    idx = segmentEnd;
                    continue;
                  }
                  const segmentFinal = messages[segmentFinalIdx] as AssistantMessage;
                  const segmentSplit = splitFinalAssistantBlocks(segmentFinal);
                  const segmentAnswer = segmentSplit.answerBlocks.length > 0 || getAssistantErrorMessage(segmentFinal) || isAssistantTruncated(segmentFinal)
                    ? withAssistantBlocks(segmentFinal, segmentSplit.answerBlocks)
                    : null;
                  const segmentProcessEnd = segmentFinal.content.indexOf(segmentSplit.answerBlocks[0]);
                  const segmentTimeline = portableProcessTimeline(idx, idx, segmentFinalIdx, { finalIdx: segmentFinalIdx, finalBlocks: segmentFinal.content.slice(0, segmentProcessEnd < 0 ? undefined : segmentProcessEnd), omitFinalUsage: Boolean(segmentAnswer) });
                  if (segmentTimeline) rendered.push(segmentTimeline);
                  if (segmentAnswer) rendered.push(renderMessage(segmentFinalIdx, { messageOverride: segmentAnswer }));
                  for (let renderIdx = segmentFinalIdx + 1; renderIdx < segmentEnd; renderIdx++) rendered.push(renderMessage(renderIdx));
                  idx = segmentEnd;
                  continue;
                }`);
  change(chat, `                if (isLiveTail) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }`, `                if (isLiveTail) {
                  rendered.push(renderMessage(userIdx));
                  const liveTimeline = portableProcessTimeline(userIdx, userIdx + 1, endIdx - 1, { live: true });
                  if (liveTimeline) rendered.push(liveTimeline);`);
  const source = get(chat);
  const start = source.indexOf('                const processViews: ReactNode[] = [];');
  const end = source.indexOf('                if (finalAnswerMessage) {', start);
  if (start < 0 || end < 0 || source.indexOf('                const processViews: ReactNode[] = [];', start + 1) >= 0) throw new Error(`${chat}: process group anchors missing or repeated; zero writes`);
  change(chat, source.slice(start, end), `                const processTimeline = portableProcessTimeline(userIdx, userIdx + 1, finalAssistantIdx, { finalIdx: finalAssistantIdx, finalBlocks: finalProcessBlocks, omitFinalUsage: Boolean(finalAnswerMessage) });
                if (processTimeline) rendered.push(processTimeline);

`);
}
