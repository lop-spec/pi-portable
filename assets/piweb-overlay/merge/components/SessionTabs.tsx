"use client";
// 顶栏仅展示当前会话；标题跟随该会话最近一条用户提问更新，不维护历史标签列表。
import { Icon } from "./sidebar/icons";
import { openPortableSession, startPortableSession, usePortableSessions } from "@/lib/portable-session-store";

export function SessionTabs() {
  const { sessions, running, selectedId, draftOpen, latestUserQuestion } = usePortableSessions();
  const selected = selectedId ? sessions.find((session) => session.id === selectedId) : undefined;
  const title = selected
    ? (latestUserQuestion?.sessionId === selectedId
      ? latestUserQuestion.text
      : selected.firstMessage.replace(/\s+/gu, " ").trim() || selected.name || selected.id)
    : "新会话";
  const visible = Boolean(selected || draftOpen);

  return (
    <div className="pw-tabs" role="tablist" aria-label="当前会话">
      <div className="pw-tabs-list">
        {visible && (
          <div className={`pw-tab is-selected${selected ? "" : " is-draft"}`} role="presentation" data-session-id={selected?.id}>
            <button type="button" role="tab" aria-selected="true" tabIndex={0} className="pw-tab-main" title={title} onClick={selected ? () => openPortableSession(selected.id) : undefined}>
              {selected && running.has(selected.id) && <span className="pw-spinner pw-spinner--sm" role="status" aria-label="运行中" />}
              <span className="pw-tab-title">{title}</span>
            </button>
            {selected && (
              <button type="button" tabIndex={-1} className="pw-tab-close" aria-label="关闭当前标签" title="关闭当前标签（不会停止会话）" onClick={startPortableSession}>
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        )}
      </div>
      <button type="button" className="pw-icon-btn pw-icon-btn--sm pw-tabs-new" title="新建会话（Ctrl Alt N）" aria-label="新建会话" onClick={startPortableSession}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
