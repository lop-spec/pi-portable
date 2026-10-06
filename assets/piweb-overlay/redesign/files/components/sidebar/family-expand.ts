// 子代理家族的自动展开：选中的是子代理时展开它所在的家族让选中行可见，但只在「选中会话变化」后做一次，
// 之后用户手动折叠要被尊重（否则折叠会被 effect 立刻撤销）。纯函数，可直接单测。

export interface FamilyLike {
  root: { id: string };
  subagents: readonly { id: string }[];
}

export interface AutoExpandResult {
  /** 需要展开的主会话 id；不需要展开为 null。 */
  rootId: string | null;
  /** 下一次调用传回的「已为哪个选中会话展开过」。 */
  handledId: string | null;
}

export function resolveAutoExpand(families: readonly FamilyLike[], selectedId: string | null, handledId: string | null): AutoExpandResult {
  if (!selectedId) return { rootId: null, handledId: null };
  if (handledId === selectedId) return { rootId: null, handledId };
  const family = families.find((item) => item.subagents.some((session) => session.id === selectedId));
  // 找不到：目录还没加载完，或选中的不是子代理。不记账——目录补全后（子代理关系到位）还会再试；
  // 选中变成别的会话时 handledId 随之清空，下次再选回这个子代理仍会展开。
  if (!family) return { rootId: null, handledId: null };
  return { rootId: family.root.id, handledId: selectedId };
}
