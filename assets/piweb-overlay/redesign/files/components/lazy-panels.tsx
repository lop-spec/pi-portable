"use client";
// 按需面板（P27）：首屏只静态引入 侧栏 + 对话 + 输入框；下面这些平时关着的面板第一次打开时才下载、执行
// （连同各自的 CSS：xterm.css、settings.css、分支树样式）。AppShell / SessionSidebar 从这里引用，JSX 用法与原组件完全相同。
// 加载期间显示同尺寸骨架，不留空白。
//
// 失败处理：标签页常驻多日，发版换了 .next 之后旧页面再去拉旧 chunk 会 404，网络瞬断也一样。原来用的 next/dynamic
// 里的 React.lazy 会永久记住拒绝、又没有任何错误边界，一个面板加载失败就整页白屏。现在每个面板：
// - 加载器不缓存失败（createRetryableLoader），并换一个新的 lazy 组件（React.lazy 记住拒绝），下次挂载或点「重试」重新拉取；
// - 外面包一层 ErrorBoundary，失败时只在面板自己的位置显示提示条（重试 / 刷新页面），其余界面不受影响；
// - console.error 带面板名。
// 客户端才渲染（ClientOnly）= 原来 next/dynamic 的 ssr:false：服务端和 hydration 阶段只出骨架。
import { createElement, lazy, Suspense, useEffect, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type LazyExoticComponent, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { AlertTriangleIcon } from "./conversation/icons";
import { ErrorBanner, ErrorBoundary } from "./ErrorBoundary";
import { createRetryableLoader } from "./MermaidBlock";

function Bars({ widths = ["72%", "54%", "64%"] }: { widths?: string[] }) {
  return (
    <>
      {widths.map((width, index) => <span key={index} className="pw-skeleton" style={{ width }} />)}
    </>
  );
}

function PanelSkeleton() {
  return <div aria-busy="true" style={PANEL_SKELETON_STYLE}><Bars /></div>;
}

function TopPanelSkeleton() {
  return <div aria-busy="true" style={TOP_PANEL_SKELETON_STYLE}><Bars /></div>;
}

/** 对话框类面板的骨架：同样的遮罩、居中卡片和尺寸，组件到达后原位替换。 */
function DialogSkeleton({ width, height, zIndex }: { width: number; height?: string; zIndex: number }) {
  return (
    <div role="presentation" style={{ ...DIALOG_BACKDROP_STYLE, zIndex }}>
      <div aria-busy="true" style={{ ...DIALOG_SURFACE_STYLE, width, height }}>
        <Bars widths={["38%", "86%", "70%"]} />
      </div>
    </div>
  );
}

/** 顶栏「分支」按钮的占位：与真按钮同为 .pw-tb-btn，不可交互。手机上按钮由 AppShell 自己渲染，这里不占位。 */
function BranchTriggerSkeleton() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return (
    <span className="pw-tb-btn" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
      <span className="pw-tb-label">{t("i18n.branches")}</span>
    </span>
  );
}

const PANEL_SKELETON_STYLE: CSSProperties = { padding: "18px 20px" };
const TOP_PANEL_SKELETON_STYLE: CSSProperties = { padding: "12px 16px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" };
const DIALOG_BACKDROP_STYLE: CSSProperties = { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 8, background: "var(--backdrop)" };
const DIALOG_SURFACE_STYLE: CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  padding: "22px 20px",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--r-lg)",
  background: "var(--bg-elevated)",
  boxShadow: "var(--shadow-dialog)",
};
const DIALOG_FAILURE_SURFACE_STYLE: CSSProperties = { ...DIALOG_SURFACE_STYLE, padding: 12 };
const FLOATING_FAILURE_STYLE: CSSProperties = { position: "fixed", top: 52, left: 8, right: 8, zIndex: 1200, display: "flex", justifyContent: "center", pointerEvents: "none" };
const FLOATING_FAILURE_SURFACE_STYLE: CSSProperties = { ...DIALOG_SURFACE_STYLE, padding: 8, width: "100%", maxWidth: 580, pointerEvents: "auto" };

// ───────────────────────── 加载器 ─────────────────────────

export interface PanelLoader<P extends object> {
  /** 共享的、失败可重试的动态 import。 */
  load: () => Promise<ComponentType<P>>;
  /** 现在该渲染的 lazy 组件。加载失败后会换成新的：React.lazy 会永久记住拒绝状态。 */
  current: () => LazyExoticComponent<ComponentType<P>>;
}

