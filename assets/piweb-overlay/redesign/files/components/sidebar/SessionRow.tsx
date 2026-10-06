"use client";
// 会话行（方向 A spec §2.4）：单行 30px，标题在左、时间/状态在右，悬停或聚焦时时间换成 ⋯。
// DOM 契约（BRIEF §4）：根元素 div[data-pi-session-id][data-pi-session-row]，选中行 aria-current="page"，
// 行内一个 React 不渲染子节点的空 span[data-pi-row-slot]，供注入脚本放归档按钮。
// 键盘：行内主操作元素是 .pw-sess-main 按钮（roving tabindex 由 SessionList 管），⋯ 与子代理开关不进 Tab 序列。
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { Icon } from "./icons";
import { deriveSessionTitle } from "./session-title";

export interface SessionRowProps {
  session: SessionInfo;
  depth: 0 | 1;
  timeLabel: string;
  tooltipTime: string;
  isSelected: boolean;
  isRunning: boolean;
  isUnread: boolean;
  subagentCount: number;
  expanded: boolean;
  renaming: boolean;
  tabbable: boolean;
  menuOpen: boolean;
  subagentGlyph: ReactNode;
  onSelect: (id: string) => void;
  onToggleFamily: (id: string) => void;
  onOpenMenu: (id: string, point: { x: number; y: number } | null) => void;
  onRenameCommit: (id: string, name: string | null) => void;
}

function rowTooltip(title: string, original: string, session: SessionInfo, tooltipTime: string): string {
  const meta = session.detailsPending ? tooltipTime : `${session.messageCount} 条消息 · ${tooltipTime}`;
  const body = original && original !== title ? `${title}\n${original.slice(0, 240)}` : title;
  return `${body}\n${meta}`;
}

export const SessionRow = memo(function SessionRow({
  session,
  depth,
  timeLabel,
  tooltipTime,
  isSelected,
  isRunning,
  isUnread,
  subagentCount,
  expanded,
  renaming,
  tabbable,
  menuOpen,
  subagentGlyph,
  onSelect,
  onToggleFamily,
  onOpenMenu,
  onRenameCommit,
}: SessionRowProps) {
  // 存下来的首条消息可能是 SDK 展开后的 <skill> 块，先还原成用户输入的 /skill:name。
  const displayFirstMessage = useMemo(
    () => skillExpansionToCommand(session.firstMessage) ?? session.firstMessage,
    [session.firstMessage],
  );
  const title = useMemo(
    () => deriveSessionTitle(session.name, displayFirstMessage, session.id),
    [displayFirstMessage, session.id, session.name],
  );
  const tooltip = rowTooltip(title, session.name ? "" : displayFirstMessage.trim(), session, tooltipTime);
  const isSub = depth > 0;
  const interactive = !session.transient;

  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!interactive) return;
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    onOpenMenu(session.id, fromKeyboard ? null : { x: event.clientX, y: event.clientY });
  };

  const classes = [
    "pw-sess-row",
    isSelected && "is-selected",
    isUnread && !isSelected && "is-unread",
    isRunning && "is-running",
    isSub && "is-sub",
    menuOpen && "is-menu-open",
    renaming && "is-renaming",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      data-pi-session-id={session.id}
      data-pi-session-row=""
      aria-current={isSelected ? "page" : undefined}
      onClick={renaming ? undefined : () => onSelect(session.id)}
      onContextMenu={renaming ? undefined : openMenu}
    >
      {isSub && <span className="pw-sess-sub-ico" aria-hidden="true"><Icon name="sub" size={12} /></span>}
      {renaming ? (
        <RenameField session={session} title={title} onCommit={(name) => onRenameCommit(session.id, name)} />
      ) : (
        <button
          type="button"
          className="pw-sess-main"
          tabIndex={tabbable ? 0 : -1}
          aria-current={isSelected ? "page" : undefined}
          title={tooltip}
          onClick={(event) => { event.stopPropagation(); onSelect(session.id); }}
        >
          <span className="pw-sess-title">{title}</span>
          {isUnread && <span className="pw-sr-only">，有新回复</span>}
          {isRunning && <span className="pw-sr-only">，运行中</span>}
        </button>
      )}
      {!renaming && subagentCount > 0 && (
        <button
          type="button"
          className="pw-sess-family"
          tabIndex={-1}
          aria-expanded={expanded}
          aria-label={expanded ? `收起 ${subagentCount} 个子代理` : `展开 ${subagentCount} 个子代理`}
          title={expanded ? `收起 ${subagentCount} 个子代理` : `展开 ${subagentCount} 个子代理`}
          onClick={(event) => { event.stopPropagation(); onToggleFamily(session.id); }}
        >
          {subagentGlyph}
          <span className="pw-num">{subagentCount}</span>
        </button>
      )}
      <span data-pi-row-slot="" />
      {!renaming && (
        <span className="pw-sess-end">
          {isRunning ? (
            <span className="pw-spinner" role="status" aria-label="运行中" title="运行中" />
          ) : isSub ? (
            <span className="pw-badge pw-sess-subtag">子代理</span>
          ) : (
            <>
              {isUnread && !isSelected && <span className="pw-dot pw-sess-unread" aria-hidden="true" />}
              <span className="pw-sess-time">{timeLabel}</span>
            </>
          )}
        </span>
      )}
      {!renaming && interactive && (
        <button
          type="button"
          className="pw-icon-btn pw-icon-btn--sm pw-sess-more"
          tabIndex={-1}
          aria-label="会话操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="会话操作：改名 / 移动 / 归档 / 删除"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(session.id, { x: rect.right - 200, y: rect.bottom + 4 });
          }}
        >
          <Icon name="more" />
        </button>
      )}
    </div>
  );
});

function RenameField({ session, title, onCommit }: { session: SessionInfo; title: string; onCommit: (name: string | null) => void }) {
  const initial = session.name || title;
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    return () => cancelAnimationFrame(id);
  }, []);
  // 未改动时传 null：推导出来的显示标题不能被当成名字存下。
  const finish = (name: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(name === null || name === initial ? null : name);
  };
  return (
    <input
      ref={inputRef}
      className="pw-input pw-input--sm pw-sess-rename"
      aria-label="会话名称"
      maxLength={200}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); finish(value); }
        if (event.key === "Escape") { event.preventDefault(); finish(null); }
      }}
    />
  );
}
