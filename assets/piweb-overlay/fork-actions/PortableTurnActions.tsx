"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { CheckIcon, CopyIcon, ForkIcon } from "./conversation/icons";
import { useForkAfter } from "@/lib/portable-fork";
import { togglePortablePin, usePortablePin } from "@/lib/portable-pins";

/** Lucide "pin": outline, or filled while the turn is pinned. */
export function PortablePinIcon({ filled = false, className }: { filled?: boolean; className?: string }) {
  return (
    <svg className={["pw-i", className].filter(Boolean).join(" ")} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

// Under a finished answer, left of the model/time line (the same place and order as the Claude desktop app):
// copy, fork from here, pin as chapter. Fork and pin belong to the turn's final answer only.
export function PortableTurnActions({ sessionId, entryId, turnEnd, showCopy, copied, onCopy }: {
  sessionId?: string;
  entryId?: string;
  turnEnd: boolean;
  showCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const forkAfter = useForkAfter(turnEnd ? sessionId : undefined);
  const pinned = usePortablePin(turnEnd ? sessionId : undefined, entryId);
  const [forking, setForking] = useState(false);
  const canFork = Boolean(forkAfter && entryId);
  const canPin = Boolean(turnEnd && sessionId && entryId);
  if (!showCopy && !canFork && !canPin) return null;
  const fork = () => {
    if (!forkAfter || !entryId || forking) return;
    setForking(true);
    void forkAfter(entryId).finally(() => setForking(false));
  };
  const copyLabel = copied ? t("i18n.copied") : t("i18n.copyMessage");
  const forkLabel = forking ? t("chat.forking") : t("chat.forkFromHere");
  const pinLabel = pinned ? t("chat.unpinChapter") : t("chat.pinChapter");
  return (
    <span className="pw-turn-actions" role="group" aria-label={t("chat.turnActions")}>
      {showCopy && (
        <button type="button" className="pw-icon-btn pw-icon-btn--sm" onClick={onCopy} aria-label={copyLabel} title={copyLabel}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
      {canFork && (
        <button type="button" className="pw-icon-btn pw-icon-btn--sm" onClick={fork} disabled={forking} aria-label={forkLabel} title={forking ? forkLabel : `${forkLabel}：${t("chat.forkFromHereHint")}`}>
          {forking ? <span className="pw-spinner pw-spinner--sm" aria-hidden="true" /> : <ForkIcon />}
        </button>
      )}
      {canPin && (
        <button type="button" className="pw-icon-btn pw-icon-btn--sm" aria-pressed={pinned} onClick={() => togglePortablePin(sessionId!, entryId!)} aria-label={pinLabel} title={pinLabel}>
          <PortablePinIcon filled={pinned} />
        </button>
      )}
    </span>
  );
}
