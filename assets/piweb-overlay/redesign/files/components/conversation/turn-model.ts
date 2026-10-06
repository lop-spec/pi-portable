// Turn model for the chat window: groups the loaded messages into displayed turns
// (anchor message → process → answer) once per message change, and reuses the
// previous descriptor object for every turn whose inputs did not change. Turn
// views are memoized on these descriptors, so streaming, paging and tool steps
// only re-render the turns they touch.
import { isMessageGroupAnchor } from "@/lib/message-display";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";

export interface TurnDescriptor {
  /** Stable React key: the anchor (or first) entry id. */
  key: string;
  /** True when the loaded window starts in the middle of this turn (no anchor loaded). */
  partial: boolean;
  messages: readonly AgentMessage[];
  entryIds: readonly (string | undefined)[];
  /** The running turn: one live timeline also carries the reply being streamed. */
  live: boolean;
  /** A reply is streaming and this turn holds the last loaded message. */
  streamingTail: boolean;
  /** Timestamp of the message right before this turn. */
  prevTimestamp?: number;
  /** An assistant message follows this turn before the next user message (timestamp rule). */
  assistantFollows: boolean;
  /** Index (within the turn) of the session's last user message, or -1. */
  lastUserLocal: number;
  /** Results for this turn's own tool calls; the same Map while they do not change. */
  toolResults: ReadonlyMap<string, ToolResultMessage>;
}

export interface TurnModel {
  turns: TurnDescriptor[];
  /** entry id → key of the turn that renders it. */
  turnOfEntry: Map<string, string>;
  /** True when one of the turns renders the live timeline. */
  hasLiveTurn: boolean;
}

const EMPTY_RESULTS: ReadonlyMap<string, ToolResultMessage> = new Map();

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function turnToolResults(
  messages: readonly AgentMessage[],
  all: ReadonlyMap<string, ToolResultMessage>,
  previous: ReadonlyMap<string, ToolResultMessage> | undefined,
): ReadonlyMap<string, ToolResultMessage> {
  let subset: Map<string, ToolResultMessage> | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall") continue;
      const result = all.get(block.toolCallId);
      if (!result) continue;
      subset ??= new Map();
      subset.set(block.toolCallId, result);
    }
  }
  if (!subset) return previous && previous.size === 0 ? previous : EMPTY_RESULTS;
  if (previous && previous.size === subset.size) {
    let same = true;
    for (const [id, result] of subset) {
      if (previous.get(id) !== result) { same = false; break; }
    }
    if (same) return previous;
  }
  return subset;
}

export function buildTurnModel(
  messages: readonly AgentMessage[],
  entryIds: readonly string[],
  options: { busy: boolean; streaming: boolean },
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  previous: ReadonlyMap<string, TurnDescriptor>,
): TurnModel {
  const turns: TurnDescriptor[] = [];
  const turnOfEntry = new Map<string, string>();
  let hasLiveTurn = false;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  const running = options.busy || options.streaming;

  for (let start = 0; start < messages.length;) {
    const partial = !isMessageGroupAnchor(messages[start]);
    let end = start + 1;
    while (end < messages.length && !isMessageGroupAnchor(messages[end])) end += 1;
    const live = running && end === messages.length;
    if (live) hasLiveTurn = true;
    // The timestamp rule looks past this turn up to the next user message: a
    // subagent notification anchors a turn without ending the user's exchange.
    let assistantFollows = false;
    for (let j = end; j < messages.length; j++) {
      const role = messages[j].role;
      if (role === "user") break;
      if (role === "assistant") { assistantFollows = true; break; }
    }
    // Keys must survive older pages being prepended. A full turn is keyed by its anchor.
    // A partial (finished) turn grows at its start while paging, so it is keyed by its
    // last entry; a partial turn that is still running grows at its end instead.
    const key = !partial
      ? `turn:${entryIds[start] ?? `#${start}`}`
      : live
        ? `partial:${entryIds[start] ?? `#${start}`}`
        : `partial-end:${entryIds[end - 1] ?? `#${end - 1}`}`;
    const slice = messages.slice(start, end);
    const ids = entryIds.slice(start, Math.min(end, entryIds.length)) as (string | undefined)[];
    while (ids.length < slice.length) ids.push(undefined);
    const prev = previous.get(key);
    const next: TurnDescriptor = {
      key,
      partial,
      messages: slice,
      entryIds: ids,
      live,
      streamingTail: options.streaming && end === messages.length,
      prevTimestamp: start > 0 ? (messages[start - 1] as { timestamp?: number }).timestamp : undefined,
      assistantFollows,
      lastUserLocal: lastUserIdx >= start && lastUserIdx < end ? lastUserIdx - start : -1,
      toolResults: turnToolResults(slice, toolResults, prev?.toolResults),
    };
    const reuse = prev
      && prev.partial === next.partial
      && prev.live === next.live
      && prev.streamingTail === next.streamingTail
      && prev.prevTimestamp === next.prevTimestamp
      && prev.assistantFollows === next.assistantFollows
      && prev.lastUserLocal === next.lastUserLocal
      && prev.toolResults === next.toolResults
      && sameArray(prev.messages, next.messages)
      && sameArray(prev.entryIds, next.entryIds);
    const turn = reuse ? prev : next;
    turns.push(turn);
    for (const id of ids) if (id) turnOfEntry.set(id, key);
    start = end;
  }
  return { turns, turnOfEntry, hasLiveTurn };
}

