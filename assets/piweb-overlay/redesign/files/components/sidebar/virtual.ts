// 变高虚拟列表的纯函数：分组头和行高度不同，按累计偏移二分查找可见区间。

export interface VirtualLayout {
  /** offsets[i] = 第 i 项顶部；offsets[length] = 总高度 */
  offsets: number[];
  total: number;
}

export function buildLayout(heights: readonly number[]): VirtualLayout {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i += 1) offsets[i + 1] = offsets[i] + heights[i];
  return { offsets, total: offsets[heights.length] };
}

/** 最后一个顶部 ≤ y 的项。 */
export function indexAt(layout: VirtualLayout, y: number): number {
  const count = layout.offsets.length - 1;
  if (count <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 视口内的项加上下各 overscan 项；pinned（例如正在改名的行）不在区间内时也保留挂载。
 * 视口高度未测量（0）时按 600px 估算。
 */
export function visibleIndices(
  layout: VirtualLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
  pinned: readonly number[] = [],
): number[] {
  const count = layout.offsets.length - 1;
  if (count <= 0) return [];
  const height = viewportHeight || 600;
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, layout.total - height)));
  const start = Math.max(0, indexAt(layout, top) - overscan);
  const end = Math.min(count, indexAt(layout, top + height) + 1 + overscan);
  const indices: number[] = [];
  for (let i = start; i < end; i += 1) indices.push(i);
  for (const index of pinned) {
    if (index >= 0 && index < count && (index < start || index >= end)) indices.push(index);
  }
  return indices.sort((a, b) => a - b);
}

/** 让第 index 项进入视口所需的 scrollTop；已在视口内返回 null。center 时居中。 */
export function scrollTopToReveal(
  layout: VirtualLayout,
  index: number,
  scrollTop: number,
  viewportHeight: number,
  center = false,
): number | null {
  const itemTop = layout.offsets[index];
  const itemBottom = layout.offsets[index + 1];
  if (itemTop === undefined || itemBottom === undefined || viewportHeight <= 0) return null;
  if (itemTop >= scrollTop && itemBottom <= scrollTop + viewportHeight) return null;
  const maxTop = Math.max(0, layout.total - viewportHeight);
  const target = center
    ? itemTop - viewportHeight / 2 + (itemBottom - itemTop) / 2
    : itemTop < scrollTop ? itemTop : itemBottom - viewportHeight;
  return Math.round(Math.max(0, Math.min(maxTop, target)));
}
