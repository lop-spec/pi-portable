import { memo, Fragment, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import type { ThemedToken } from "shiki";
import { ensureLang, getHighlightVersion, resolveLang, subscribeHighlighter, themeForMode, tokenizeIncremental, type LineCache, type ThemeMode } from "./shiki";
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeTheme(listener: () => void): () => void {
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const cb of themeListeners) cb();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
  }
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  return !document.documentElement.classList.contains("dark") ? "light" : "dark";
}

function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
}

/* ---------- syntax highlighting ---------- */

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const fontStyle = token.fontStyle ?? 0;
  if (!token.color && !fontStyle) return undefined;
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (fontStyle & 1) style.fontStyle = "italic";
  if (fontStyle & 2) style.fontWeight = "bold";
  if (fontStyle & 4) style.textDecoration = "underline";
  return style;
}

/* Rows are cached by reference in the line cache, so settled lines memo-skip. */
const TokenLine = memo(function TokenLine({ line }: { line: ThemedToken[] }) {
  return (
    <>
      {line.map((token, i) => (
        <span key={i} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  );
});

function useHighlightedTokens(
  code: string,
  lang: string,
): ThemedToken[][] | null {
  const resolved = resolveLang(lang);
  const mode = useThemeMode();
  const version = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
    getHighlightVersion,
  );
  useEffect(() => {
    if (resolved) ensureLang(resolved);
  }, [resolved]);
  const cacheRef = useRef<LineCache | null>(null);
  return useMemo(() => {
    if (!resolved) return null;
    const next = tokenizeIncremental(
      cacheRef.current,
      code,
      resolved,
      themeForMode(mode),
    );
    cacheRef.current = next;
    return next?.tokens ?? null;
    // `version` re-runs this once the language finishes lazy-loading.
  }, [code, resolved, mode, version]);
}

/**
 * Tokenized code body (no chrome). Shared with the transcript's tool result
 * blocks so both use the one incremental highlighter cache.
 */
export function HighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const tokens = useHighlightedTokens(code, lang);
  if (!tokens) return <>{code}</>;
  return (
    <>
      {tokens.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? "\n" : null}
          <TokenLine line={line} />
        </Fragment>
      ))}
    </>
  );
}

