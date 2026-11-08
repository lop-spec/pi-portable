"use client";
// 新会话页的「继续任务」（取自 Kun 的欢迎页）：输入框下方列出最该接着做的几个会话——运行中的、等你处理的、最近改动的。
// 只在空白新会话页出现，点一下就回到那个会话；没有可继续的会话时什么都不显示。
import { useMemo } from "react";
import { hasAssignedStatus, statusOf } from "@/lib/craft-session/model.mjs";
import { resumeCandidates } from "@/lib/portable-session-board.mjs";
import { openPortableSession, setPortableBoardOpen, usePortableSessions, usePortableUnreadIds } from "@/lib/portable-session-store";
import { StatusGlyph, useSessionWorkflow } from "./CraftSessions";
import { projectLabel } from "./sidebar/project-label";
import { deriveSessionTitle } from "./sidebar/session-title";
import { formatSessionTime } from "./sidebar/session-time";

export function WelcomeResume() {
  const { sessions, running } = usePortableSessions();
  const unread = usePortableUnreadIds();
  const workflow = useSessionWorkflow();
  const items = useMemo(() => resumeCandidates({
    sessions: sessions.filter((session) => session.relation?.kind !== "subagent" && !session.transient),
    statusOf: (session) => ({ status: statusOf(workflow.records, session.id), assigned: hasAssignedStatus(workflow.records, session.id) }),
    isRunning: (session) => running.has(session.id),
    isUnread: (session) => unread.has(session.id),
    limit: 3,
  }), [running, sessions, unread, workflow.records]);
  if (items.length === 0) return null;
  const now = new Date();

  return (
    <div className="pw-composer-gutter">
      <section className="pw-resume" aria-label="继续任务">
        <header className="pw-resume-head">
          <h2>继续任务</h2>
          <button type="button" className="pw-resume-all" onClick={() => setPortableBoardOpen(true)}>全部看板</button>
        </header>
        <div className="pw-resume-grid">
          {items.map(({ session, column }) => {
            const title = deriveSessionTitle(session.name, session.firstMessage, session.id);
            const state = column === "running" ? "运行中" : column === "attention" ? (unread.has(session.id) ? "有新回复" : "待审查") : formatSessionTime(session.modified || session.created, now);
            return (
              <button key={session.id} type="button" data-session-id={session.id} className={`pw-resume-card${column === "running" ? " is-running" : column === "attention" ? " is-attention" : ""}`} title={title} onClick={() => openPortableSession(session.id)}>
                <span className="pw-resume-title">
                  {column === "running" ? <span className="pw-spinner pw-spinner--sm" aria-hidden="true" /> : <StatusGlyph status={column === "attention" ? "needs-review" : statusOf(workflow.records, session.id)} />}
                  <span>{title}</span>
                </span>
                <span className="pw-resume-meta">
                  <span className="pw-resume-project">{projectLabel({ root: session.projectRoot ?? session.cwd })}</span>
                  <span className="pw-resume-state">{state}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
