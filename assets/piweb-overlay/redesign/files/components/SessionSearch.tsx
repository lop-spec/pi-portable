"use client";
// 跨会话全文搜索结果（替换会话列表显示）。结果行：标题 + 右侧时间；第二行项目名；
// 摘要只在和标题不同时显示，命中词用主色标出。↑↓ 在结果间移动，Enter 打开。
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { SessionSearchResponse } from "@/lib/session-search";
import { deriveSessionTitle } from "./sidebar/session-title";
import { formatSessionTime } from "./sidebar/session-time";

export function SessionSearch({ open, query, selectedSessionId, onSelectSession, labelForSession }: {
  open: boolean;
  query: string;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  labelForSession: (session: SessionInfo) => string;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ query: string; response?: SessionSearchResponse; failed?: boolean }>({ query: "" });
  const search = query.trim();
  const response = state.query === search ? state.response : undefined;
  const failed = state.query === search && state.failed;

  // Re-runs only when the query changes. It deliberately does not depend on the
  // session-list version: ordinary agent activity bumps that version every few
  // seconds, which used to refetch (and re-order) results while they were being
  // read.
  useEffect(() => {
    if (!open || !search) return;
    const controller = new AbortController();
    setState({ query: search });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sessions/search?${new URLSearchParams({ q: search })}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as SessionSearchResponse;
        if (!controller.signal.aborted) setState({ query: search, response: data });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[pi-web session-search] request failed:", error);
          setState({ query: search, failed: true });
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search]);

  if (!open || !search) return null;
  const now = new Date();
  return (
    <div
      className="pw-search scrollbar-subtle"
      aria-busy={!response && !failed}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".pw-search-item")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = index + (event.key === "ArrowDown" ? 1 : -1);
        if (next < 0) document.getElementById("session-search-input")?.focus();
        else items[Math.min(next, items.length - 1)]?.focus();
      }}
    >
      {failed ? (
        <p className="pw-search-status is-error" role="alert">{t("sidebar.sessionSearchFailed")}</p>
      ) : !response ? (
        <div className="pw-search-skeleton" role="status" aria-label={t("sidebar.sessionSearching")}>
          <span className="pw-skeleton" style={{ width: "78%" }} />
          <span className="pw-skeleton" style={{ width: "56%" }} />
          <span className="pw-skeleton" style={{ width: "68%" }} />
        </div>
      ) : response.results.length === 0 ? (
        <div className="pw-search-empty" role="status">
          <p>{t("sidebar.sessionSearchEmpty")}</p>
          <p className="pw-search-hint">换个关键词试试；归档的会话需切到归档视图再搜。</p>
        </div>
      ) : (
        <p className="pw-search-status" role="status">{t("sidebar.sessionSearchCount", { count: response.results.length })}</p>
      )}
      {response?.results.map(({ session, entryId, blockIndex, before, match, after }) => {
        const title = deriveSessionTitle(session.name, session.firstMessage, session.id);
        const snippet = `${before}${match}${after}`.trim();
        const showSnippet = snippet && !title.includes(snippet) && !snippet.startsWith(title);
        return (
          <button
            key={session.id}
            type="button"
            className="pw-search-item"
            onClick={() => onSelectSession(session, entryId, blockIndex)}
            aria-current={session.id === selectedSessionId ? "page" : undefined}
            title={session.cwd}
          >
            <span className="pw-search-line">
              <span className="pw-search-title">{title}</span>
              <span className="pw-search-time">{formatSessionTime(session.modified, now)}</span>
            </span>
            <span className="pw-search-project">{labelForSession(session)}</span>
            {showSnippet && (
              <span className="pw-search-snippet">
                {before}<mark className="pw-search-mark">{match}</mark>{after}
              </span>
            )}
          </button>
        );
      })}
      {response?.truncated && response.results.length > 0 && (
        <p className="pw-search-foot">只扫描了最近的部分会话，结果可能不完整。</p>
      )}
    </div>
  );
}