export function createPanelLoader<P extends object>(name: string, importPanel: () => Promise<ComponentType<P>>): PanelLoader<P> {
  const load = createRetryableLoader(importPanel, (error) => {
    Lazy = makeLazy();
    console.error(`[pi-web] 面板「${name}」chunk 加载失败，重试会重新拉取（旧标签页遇到发版后的新构建时刷新页面即可）:`, error);
  });
  const makeLazy = () => lazy(() => load().then((component) => ({ default: component })));
  let Lazy = makeLazy();
  return { load, current: () => Lazy };
}

// ───────────────────────── 边界 ─────────────────────────

const subscribeNever = () => () => {};
/** 服务端和 hydration 阶段只渲染 fallback，挂载之后才渲染子节点（原 next/dynamic 的 ssr:false）。 */
function ClientOnly({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  return <>{mounted ? children : fallback}</>;
}

export interface PanelFailureContext {
  name: string;
  error: Error;
  /** 清掉错误并用新的 lazy 组件重新渲染面板（= 提示条上的「重试」）。 */
  reset: () => void;
}

export interface PanelFailure<P> {
  /** 默认提示条占满面板原来的位置（整块面板）。 */
  fill?: boolean;
  /** 自定义失败视图（对话框、顶栏按钮、顶部下拉面板）；不给就用边界默认的提示条。 */
  render?: (props: P, context: PanelFailureContext) => ReactNode;
}

/** 面板外包 ErrorBoundary + 客户端门 + Suspense 骨架；失败只影响面板位置，重试会换新的 lazy 组件。 */
export function guardedPanel<P extends object>(name: string, loader: PanelLoader<P>, Loading: ComponentType, failure: PanelFailure<P> = {}): ComponentType<P> {
  function GuardedPanel(props: P) {
    // 重试：边界清掉错误后 owner 重渲染一次，这里才取得失败时换上的新 lazy 组件
    const [, setAttempt] = useState(0);
    const Panel = loader.current();
    return (
      <ErrorBoundary scope={name} fill={failure.fill} onReset={() => setAttempt((count) => count + 1)} fallback={failure.render ? ({ error, reset }) => failure.render?.(props, { name, error, reset }) : undefined}>
        <ClientOnly fallback={<Loading />}>
          <Suspense fallback={<Loading />}>
            {createElement(Panel as ComponentType<P>, props)}
          </Suspense>
        </ClientOnly>
      </ErrorBoundary>
    );
  }
  GuardedPanel.displayName = `GuardedPanel(${name})`;
  return GuardedPanel;
}

function DialogFailureCard({ context, onDismiss, width, zIndex }: { context: PanelFailureContext; onDismiss?: () => void; width: number; zIndex: number }) {
  useEffect(() => {
    if (!onDismiss) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);
  return (
    <div role="presentation" style={{ ...DIALOG_BACKDROP_STYLE, zIndex }}>
      <div style={{ ...DIALOG_FAILURE_SURFACE_STYLE, width }}>
        <ErrorBanner scope={context.name} error={context.error} onRetry={context.reset} onDismiss={onDismiss} />
      </div>
    </div>
  );
}

/** 对话框类面板失败：同样的遮罩 + 居中卡片，里面是提示条（重试 / 关闭 / 刷新页面），「关闭」调用 props[dismiss]，Esc 同。 */
export function dialogFailure({ width, zIndex, dismiss }: { width: number; zIndex: number; dismiss: string }) {
  return function renderDialogFailure(props: object, context: PanelFailureContext): ReactNode {
    const close = (props as Record<string, unknown>)[dismiss];
    return <DialogFailureCard context={context} onDismiss={typeof close === "function" ? () => (close as () => void)() : undefined} width={width} zIndex={zIndex} />;
  };
}

/** 顶部下拉面板（子代理 / 系统提示词 / 工具定义）失败：面板同样的底色里一条提示条。 */
export function topPanelFailure(_props: object, { name, error, reset }: PanelFailureContext): ReactNode {
  return <div style={TOP_PANEL_SKELETON_STYLE}><ErrorBanner scope={name} error={error} onRetry={reset} /></div>;
}

/**
 * 顶栏「分支」失败：按钮位置换成一个小的「重试」按钮（整条提示条放不进顶栏）；
 * 手机上内联按钮被隐藏（hideInlineButton），面板只在打开时出现，这时在顶部浮一条提示条，「关闭」收起面板。
 */
export function branchFailure(props: { hideInlineButton?: boolean; onToggle?: () => void }, { name, error, reset }: PanelFailureContext): ReactNode {
  if (props.hideInlineButton) {
    return (
      <div style={FLOATING_FAILURE_STYLE}>
        <div style={FLOATING_FAILURE_SURFACE_STYLE}>
          <ErrorBanner scope={name} error={error} onRetry={reset} onDismiss={props.onToggle} />
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="pw-tb-btn" aria-label="分支面板加载失败，点击重试" title="分支面板加载失败，点击重试" style={{ color: "var(--danger)" }} onClick={reset}>
      <AlertTriangleIcon />
      <span className="pw-tb-label">分支</span>
    </button>
  );
}

// ───────────────────────── 面板 ─────────────────────────

const fileViewerLoader = createPanelLoader("文件查看器", () => import("./FileViewer").then((mod) => mod.FileViewer));
export const FileViewer = guardedPanel("文件查看器", fileViewerLoader, PanelSkeleton, { fill: true });

const terminalLoader = createPanelLoader("终端", () => import("./TerminalPanel").then((mod) => mod.TerminalPanel));
export const TerminalPanel = guardedPanel("终端", terminalLoader, PanelSkeleton, { fill: true });

const settingsLoader = createPanelLoader("设置", () => import("./SettingsPanel").then((mod) => mod.SettingsPanel));
export const SettingsPanel = guardedPanel("设置", settingsLoader, () => <DialogSkeleton width={1080} height="84vh" zIndex={1000} />, {
  render: dialogFailure({ width: 480, zIndex: 1000, dismiss: "onClose" }),
});

const trustLoader = createPanelLoader("项目信任确认", () => import("./ProjectTrustDialog").then((mod) => mod.ProjectTrustDialog));
export const ProjectTrustDialog = guardedPanel("项目信任确认", trustLoader, () => <DialogSkeleton width={440} zIndex={1100} />, {
  render: dialogFailure({ width: 440, zIndex: 1100, dismiss: "onCancel" }),
});

const directoryPickerLoader = createPanelLoader("目录选择器", () => import("./DirectoryPicker").then((mod) => mod.DirectoryPicker));
export const DirectoryPicker = guardedPanel("目录选择器", directoryPickerLoader, () => <DialogSkeleton width={560} height="min(560px, 80vh)" zIndex={1000} />, {
  render: dialogFailure({ width: 480, zIndex: 1000, dismiss: "onCancel" }),
});

const branchLoader = createPanelLoader("分支", () => import("./BranchNavigator").then((mod) => mod.BranchNavigator));
export const BranchNavigator = guardedPanel("分支", branchLoader, BranchTriggerSkeleton, { render: branchFailure });

const systemPromptLoader = createPanelLoader("系统提示词", () => import("./SystemPromptPanel").then((mod) => mod.SystemPromptPanel));
export const SystemPromptPanel = guardedPanel("系统提示词", systemPromptLoader, TopPanelSkeleton, { render: topPanelFailure });

const toolDefinitionsLoader = createPanelLoader("工具定义", () => import("./ToolDefinitionsPanel").then((mod) => mod.ToolDefinitionsPanel));
export const ToolDefinitionsPanel = guardedPanel("工具定义", toolDefinitionsLoader, TopPanelSkeleton, { render: topPanelFailure });

const agentSessionLoader = createPanelLoader("子代理", () => import("./AgentSessionPanel").then((mod) => mod.AgentSessionPanel));
export const AgentSessionPanel = guardedPanel("子代理", agentSessionLoader, TopPanelSkeleton, { render: topPanelFailure });

/** 设置入口悬停/聚焦时预取设置面板 chunk，点击时基本已就绪。失败已由加载器记录，这里只吞掉未处理的拒绝。 */
export function preloadSettingsPanel() {
  void settingsLoader.load().catch(() => {});
}

/** 当前项目需要信任确认时预取对话框 chunk，弹出时不等下载。 */
export function preloadProjectTrustDialog() {
  void trustLoader.load().catch(() => {});
}
