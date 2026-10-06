"use client";

// Render-error boundary. React unmounts the whole tree when a render throws and nothing
// catches it, and the app had no boundary at all: one failed lazy chunk (a tab loaded before
// a release switch, a dropped connection) or one bad message turned the page white. A boundary
// keeps the failure local, logs it (console.error, with the scope), and shows a banner the
// reader can recover from. Without `fallback` the banner replaces the children; with a plain
// `fallback` node (e.g. a code block falling back to plain text) nothing is shown to the user.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangleIcon } from "./conversation/icons";

// Webpack: ChunkLoadError / "Loading chunk N failed"; native dynamic import: the browser's own wording.
const CHUNK_ERROR = /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "ChunkLoadError" || (typeof message === "string" && CHUNK_ERROR.test(message));
}

/** A tab that outlived a release keeps asking for chunks the new build no longer has; one automatic reload per minute fixes it. */
export const CHUNK_RELOAD_KEY = "pi-web:chunk-reload-at";
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

/**
 * True once per window: the caller may reload the page automatically. The timestamp lives in sessionStorage, so a reload
 * that did not fix the failure (the chunk is really gone, the server is down) shows the manual button instead of looping;
 * a release days later may reload again. Without usable storage there is no loop guard, so no automatic reload.
 */
export function claimChunkReload(storage: Pick<Storage, "getItem" | "setItem"> | null, now: number): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export interface ErrorBannerProps {
  /** What failed to render, e.g. 对话区. */
  scope: string;
  error: Error;
  onRetry: () => void;
  /** Dialog panels: the owner can close the failed panel (clears its open state). Adds a 关闭 button. */
  onDismiss?: () => void;
}

export function ErrorBanner({ scope, error, onRetry, onDismiss }: ErrorBannerProps) {
  const chunk = isChunkLoadError(error);
  return (
    <div className="pw-error-banner" role="alert">
      <AlertTriangleIcon className="pw-error-banner-icon" />
      <div className="pw-error-banner-text">
        <span className="pw-error-banner-title">{scope}显示出错</span>
        <span className="pw-error-banner-msg">
          {chunk ? "页面资源加载失败（可能已发布新版本或网络中断），刷新页面即可恢复。" : error.message || "未知错误"}
        </span>
      </div>
      <div className="pw-error-banner-acts">
        <button type="button" className="pw-btn" onClick={onRetry}>重试</button>
        {onDismiss && <button type="button" className="pw-btn" onClick={onDismiss}>关闭</button>}
        <button type="button" className={chunk ? "pw-btn pw-btn--primary" : "pw-btn"} onClick={() => window.location.reload()}>刷新页面</button>
      </div>
    </div>
  );
}

export interface ErrorBoundaryFallbackState {
  scope: string;
  error: Error;
  /** Clear the error and render the children again (the same as the banner's 重试). */
  reset: () => void;
}

export interface ErrorBoundaryProps {
  /** What this boundary protects; shown in the banner and written to console.error. */
  scope: string;
  /** Replaces the children after an error: a node, or a function of the error and a reset. Default: a recoverable banner. */
  fallback?: ReactNode | ((state: ErrorBoundaryFallbackState) => ReactNode);
  /** Called after the error is cleared (retry or resetKey change) so the owner can rebuild what it passes as children, e.g. a fresh lazy component. */
  onReset?: () => void;
  /** Centre the default banner in the space the children occupied (a whole pane). */
  fill?: boolean;
  /** A change clears a caught error (another session was opened, the code changed...). */
  resetKey?: unknown;
  children?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[pi-web] ${this.props.scope}渲染失败:`, error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.reset();
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback, scope } = this.props;
    if (typeof fallback === "function") return fallback({ scope, error, reset: this.reset });
    if (fallback !== undefined) return fallback;
    const banner = <ErrorBanner scope={scope} error={error} onRetry={this.reset} />;
    return this.props.fill ? <div className="pw-error-region">{banner}</div> : banner;
  }
}
