"use client";
// 左栏共用对话框：原生 <dialog> + showModal()（焦点陷阱、Esc、顶层渲染、居中由 globals.css 兜底），
// 外观用 .pw-dialog 原语。portal 到 body，React 事件不再冒泡回会话行/列表。
// 初始焦点：showModal() 之后聚焦 [data-autofocus]（输入框；删除类对话框是「取消」），没有就聚焦第一个表单控件；
// 不能用 React autoFocus（<dialog> 未打开时 focus() 无效，showModal() 随后会把焦点给右上角「关闭」）。
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusInitialControl } from "./dialog-focus";
import { Icon } from "./icons";

export function PwDialog({
  title,
  onClose,
  busy = false,
  size,
  onSubmit,
  footer,
  returnFocus,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  size?: "sm" | "lg";
  onSubmit?: () => void;
  footer: ReactNode;
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusInitialControl(dialog);
    return () => {
      if (dialog.open) dialog.close();
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) onSubmit?.();
  };

  return createPortal(
    <dialog
      ref={ref}
      className={size ? `pw-dialog pw-dialog--${size}` : "pw-dialog"}
      aria-labelledby={titleId}
      data-pi-project-dialog="true"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        event.stopPropagation();
        // 点遮罩（dialog 自身而不是内容）关闭
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form onSubmit={submit} style={{ display: "contents" }}>
        <div className="pw-dialog-header">
          <h2 id={titleId} className="pw-dialog-title">{title}</h2>
          <button type="button" className="pw-icon-btn" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pw-dialog-body">{children}</div>
        <div className="pw-dialog-footer">{footer}</div>
      </form>
    </dialog>,
    document.body,
  );
}
