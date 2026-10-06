"use client";

// 根错误页（Next 的 global-error）：根布局自己渲染出错，或没有更近的 ErrorBoundary 接住的渲染错误，到这里为止——
// 此前整页白屏。标签页常驻多日，发版换了 .next 之后旧页面去拉旧 chunk 会 ChunkLoadError：这类错误自动 location.reload()
// 一次（sessionStorage 里记时间戳防循环，一分钟内刷新过就不再自动刷新，改显示「刷新页面」按钮）；其他错误显示可恢复提示。
// 它替换根布局，所以自带 <html>/<body>，样式只用 CSS 变量（有就跟主题）+ 系统色兜底，不依赖 layout 里引入的样式表。
import { useEffect, useState, type CSSProperties } from "react";
import { claimChunkReload, isChunkLoadError } from "@/components/ErrorBoundary";

const BODY_STYLE: CSSProperties = {
  margin: 0,
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "var(--bg, Canvas)",
  color: "var(--text, CanvasText)",
  font: "13px/1.6 var(--font-sans, system-ui, sans-serif)",
  colorScheme: "light dark",
};
const CARD_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 440,
  padding: "16px 18px",
  border: "1px solid var(--border-strong, GrayText)",
  borderRadius: 8,
  background: "var(--bg-elevated, Canvas)",
};
const TITLE_STYLE: CSSProperties = { margin: "0 0 6px", fontSize: 14, fontWeight: 600 };
const TEXT_STYLE: CSSProperties = { margin: 0, color: "var(--text-secondary, GrayText)", overflowWrap: "anywhere" };
const ACTIONS_STYLE: CSSProperties = { display: "flex", gap: 8, marginTop: 14 };
const BUTTON_STYLE: CSSProperties = {
  minHeight: 28,
  padding: "0 12px",
  border: "1px solid var(--border-strong, GrayText)",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};
const PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  borderColor: "var(--accent, LinkText)",
  background: "var(--accent, LinkText)",
  color: "var(--accent-contrast, Canvas)",
  fontWeight: 500,
};

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    console.error(`[pi-web] 页面渲染失败（global-error${chunk ? "，chunk 加载失败" : ""}）:`, error);
    if (!chunk) return;
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* 禁用存储：没有防循环的依据，不自动刷新 */ }
    if (claimChunkReload(storage, Date.now())) {
      console.warn("[pi-web] chunk 加载失败（多半是发版后的旧标签页），自动刷新页面一次");
      setReloading(true);
      window.location.reload();
    } else {
      console.error("[pi-web] chunk 加载失败，且一分钟内已自动刷新过（或无法记录），不再自动刷新，请手动点「刷新页面」");
    }
  }, [chunk, error]);

  return (
    <html lang="zh-CN">
      <body style={BODY_STYLE}>
        <main role="alert" style={CARD_STYLE}>
          <h1 style={TITLE_STYLE}>{chunk ? "页面资源已更新" : "页面出错了"}</h1>
          <p style={TEXT_STYLE}>
            {reloading
              ? "正在刷新页面…"
              : chunk
                ? "页面资源加载失败（可能已发布新版本或网络中断），刷新页面即可恢复。"
                : error.message || "未知错误"}
          </p>
          <div style={ACTIONS_STYLE}>
            <button type="button" style={chunk ? BUTTON_STYLE : PRIMARY_BUTTON_STYLE} onClick={() => reset()}>重试</button>
            <button type="button" style={chunk ? PRIMARY_BUTTON_STYLE : BUTTON_STYLE} onClick={() => window.location.reload()}>刷新页面</button>
          </div>
        </main>
      </body>
    </html>
  );
}