// ---------------------------------------------------------------------------
// Render window: at most MAX_MOUNTED_TURNS turns stay mounted. Turns outside the
// window are replaced by one spacer each side holding their measured height, so
// the scroll position and scrollbar stay where they were.
// ---------------------------------------------------------------------------

export const MAX_MOUNTED_TURNS = 16;
export const WINDOW_STEP = 6;
export const ESTIMATED_TURN_HEIGHT = 480;

export interface TurnWindow {
  /** Key of the first mounted turn (null = from the first loaded turn). */
  top: string | null;
  /** Key of the first unmounted turn at the bottom (null = mounted to the end). */
  bottom: string | null;
}

export function resolveTurnWindow(turns: readonly TurnDescriptor[], window: TurnWindow, forcedKey?: string | null): { topIndex: number; bottomIndex: number } {
  let topIndex = window.top ? turns.findIndex((turn) => turn.key === window.top) : 0;
  let bottomIndex = window.bottom ? turns.findIndex((turn) => turn.key === window.bottom) : turns.length;
  if (topIndex < 0) topIndex = 0;
  if (bottomIndex < 0 || bottomIndex < topIndex) bottomIndex = turns.length;
  if (forcedKey) {
    const forced = turns.findIndex((turn) => turn.key === forcedKey);
    if (forced >= 0 && (forced < topIndex || forced >= bottomIndex)) {
      // A jump target outside the window: mount a window around it instead.
      topIndex = Math.max(0, forced - Math.floor(WINDOW_STEP / 2));
      bottomIndex = Math.min(turns.length, Math.max(forced + 1, topIndex + MAX_MOUNTED_TURNS));
    }
  }
  return { topIndex, bottomIndex };
}

/**
 * Render window that keeps the newest turns mounted. A window pinned above the tail
 * (the reader scrolled up and the tail turns were unmounted) never mounts turns that are
 * appended after it, so a send restores the tail first. `appending` counts the turns that
 * are about to be added in the same render (a send adds one).
 */
export function tailTurnWindow(turns: readonly TurnDescriptor[], appending = 0): TurnWindow {
  const topIndex = Math.max(0, turns.length + appending - MAX_MOUNTED_TURNS);
  return { top: topIndex > 0 && topIndex < turns.length ? turns[topIndex].key : null, bottom: null };
}

export function windowGapHeight(turns: readonly TurnDescriptor[], from: number, to: number, heights: ReadonlyMap<string, number>): number {
  let total = 0;
  for (let i = from; i < to; i++) total += heights.get(turns[i].key) ?? ESTIMATED_TURN_HEIGHT;
  return Math.max(0, Math.round(total));
}
