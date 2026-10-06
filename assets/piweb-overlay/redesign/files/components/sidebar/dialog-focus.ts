// 对话框的初始焦点。React 的 autoFocus 在 <dialog> 还没 showModal() 时执行 focus()（display:none 下无效），
// showModal() 随后只会聚焦第一个可聚焦元素（右上角「关闭」）。所以 showModal() 之后由这里主动聚焦：
// 优先 [data-autofocus]（输入框、删除类对话框的「取消」），其次第一个可用的表单控件。

export interface FocusableLike { focus(options?: { preventScroll?: boolean }): void }
export interface FocusRoot { querySelector(selector: string): FocusableLike | null }

export const AUTOFOCUS_SELECTOR = "[data-autofocus]";
export const FIELD_SELECTOR = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';

export function focusInitialControl(root: FocusRoot): FocusableLike | null {
  const target = root.querySelector(AUTOFOCUS_SELECTOR) ?? root.querySelector(FIELD_SELECTOR);
  target?.focus({ preventScroll: true });
  return target;
}
