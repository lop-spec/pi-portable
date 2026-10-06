"use client";
// 左栏通用浮层菜单：.pw-menu 外观 + 定位（贴在锚点下方或鼠标位置，自动翻到上方并夹在视口内）
// + 键盘（↑↓ Home End 移动，Esc 关闭并把焦点还给触发按钮；Tab 在菜单项上关闭，在内嵌表单控件里正常移动焦点）
// + 点外部关闭 + 锚点被滚走（所在滚动容器滚动且位移超过阈值）时关闭。
// 菜单经 portal 挂到 body，但 React 事件仍会冒泡回祖先组件（会话行的 onClick、列表的方向键），
// 所以根节点上把 click / contextmenu / keydown 都截住。
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { shouldCloseOnScroll, tabAction } from "./menu-behavior";

export type MenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; rect: { left: number; top: number; right: number; bottom: number; width: number }; element?: Element | null; align?: "start" | "end"; matchWidth?: boolean; offset?: number };

export type MenuCloseReason = "escape" | "outside" | "tab" | "scroll";

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
const MARGIN = 8;
const TABBABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]';

function enabledItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter((item) => (
    item.getAttribute("aria-disabled") !== "true" && !(item as HTMLButtonElement).disabled && item.offsetParent !== null
  ));
}

/** 菜单内当前可 Tab 到的控件（按 DOM 顺序）：可见、未禁用、tabindex 不是 -1。 */
function tabbableControls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter((item) => (
    !(item as HTMLButtonElement).disabled && item.tabIndex >= 0 && item.offsetParent !== null
  ));
}

export function anchorFromElement(element: Element | null, options: { align?: "start" | "end"; matchWidth?: boolean; offset?: number } = {}): MenuAnchor {
  const rect = element?.getBoundingClientRect();
  if (!rect) return { kind: "point", x: 0, y: 0 };
  return { kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width }, element, ...options };
}

export function PopMenu({
  anchor,
  onClose,
  returnFocus,
  ariaLabel,
  className,
  width,
  initialFocus = "first",
  ignoreOutside,
  children,
}: {
  anchor: MenuAnchor;
  onClose: (reason: MenuCloseReason) => void;
  returnFocus?: HTMLElement | null;
  ariaLabel: string;
  className?: string;
  width?: number;
  initialFocus?: "first" | "checked" | "none";
  ignoreOutside?: (target: Node) => boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const ignoreRef = useRef(ignoreOutside);
  ignoreRef.current = ignoreOutside;
  // 菜单依附的元素及其打开时的位置：滚动时据此判断菜单是否和锚点分开了。
  const anchorElementRef = useRef<Element | null>(null);
  const anchorStartRef = useRef<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // 锚点元素必须在菜单显示之前取：rect 锚点带着触发按钮；point 锚点（右键 / 键盘）取该点下的元素
    // （此刻菜单还是 visibility:hidden，不参与命中测试）。滚动时据此判断菜单是否和锚点分开了。
    const anchorElement = anchor.kind === "rect" ? anchor.element ?? null : document.elementFromPoint(anchor.x, anchor.y);
    anchorElementRef.current = anchorElement;
    const anchorRect = anchorElement?.getBoundingClientRect();
    anchorStartRef.current = anchorRect ? { left: anchorRect.left, top: anchorRect.top } : null;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    let left: number;
    let top: number;
    let up = false;
    if (anchor.kind === "point") {
      left = anchor.x;
      top = anchor.y;
      if (top + rect.height > viewportH - MARGIN) top = Math.max(MARGIN, anchor.y - rect.height);
    } else {
      const offset = anchor.offset ?? 4;
      const menuWidth = anchor.matchWidth ? anchor.rect.width : rect.width;
      left = anchor.align === "end" ? anchor.rect.right - menuWidth : anchor.rect.left;
      top = anchor.rect.bottom + offset;
      if (top + rect.height > viewportH - MARGIN && anchor.rect.top - offset - rect.height >= MARGIN) {
        top = anchor.rect.top - offset - rect.height;
        up = true;
      }
    }
    left = Math.max(MARGIN, Math.min(left, viewportW - rect.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, viewportH - rect.height - MARGIN));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.classList.toggle("pw-menu--up", up);
    menu.style.visibility = "visible";
    // 只在挂载时定位一次；锚点被滚走（见下方 scroll 监听）直接关闭菜单。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || initialFocus === "none") return;
    const auto = menu.querySelector<HTMLElement>("[data-autofocus]");
    const items = enabledItems(menu);
    const checked = initialFocus === "checked"
      ? items.find((item) => item.getAttribute("aria-checked") === "true")
      : undefined;
    (auto ?? checked ?? items[0] ?? menu).focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(ref.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || inside(target)) return;
      // 对话框、以及从本菜单里再弹出的子菜单（各自是独立 portal）里的点击不算外部。
      if (target instanceof Element && target.closest("dialog[open], [data-pi-context-menu]")) return;
      if (ignoreRef.current?.(target)) return;
      closeRef.current("outside");
    };
    // 只有「锚点所在的滚动容器」滚动、且锚点位移超过阈值才关；页面上别处的滚动（聊天流式自动滚动、
    // 列表自动定位到选中会话）与菜单无关，不能把正在操作的菜单关掉。
    const onScroll = (event: Event) => {
      if (inside(event.target)) return;
      const target = event.target;
      const anchorElement = anchorElementRef.current;
      const current = anchorElement?.getBoundingClientRect();
      const close = shouldCloseOnScroll({
        scroller: target instanceof Node && target.nodeType !== Node.DOCUMENT_NODE ? target : null,
        anchor: anchorElement,
        start: anchorStartRef.current,
        current: current ? { left: current.left, top: current.top } : null,
      });
      if (close) closeRef.current("scroll");
    };
    const onResize = () => closeRef.current("scroll");
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const restore = () => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      data-pi-context-menu="true"
      className={className ? `pw-menu pw-sb-menu ${className}` : "pw-menu pw-sb-menu"}
      style={{ position: "fixed", left: 0, top: 0, width, visibility: "hidden" }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        const menu = ref.current;
        if (!menu) return;
        if (event.key === "Escape") {
          event.preventDefault();
          restore();
          closeRef.current("escape");
          return;
        }
        const target = event.target as HTMLElement;
        if (event.key === "Tab") {
          // 菜单项上的 Tab 关闭菜单；内嵌表单（新建 worktree 的分支名 / 取消 / 创建）里的 Tab 正常移动焦点，
          // 从菜单最后一个（Shift+Tab 为第一个）控件出去时才关闭。
          const controls = tabbableControls(menu);
          const action = tabAction({
            onMenuItem: target === menu || target.matches(ITEM_SELECTOR),
            index: controls.indexOf(target),
            count: controls.length,
            shift: event.shiftKey,
          });
          if (action === "close") {
            event.preventDefault();
            restore();
            closeRef.current("tab");
          }
          return;
        }
        const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
        if (inField && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = enabledItems(menu);
        if (items.length === 0) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next: number;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else if (current < 0) next = event.key === "ArrowDown" ? 0 : items.length - 1;
        else next = (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
