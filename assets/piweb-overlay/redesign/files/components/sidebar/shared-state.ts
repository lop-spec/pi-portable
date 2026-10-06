// 结构共享：后台刷新拿到的会话列表与上次相同的行沿用旧对象，整表没变就沿用旧数组，
// 让 memo 的行组件、onSessionsChange 和下游的会话目录都不因「内容没变的新对象」重算（审计 P10）。
import type { SessionInfo } from "@/lib/types";

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a) as (keyof SessionInfo)[];
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => sameValue(a[key], b[key]));
}

export function shareSessionList(previous: SessionInfo[], next: SessionInfo[]): SessionInfo[] {
  if (previous === next) return previous;
  const byId = new Map(previous.map((session) => [session.id, session]));
  let reused = 0;
  const merged = next.map((session) => {
    const old = byId.get(session.id);
    if (old && sameSession(old, session)) {
      reused += 1;
      return old;
    }
    return session;
  });
  if (reused === previous.length && merged.length === previous.length && merged.every((session, index) => session === previous[index])) {
    return previous;
  }
  return merged;
}

export function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** 小对象（项目注册表等）内容相同就沿用旧引用。 */
export function shareJson<T>(previous: T, next: T): T {
  return sameValue(previous, next) ? previous : next;
}
