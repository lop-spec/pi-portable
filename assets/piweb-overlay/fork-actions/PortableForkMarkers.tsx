"use client";

import { useI18n } from "@/hooks/useI18n";
import { ForkIcon } from "./conversation/icons";
import { useForkInfo } from "@/lib/portable-fork";
import type { SessionInfo } from "@/lib/types";

// Top of a forked session: where it came from (a link back to the source session).
export function PortableForkedFrom({ session, onOpenSession }: { session: SessionInfo | null; onOpenSession?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const relation = session?.relation;
  const fork = relation?.kind === "fork" ? relation : null;
  const info = useForkInfo(fork ? session?.id : undefined);
  if (!fork) return null;
  const originId = fork.originSessionId;
  const origin = originId ? info.origin : null;
  return (
    <div className="pw-fork-marker is-origin" data-testid="fork-marker">
      <ForkIcon />
      {originId && (origin || !info.loaded) ? (
        <>
          <span>{t("chat.forkedFrom")}</span>
          <button type="button" className="pw-fork-link" title={origin?.title} onClick={() => onOpenSession?.(originId)}>{origin?.title ?? "…"}</button>
        </>
      ) : (
        <span>{t("chat.forkedFromOther")}</span>
      )}
    </div>
  );
}

// Under the turn a fork left: the fork(s) made from here, each a link into that session.
export function PortableForkHere({ sessionId, entryId, onOpenSession }: { sessionId?: string; entryId?: string; onOpenSession?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const { forks } = useForkInfo(sessionId);
  const here = entryId ? forks.filter((fork) => fork.anchorEntryId === entryId) : [];
  if (here.length === 0) return null;
  return (
    <div className="pw-fork-marker" data-testid="fork-marker">
      <ForkIcon />
      <span>{here.length === 1 ? t("chat.forkedHere") : t("chat.forksHere", { count: here.length })}</span>
      {here.map((fork) => (
        <button key={fork.id} type="button" className="pw-fork-link" title={fork.title} onClick={() => onOpenSession?.(fork.id)}>{fork.title}</button>
      ))}
    </div>
  );
}
