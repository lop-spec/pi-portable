"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { FilePenIcon } from "./conversation/icons";

const VISIBLE_FILES = 6;

/** Folder shown after the name: path relative to the project (empty at its root), else the parent folder. */
function folderLabel(filePath: string, cwd?: string): string {
  const dirs = filePath.split(/[\\/]+/u).filter(Boolean).slice(0, -1);
  if (cwd) {
    const base = cwd.split(/[\\/]+/u).filter(Boolean);
    const windows = /^[a-z]:$/iu.test(base[0] ?? "");
    const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (base.length <= dirs.length && base.every((part, index) => same(part, dirs[index]))) {
      const relative = dirs.slice(base.length);
      return relative.length > 2 ? `${relative[0]}/…/${relative[relative.length - 1]}` : relative.join("/");
    }
  }
  return dirs.at(-1) ?? "";
}

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths. One quiet row: a label,
 * sans-serif chips (name + parent folder), and「+N」past six files.
 */
export function TurnWrittenFiles({ files, cwd, onOpenFile }: {
  files: WrittenFile[];
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  if (files.length === 0) return null;
  const shown = showAll ? files : files.slice(0, VISIBLE_FILES);
  const hidden = files.length - shown.length;

  return (
    <div className="pw-turn-files" role="group" aria-label={t("chat.filesWritten")}>
      <span className="pw-turn-files-label">改动 {files.length} 个文件</span>
      {shown.map(({ filePath }) => {
        const name = getFileName(filePath);
        const dir = folderLabel(filePath, cwd);
        return (
          <button
            key={filePath}
            type="button"
            className="pw-chip"
            title={filePath}
            aria-label={t("chat.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(filePath)}
          >
            <FilePenIcon />
            <span className="pw-chip-label">{name}</span>
            {dir && <span className="pw-chip-sub">{dir}</span>}
          </button>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="pw-btn pw-btn--ghost pw-btn--sm" aria-expanded={false} onClick={() => setShowAll(true)} title="显示全部改动的文件">
          +{hidden}
        </button>
      )}
    </div>
  );
}
