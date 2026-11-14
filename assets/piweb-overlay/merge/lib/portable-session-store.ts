"use client";
// 标签栏、欢迎页共用的会话快照：AppShell 发布，两个视图订阅；打开会话、新建会话走 window 事件，
// 避免给 ChatWindow 这类 memo 组件增加会变引用的 props。
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionInfo } from "@/lib/types";

export interface PortableSessionView {
  sessions: readonly SessionInfo[];
  running: ReadonlySet<string>;
  selectedId: string | null;
  /** 正在显示一个还没有保存的新会话输入框。 */
  draftOpen: boolean;
  /** 当前会话最近一条用户问题；由对话消息视图发布。 */
  latestUserQuestion: { sessionId: string; text: string } | null;
}

const EMPTY: ReadonlySet<string> = new Set();
let view: PortableSessionView = { sessions: [], running: EMPTY, selectedId: null, draftOpen: false, latestUserQuestion: null };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishPortableSessions(next: Partial<PortableSessionView>): void {
  const merged: PortableSessionView = { ...view, ...next };
  const same = (Object.keys(merged) as (keyof PortableSessionView)[]).every((key) => merged[key] === view[key]);
  if (same) return;
  view = merged;
  listeners.forEach((listener) => listener());
}

export function usePortableSessions(): PortableSessionView {
  return useSyncExternalStore(subscribe, () => view, () => view);
}

export const OPEN_SESSION_EVENT = "pi-web:open-session";
export const NEW_SESSION_EVENT = "pi-web:new-session";

export function openPortableSession(id: string): void {
  window.dispatchEvent(new CustomEvent<{ id: string }>(OPEN_SESSION_EVENT, { detail: { id } }));
}

export function startPortableSession(): void {
  window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT));
}

const UNREAD_KEY = "pi-web:unread-session-ids";

function readUnreadRaw(): string {
  try { return window.localStorage.getItem(UNREAD_KEY) ?? ""; } catch { return ""; }
}

function subscribeUnread(listener: () => void): () => void {
  // 同一标签页内侧栏写 localStorage 不触发 storage 事件，所以再加一个轻量轮询。
  const timer = window.setInterval(listener, 2000);
  window.addEventListener("storage", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("storage", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

/** 侧栏维护并持久化的「有新回复」会话 id 集合（与侧栏小圆点同源）。 */
export function usePortableUnreadIds(): ReadonlySet<string> {
  const raw = useSyncExternalStore(subscribeUnread, readUnreadRaw, () => "");
  return useMemo(() => {
    try {
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return EMPTY;
    }
  }, [raw]);
}

/** 订阅一次 window 事件；回调引用变化时自动重新挂载。 */
export function useWindowEvent<T extends Event>(name: string, handler: (event: T) => void): void {
  useEffect(() => {
    const listener = (event: Event) => handler(event as T);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [name, handler]);
}
