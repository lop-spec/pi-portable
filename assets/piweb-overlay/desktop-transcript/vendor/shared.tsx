import { memo, useCallback, useContext, useId } from "react";
import type { UiMessage } from "./model";
import { useTranslation, useAppStore, resolveShowThinking, Markdown, useCopy, TooltipButton, TranscriptSearchContext, thinkingText } from "./host";
import { isThinkingActive } from "./turn-process";
import { disclosureKey, useAutomaticDisclosure } from "./disclosure";
import { TextShimmer } from "./TextShimmer";
import { IconCheck, IconCopy, IconChevronRight, IconSparkles, IconFileText, IconFolder, IconSearch, IconPencil, IconListChecks, IconTerminal, IconGlobe, IconBranch, IconBot, IconWrench } from "./icons";
import type { ToolAction } from "./tool-display";
export { useAutomaticDisclosure } from "./disclosure";
export function useMessageRevealRequest(messageId: string) {
  const target = useContext(TranscriptSearchContext);
  return target && target.messageId === messageId
    ? target.requestId
    : undefined;
}


export const TOOL_ACTION_KEYS: Record<ToolAction, string> = {
  read: "chat.toolRead",
  list: "chat.toolListed",
  search: "chat.toolSearched",
  write: "chat.toolWrote",
  edit: "chat.toolEdited",
  run: "chat.toolRan",
  fetch: "chat.toolFetched",
  fork: "chat.toolUsed",
  delegate: "chat.toolDelegated",
  todo: "chat.todo.updated",
  use: "chat.toolUsed",
};

/**
 * A lifecycle row says what it did to subagents, not that it "delegated":
 * `Task` is the only call that delegates (ADR 0062, ADR 0089, D268).
 */
export const LIFECYCLE_LABEL_KEYS: Record<"wait" | "list" | "stop", string> = {
  wait: "chat.subagentWaited",
  list: "chat.subagentListed",
  stop: "chat.subagentStopped",
};

/** A wait in progress is the one lifecycle row that visibly takes time. */
export const LIFECYCLE_RUNNING_KEYS: Record<"wait" | "list" | "stop", string> = {
  wait: "chat.subagentWaiting",
  list: "chat.subagentListing",
  stop: "chat.subagentStopping",
};

export const TOOL_RUNNING_KEYS: Record<ToolAction, string> = {
  read: "chat.toolReading",
  list: "chat.toolListing",
  search: "chat.toolSearching",
  write: "chat.toolWriting",
  edit: "chat.toolEditing",
  run: "chat.toolRunning",
  fetch: "chat.toolFetching",
  fork: "chat.toolUsing",
  delegate: "chat.toolDelegating",
  todo: "chat.todo.updating",
  use: "chat.toolUsing",
};

export function ToolActionIcon({ action }: { action: ToolAction }) {
  const props = { size: 15, "aria-hidden": true };
  switch (action) {
    case "read":
      return <IconFileText {...props} />;
    case "list":
      return <IconFolder {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "write":
    case "edit":
      return <IconPencil {...props} />;
    case "todo":
      return <IconListChecks {...props} />;
    case "run":
      return <IconTerminal {...props} />;
    case "fetch":
      return <IconGlobe {...props} />;
    case "fork":
      return <IconBranch {...props} />;
    case "delegate":
      return <IconBot {...props} />;
    default:
      return <IconWrench {...props} />;
  }
}


export function ToolCommandCopy({ command }: { command: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <TooltipButton
      className={`tool-row-head-copy${copied ? " copied" : ""}`}
      ariaLabel={`${t("chat.copy")} ${t("chat.toolBlockCommand")}`}
      tooltip={copied ? t("chat.copied") : t("chat.copy")}
      onClick={() => copy(command)}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </TooltipButton>
  );
}

export function DisclosureCollapseRail({
  label,
  onCollapse,
}: {
  label: string;
  onCollapse: () => void;
}) {
  return (
    <TooltipButton
      type="button"
      className="disclosure-collapse-rail"
      ariaLabel={label}
      tooltip={label}
      onClick={onCollapse}
    />
  );
}

export const ThinkingRow = memo(function ThinkingRow({
  message,
  streaming,
  autoOpen = false,
  onUserInteraction,
}: {
  message: UiMessage;
  streaming: boolean;
  autoOpen?: boolean;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const revealRequest = useMessageRevealRequest(message.id);
  const disclosure = useAutomaticDisclosure(autoOpen, revealRequest, disclosureKey("thinking", message.id));
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  const titleRef = disclosure.titleRef;
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);
  // `Show thinking` off keeps the live indicator but suppresses completed
  // reasoning rows and excerpts. The stored text is never removed, so turning
  // the preference back on restores the row.
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  if (!showThinking) {
    return isThinkingActive(message, streaming) ? (
      <div className="tool-row thinking thinking-compact" role="status">
        <span className="tool-row-icon" aria-hidden>
          <IconSparkles size={15} />
        </span>
        <span className="tool-row-name">
          <TextShimmer text={t("chat.thinking", { defaultValue: "Thinking" })} />
        </span>
      </div>
    ) : null;
  }
  const text = thinkingText(message);
  return (
    <div className={`tool-row thinking ${open ? "open" : ""}`}>
      <button
        ref={titleRef}
        className="tool-row-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={t(open ? "chat.thinkingHide" : "chat.thinkingShow")}
        onClick={toggleRow}
      >
        <span className="tool-row-icon">
          <IconSparkles size={15} aria-hidden />
        </span>
        <span className="tool-row-name">
          <TextShimmer
            text={t("chat.thinking", { defaultValue: "Thinking" })}
            active={streaming && !open}
          />
        </span>
        <span className="tool-row-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      {open ? (
        <div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
          <DisclosureCollapseRail
            label={t("chat.thinkingHide")}
            onCollapse={collapseRow}
          />
          <div className="prose-chat thinking-prose">
            <Markdown source={text} renderDiagrams={false} />
          </div>
        </div>
      ) : null}
    </div>
  );
}, (previous, next) =>
  previous.message === next.message &&
  previous.streaming === next.streaming &&
  previous.autoOpen === next.autoOpen &&
  previous.onUserInteraction === next.onUserInteraction,
);
