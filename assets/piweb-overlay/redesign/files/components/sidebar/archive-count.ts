// 归档视图的计数（QA review：头部「858 个对话」是全局数，列表却按当前项目过滤，出现「858 个对话」配「没有已归档的会话」）。
// 纯函数，可直接单测。代理给的 x-pi-archived-count 数的是所有项目；列表里实际显示的只是当前项目那部分。
import type { SessionFamily } from "@/lib/session-family";

// 代理的归档分区给每个归档会话加 archived: true / archiveGroupId（活动会话没有），SessionInfo 类型里没声明。
const isArchived = (family: SessionFamily) => (family.root as { archived?: boolean }).archived === true;

/**
 * 当前项目在归档视图里的归档数（一个家族 = 主会话 + 它的子代理 = 一个对话，与代理的 archivedCount 同口径）。
 * 视图刚切换、归档列表还没到时，屏幕上还是活动会话：返回 null（未知），不把活动数当归档数。空列表是确定的 0。
 */
export function archivedProjectCount(families: readonly SessionFamily[]): number | null {
  if (families.length === 0) return 0;
  return families.some(isArchived) ? families.filter(isArchived).length : null;
}

/** 本项目没有归档时的空态文案；total 是注入脚本写的全局归档数（此时全部都在其他项目）。 */
export function archiveEmptyMessage(total: number): string {
  return Number.isFinite(total) && total > 0 ? `本项目没有归档，其他项目共 ${total} 个` : "没有已归档的会话";
}
