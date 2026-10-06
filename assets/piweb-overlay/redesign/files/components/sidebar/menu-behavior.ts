// 左栏浮层菜单的纯判定（无 DOM 依赖，可直接单测）：滚动何时该关菜单、Tab 何时该关菜单。

/** 锚点位移超过这个像素数才算「菜单和它依附的东西分开了」。 */
export const SCROLL_CLOSE_THRESHOLD = 4;

export interface ScrollPoint { left: number; top: number }

export interface ScrollCloseInput {
  /** 发生滚动的节点；页面级（document）滚动传 null。 */
  scroller: Pick<Node, "contains"> | null;
  /** 菜单依附的元素（触发按钮 / 被右键的会话行）；解析不到传 null。 */
  anchor: Node | null;
  /** 菜单打开时锚点的左上角。 */
  start: ScrollPoint | null;
  /** 当前锚点的左上角。 */
  current: ScrollPoint | null;
  threshold?: number;
}

/**
 * 只在「滚动的容器包含锚点、且锚点真的被带走」时关闭菜单。
 * 聊天流式自动滚动、别处列表自动定位这类与锚点无关的滚动不动菜单。
 */
export function shouldCloseOnScroll({ scroller, anchor, start, current, threshold = SCROLL_CLOSE_THRESHOLD }: ScrollCloseInput): boolean {
  if (!anchor) return scroller === null;
  if (scroller && !scroller.contains(anchor)) return false;
  if (!anchor.isConnected) return true;
  if (!start || !current) return true;
  return Math.hypot(current.left - start.left, current.top - start.top) > threshold;
}

export type TabAction = "close" | "native";

/**
 * 菜单里按 Tab：焦点在菜单项（或菜单本身）上就关闭并还焦点（ARIA menu 约定）；
 * 焦点在内嵌表单控件（输入框、取消/创建按钮）上就放行浏览器默认的 Tab，直到从菜单里最后一个（Shift+Tab 为第一个）控件出去时才关闭。
 */
export function tabAction({ onMenuItem, index, count, shift }: { onMenuItem: boolean; index: number; count: number; shift: boolean }): TabAction {
  if (onMenuItem || index < 0 || count <= 0) return "close";
  return (shift ? index === 0 : index === count - 1) ? "close" : "native";
}
